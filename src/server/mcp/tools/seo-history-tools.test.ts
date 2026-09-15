import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSeoHistoryTool, recordSeoHistoryTool } from "./seo-history-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  record: vi.fn(),
  list: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/seo-history/services/SeoHistoryService", () => ({
  SeoHistoryService: {
    record: mocks.record,
    list: mocks.list,
  },
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const toolContext = makeToolContext();

describe("seo history MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "tonyswartzlaw.com",
    });
  });

  it("record_seo_history reports a new snapshot", async () => {
    mocks.record.mockResolvedValue({
      inserted: true,
      snapshot: {
        id: 4,
        kind: "gsc_totals",
        periodStart: "2026-09-08",
        payload: { clicks: 10, impressions: 100 },
      },
    });

    const result = await recordSeoHistoryTool.handler(
      {
        projectId,
        kind: "gsc_totals",
        periodStart: "2026-09-08",
        payload: { clicks: 10, impressions: 100 },
      },
      toolContext,
    );

    expect(textContent(result)).toContain("Recorded gsc_totals snapshot 4");
    expect(result.structuredContent).toMatchObject({ inserted: true });
  });

  it("record_seo_history reports an idempotent no-op", async () => {
    mocks.record.mockResolvedValue({
      inserted: false,
      snapshot: {
        id: 4,
        kind: "gsc_totals",
        periodStart: "2026-09-08",
      },
    });

    const result = await recordSeoHistoryTool.handler(
      {
        projectId,
        kind: "gsc_totals",
        periodStart: "2026-09-08",
        payload: { clicks: 10, impressions: 100 },
      },
      toolContext,
    );

    expect(textContent(result)).toContain("already exists");
    expect(result.structuredContent).toMatchObject({ inserted: false });
  });

  it("get_seo_history renders snapshot rows", async () => {
    mocks.list.mockResolvedValue([
      {
        id: 4,
        kind: "map_pack",
        periodStart: "2026-09-08",
        capturedAt: "2026-09-12 12:00:00",
        source: "mcp",
      },
    ]);

    const result = await getSeoHistoryTool.handler({ projectId }, toolContext);

    expect(textContent(result)).toContain("map_pack");
    expect(textContent(result)).toContain("2026-09-08");
    expect(result.structuredContent).toMatchObject({
      snapshots: [{ id: 4, kind: "map_pack" }],
    });
  });
});
