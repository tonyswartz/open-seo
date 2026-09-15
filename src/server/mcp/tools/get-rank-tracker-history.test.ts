import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRankTrackerHistoryTool } from "./get-rank-tracker-history";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getKeywordHistory: vi.fn(),
  getConfigTrend: vi.fn(),
  getPositionMatrix: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/rank-tracking/services/RankTrackingService", () => ({
  RankTrackingService: {
    getKeywordHistory: mocks.getKeywordHistory,
    getConfigTrend: mocks.getConfigTrend,
    getPositionMatrix: mocks.getPositionMatrix,
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const trackerId = "22222222-2222-4222-8222-222222222222";
const keywordId = "33333333-3333-4333-8333-333333333333";
const toolContext = makeToolContext();
const config = { id: trackerId, domain: "tonyswartzlaw.com" };

describe("get_rank_tracker_history", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "tonyswartzlaw.com",
    });
  });

  it("renders a position matrix by default", async () => {
    mocks.getPositionMatrix.mockResolvedValue({
      config,
      device: "mobile",
      rows: [
        {
          checkedAt: "2026-09-12",
          keyword: "ellensburg dui lawyer",
          position: 3,
        },
      ],
    });

    const result = await getRankTrackerHistoryTool.handler(
      { projectId, trackerId },
      toolContext,
    );

    expect(mocks.getPositionMatrix).toHaveBeenCalledWith(
      trackerId,
      projectId,
      "mobile",
      12,
    );
    expect(textContent(result)).toContain("ellensburg dui lawyer | 3");
  });

  it("requires trackingKeywordId for the keyword view", async () => {
    const result = await getRankTrackerHistoryTool.handler(
      { projectId, trackerId, view: "keyword" },
      toolContext,
    );

    expect(mocks.getKeywordHistory).not.toHaveBeenCalled();
    expect(textContent(result)).toContain("requires trackingKeywordId");
  });

  it("renders a keyword series", async () => {
    mocks.getKeywordHistory.mockResolvedValue({
      config,
      rows: [
        { checkedAt: "2026-09-05", device: "mobile", position: 8 },
        { checkedAt: "2026-09-12", device: "mobile", position: 3 },
      ],
    });

    const result = await getRankTrackerHistoryTool.handler(
      {
        projectId,
        trackerId,
        view: "keyword",
        trackingKeywordId: keywordId,
        sinceDays: 30,
      },
      toolContext,
    );

    expect(mocks.getKeywordHistory).toHaveBeenCalledWith(
      trackerId,
      projectId,
      keywordId,
      30,
    );
    expect(textContent(result)).toContain("2026-09-12 | mobile | 3");
  });
});
