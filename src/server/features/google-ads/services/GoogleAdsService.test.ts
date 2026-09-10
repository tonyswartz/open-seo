import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAdsApiError } from "@/server/lib/googleAdsErrors";
import { GoogleAdsService } from "./GoogleAdsService";

const mocks = vi.hoisted(() => {
  const state: {
    grants: Array<{ id: string; accountId: string; scope: string | null }>;
  } = { grants: [] };
  const listAccessibleCustomers = vi.fn();
  const search = vi.fn();
  const getUserInfoEmail = vi.fn();
  return {
    state,
    listAccessibleCustomers,
    search,
    getUserInfoEmail,
    createGoogleAdsClient: vi.fn(() => ({
      listAccessibleCustomers,
      search,
      getUserInfoEmail,
    })),
    dbSelect: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(state.grants)),
      })),
    })),
  };
});

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: { select: mocks.dbSelect } }));
vi.mock("@/server/lib/googleAdsClient", () => ({
  createGoogleAdsClient: mocks.createGoogleAdsClient,
}));

describe("GoogleAdsService.listAccountsForUserWithGrantStatus", () => {
  beforeEach(() => {
    mocks.state.grants = [
      { id: "grant_1", accountId: "google-sub-1", scope: "openid,adwords" },
    ];
    mocks.getUserInfoEmail.mockResolvedValue("tony@example.com");
    mocks.listAccessibleCustomers.mockResolvedValue([]);
    mocks.search.mockResolvedValue([]);
  });

  it("reports a grant with no accessible customers without error flags", async () => {
    const result =
      await GoogleAdsService.listAccountsForUserWithGrantStatus("user_1");
    expect(result.accounts).toEqual([
      {
        accountId: "google-sub-1",
        email: "tony@example.com",
        requiresReconnect: false,
        accessPending: false,
        accountsUnavailable: false,
        accounts: [],
      },
    ]);
  });

  it("classifies a developer-token failure on per-customer probes as access pending", async () => {
    mocks.listAccessibleCustomers.mockResolvedValue(["1111111111"]);
    mocks.search.mockRejectedValue(
      new GoogleAdsApiError(
        403,
        "not approved",
        "DEVELOPER_TOKEN_NOT_APPROVED",
      ),
    );
    const result =
      await GoogleAdsService.listAccountsForUserWithGrantStatus("user_1");
    expect(result.accounts[0]).toMatchObject({
      accessPending: true,
      accountsUnavailable: false,
      accounts: [],
    });
  });

  it("classifies an unapproved-for-production Cloud project as access pending", async () => {
    mocks.listAccessibleCustomers.mockResolvedValue(["1111111111"]);
    mocks.search.mockRejectedValue(
      new GoogleAdsApiError(
        403,
        "Google Ads API access not approved for production accounts",
        "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      ),
    );
    const result =
      await GoogleAdsService.listAccountsForUserWithGrantStatus("user_1");
    expect(result.accounts[0]).toMatchObject({
      accessPending: true,
      accountsUnavailable: false,
      accounts: [],
    });
  });

  it("surfaces accounts-unavailable when every accessible customer fails its probe", async () => {
    mocks.listAccessibleCustomers.mockResolvedValue([
      "1111111111",
      "2222222222",
    ]);
    mocks.search.mockRejectedValue(
      new GoogleAdsApiError(403, "denied", "USER_PERMISSION_DENIED"),
    );
    const result =
      await GoogleAdsService.listAccountsForUserWithGrantStatus("user_1");
    expect(result.accounts[0]).toMatchObject({
      accessPending: false,
      accountsUnavailable: true,
      accounts: [],
    });
  });

  it("keeps enabled non-manager clients from any depth under a manager", async () => {
    mocks.listAccessibleCustomers.mockResolvedValue(["9999999999"]);
    let clientQuery = "";
    let clientLogin: string | null | undefined;
    mocks.search.mockImplementation(
      (
        customerId: string,
        query: string,
        options?: { loginCustomerId?: string | null },
      ) => {
        if (query.includes("FROM customer_client")) {
          clientQuery = query;
          clientLogin = options?.loginCustomerId;
          return Promise.resolve([
            {
              customerClient: {
                clientCustomer: "customers/1234567890",
                descriptiveName: "LSA Account",
                currencyCode: "USD",
              },
            },
            {
              customerClient: {
                clientCustomer: "customers/8888888888",
                manager: true,
              },
            },
          ]);
        }
        if (query.includes("FROM customer")) {
          return Promise.resolve([
            { customer: { id: customerId, manager: true } },
          ]);
        }
        // Local Services campaign probe.
        return Promise.resolve([{ campaign: { id: "42" } }]);
      },
    );
    const result =
      await GoogleAdsService.listAccountsForUserWithGrantStatus("user_1");
    expect(clientQuery).toContain("customer_client.level >= 1");
    expect(clientLogin).toBe("9999999999");
    expect(result.accounts[0].accounts).toEqual([
      {
        customerId: "1234567890",
        loginCustomerId: "9999999999",
        descriptiveName: "LSA Account",
        currencyCode: "USD",
        hasLocalServicesCampaigns: true,
      },
    ]);
  });
});
