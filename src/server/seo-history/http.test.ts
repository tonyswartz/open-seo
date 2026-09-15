import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { OPENSEO_HISTORY_READ_KEY: "read-only-key" as string | undefined },
  getPositionMatrix: vi.fn(),
  list: vi.fn(),
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
});
