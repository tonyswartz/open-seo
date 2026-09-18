import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { OPENSEO_HISTORY_READ_KEY: "read-only-key" as string | undefined },
  getPositionMatrix: vi.fn(),
  list: vi.fn(),
  listLeads: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mocks.env,
}));
vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    getPositionMatrix: mocks.getPositionMatrix,
  },
}));
vi.mock("@/server/features/seo-history/services/SeoHistoryService", () => ({
  SeoHistoryService: {
    list: mocks.list,
  },
}));
vi.mock("@/server/features/google-ads/services/LocalServicesReportingService", () => ({
  LocalServicesReportingService: {
    listLeads: mocks.listLeads,
  },
}));

import { handleSeoHistoryRequest } from "./http";

const projectId = "11111111-1111-4111-8111-111111111111";
const trackerId = "22222222-2222-4222-8222-222222222222";

function request(path: string, headers?: HeadersInit) {
  return new Request(`https://open-seo.test${path}`, { headers });
}

describe("GET /api/seo-history", () => {
  beforeEach(() => {
    mocks.env.OPENSEO_HISTORY_READ_KEY = "read-only-key";
    mocks.getPositionMatrix.mockResolvedValue({ rows: [] });
    mocks.list.mockResolvedValue([]);
    mocks.listLeads.mockResolvedValue({
      leads: [],
      currencyCode: "USD",
      dateRange: { startDate: "2026-08-22", endDate: "2026-09-18" },
    });
  });

  it("returns 404 when the read key is unset", async () => {
    mocks.env.OPENSEO_HISTORY_READ_KEY = undefined;
    const response = await handleSeoHistoryRequest(
      request("/api/seo-history?projectId=p"),
    );
    expect(response.status).toBe(404);
  });

  it("returns 401 without a matching bearer", async () => {
    const response = await handleSeoHistoryRequest(
      request(`/api/seo-history?projectId=${projectId}`),
    );
    expect(response.status).toBe(401);
  });

  it("returns snapshots for a valid read key", async () => {
    mocks.list.mockResolvedValue([{ id: 1, kind: "reviews" }]);
    const response = await handleSeoHistoryRequest(
      request(`/api/seo-history/snapshots?projectId=${projectId}`, {
        Authorization: "Bearer read-only-key",
      }),
    );
    expect(response.status).toBe(200);
    const body: { snapshots: Array<{ kind: string }> } = await response.json();
    expect(body.snapshots[0]?.kind).toBe("reviews");
    expect(mocks.getPositionMatrix).not.toHaveBeenCalled();
  });

  it("returns ranks when trackerId is supplied", async () => {
    mocks.getPositionMatrix.mockResolvedValue({
      device: "mobile",
      rows: [{ keyword: "ellensburg dui", position: 3 }],
    });
    const response = await handleSeoHistoryRequest(
      request(
        `/api/seo-history/ranks?projectId=${projectId}&trackerId=${trackerId}`,
        { Authorization: "Bearer read-only-key" },
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.getPositionMatrix).toHaveBeenCalledWith(
      trackerId,
      projectId,
      "mobile",
      12,
    );
  });

  it("returns local services leads for a valid read key", async () => {
    mocks.listLeads.mockResolvedValue({
      leads: [
        {
          id: "340700080",
          leadType: "PHONE_CALL",
          leadStatus: "NEW",
          categoryId: "xcat:service_area_business_lawyer",
          serviceId: "dui_lawyer",
          creationDateTime: "2026-09-06 10:00:00",
          charged: true,
          consumerName: null,
          consumerPhoneNumber: "+15417204150",
          consumerEmail: null,
          creditState: null,
          leadFeedbackSubmitted: null,
          conversationDurationMillis: null,
        },
      ],
      currencyCode: "USD",
      dateRange: { startDate: "2026-08-22", endDate: "2026-09-18" },
    });

    const response = await handleSeoHistoryRequest(
      request(
        `/api/seo-history/local-services-leads?projectId=${projectId}&startDate=2026-08-22&endDate=2026-09-18&limit=10`,
        { Authorization: "Bearer read-only-key" },
      ),
    );

    expect(response.status).toBe(200);
    const body: {
      leads: Array<{ id: string; consumerPhoneNumber: string | null }>;
      startDate: string;
      endDate: string;
    } = await response.json();
    expect(body.leads[0]?.id).toBe("340700080");
    expect(body.leads[0]?.consumerPhoneNumber).toBe("+15417204150");
    expect(body.startDate).toBe("2026-08-22");
    expect(body.endDate).toBe("2026-09-18");
    expect(mocks.listLeads).toHaveBeenCalledWith({
      projectId,
      startDate: "2026-08-22",
      endDate: "2026-09-18",
      limit: 10,
    });
    expect(mocks.getPositionMatrix).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("requires both startDate and endDate for local services leads", async () => {
    const response = await handleSeoHistoryRequest(
      request(
        `/api/seo-history/local-services-leads?projectId=${projectId}&startDate=2026-08-22`,
        { Authorization: "Bearer read-only-key" },
      ),
    );
    expect(response.status).toBe(400);
    const body: { error: string } = await response.json();
    expect(body.error).toContain("both startDate and endDate");
    expect(mocks.listLeads).not.toHaveBeenCalled();
  });
});
