import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAdsApiError } from "@/server/lib/googleAdsErrors";
import { LocalServicesReportingService } from "./LocalServicesReportingService";
import type { GoogleAdsConnection } from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";

const mocks = vi.hoisted(() => ({
  getByProjectId: vi.fn(),
  search: vi.fn(),
}));

vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository",
  () => ({
    GoogleAdsConnectionRepository: { getByProjectId: mocks.getByProjectId },
  }),
);
vi.mock("@/server/lib/googleAdsClient", () => ({
  createGoogleAdsClient: () => ({ search: mocks.search }),
}));

function makeConnection(
  overrides: Partial<GoogleAdsConnection> = {},
): GoogleAdsConnection {
  return {
    id: "google_ads_connection_1",
    projectId: "project_1",
    organizationId: "org_123",
    customerId: "1234567890",
    loginCustomerId: "2930000000",
    customerDescriptiveName: "Law Firm",
    currencyCode: "USD",
    connectedByUserId: "user_1",
    googleAdsAccountId: "account_1",
    connectedAccountEmail: "alice@example.com",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

const range = {
  projectId: "project_1",
  startDate: "2026-09-01",
  endDate: "2026-09-07",
};

describe("LocalServicesReportingService", () => {
  beforeEach(() => {
    mocks.getByProjectId.mockResolvedValue(makeConnection());
  });

  it("maps a missing connection to google_ads_not_connected", async () => {
    mocks.getByProjectId.mockResolvedValue(null);
    await expect(
      LocalServicesReportingService.getPerformance(range),
    ).rejects.toMatchObject({ code: "google_ads_not_connected" });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("rejects a malformed date before any API call", async () => {
    await expect(
      LocalServicesReportingService.getPerformance({
        ...range,
        endDate: "07/09/2026",
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("aggregates spend, lead totals, CPL, and weekly pacing from GAQL rows", async () => {
    mocks.search.mockImplementation((_customerId: string, query: string) => {
      if (query.includes("FROM local_services_lead")) {
        return Promise.resolve([
          {
            localServicesLead: {
              id: "1",
              leadType: "PHONE_CALL",
              leadStatus: "BOOKED",
              creationDateTime: "2026-09-06 10:00:00",
              leadCharged: true,
              contactDetails: { phoneNumber: "+15095551234" },
            },
          },
          {
            localServicesLead: {
              id: "2",
              leadType: "PHONE_CALL",
              leadStatus: "NEW",
              creationDateTime: "2026-09-05 09:00:00",
              leadCharged: true,
            },
          },
          {
            // ProtoJSON omits false booleans entirely.
            localServicesLead: {
              id: "3",
              leadType: "MESSAGE",
              leadStatus: "EXPIRED",
              creationDateTime: "2026-09-02 08:00:00",
            },
          },
        ]);
      }
      if (query.includes("metrics.cost_micros")) {
        return Promise.resolve(
          query.includes("BETWEEN '2026-09-01'")
            ? [{ campaign: { id: "42" }, metrics: { costMicros: "123000000" } }]
            : [
                {
                  campaign: { id: "42" },
                  metrics: { costMicros: "175000000" },
                },
              ],
        );
      }
      return Promise.resolve([
        {
          campaign: { id: "42", name: "LSA", status: "ENABLED" },
          campaignBudget: { amountMicros: "50000000", period: "DAILY" },
        },
      ]);
    });

    const performance =
      await LocalServicesReportingService.getPerformance(range);

    expect(performance.spendMicros).toBe(123_000_000);
    expect(performance.leadTotals).toEqual({
      total: 3,
      charged: 2,
      booked: 1,
      phoneCalls: 2,
      messages: 1,
      bookings: 0,
      truncated: false,
    });
    expect(performance.costPerChargedLeadMicros).toBe(61_500_000);
    expect(performance.pacing.weeklyBudgetMicros).toBe(350_000_000);
    expect(performance.pacing.last7DaysSpendMicros).toBe(175_000_000);
    expect(performance.pacing.utilization).toBe(0.5);
    // The manager account rides along on every query.
    expect(mocks.search).toHaveBeenCalledWith(
      "1234567890",
      expect.any(String),
      { loginCustomerId: "2930000000" },
    );
  });

  it("leaves the weekly target null for a non-daily budget period", async () => {
    mocks.search.mockImplementation((_customerId: string, query: string) => {
      if (query.includes("FROM local_services_lead"))
        return Promise.resolve([]);
      if (query.includes("metrics.cost_micros")) return Promise.resolve([]);
      return Promise.resolve([
        {
          campaign: { id: "42", name: "LSA", status: "ENABLED" },
          campaignBudget: {
            amountMicros: "1500000000",
            period: "CUSTOM_PERIOD",
          },
        },
      ]);
    });

    const performance =
      await LocalServicesReportingService.getPerformance(range);
    expect(performance.pacing.weeklyBudgetMicros).toBeNull();
    expect(performance.pacing.utilization).toBeNull();
  });

  it("flags lead totals that hit the reporting cap", async () => {
    mocks.search.mockImplementation((_customerId: string, query: string) => {
      if (!query.includes("FROM local_services_lead")) {
        return Promise.resolve([]);
      }
      // One more than the cap, which is exactly what the extra row detects.
      return Promise.resolve(
        Array.from({ length: 1_001 }, (_, i) => ({
          localServicesLead: { id: `${i}`, leadCharged: true },
        })),
      );
    });

    const performance =
      await LocalServicesReportingService.getPerformance(range);
    expect(performance.leadTotals).toMatchObject({
      total: 1_000,
      charged: 1_000,
      truncated: true,
    });
  });

  it("maps an unapproved developer token to google_ads_access_pending", async () => {
    mocks.search.mockRejectedValue(
      new GoogleAdsApiError(
        403,
        "Google has not approved Ads API access for this developer token yet.",
        "DEVELOPER_TOKEN_NOT_APPROVED",
      ),
    );
    await expect(
      LocalServicesReportingService.listLeads({ ...range, limit: 50 }),
    ).rejects.toMatchObject({ code: "google_ads_access_pending" });
  });
});
