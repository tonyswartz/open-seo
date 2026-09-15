import { z } from "zod";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import {
  formatMcpTable,
  readPath,
  type McpTableColumn,
} from "@/server/mcp/table";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  trackerId: z
    .string()
    .uuid()
    .describe("Rank tracker config ID from get_rank_tracker."),
  view: z
    .enum(["matrix", "keyword", "trend"])
    .optional()
    .describe(
      "matrix: per-keyword positions across recent completed runs. keyword: one keyword's position series. trend: top-3 / top-10 / top-20 counts per run. Defaults to matrix.",
    ),
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe("Device for matrix and trend views. Defaults to mobile."),
  sinceDays: z
    .number()
    .int()
    .positive()
    .max(730)
    .optional()
    .describe(
      "Lookback window in days for keyword and trend views. Defaults to 365. Max 730.",
    ),
  trackingKeywordId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Required for view=keyword. trackingKeywordId from get_rank_tracker.",
    ),
  runLimit: z
    .number()
    .int()
    .positive()
    .max(26)
    .optional()
    .describe(
      "Completed runs to include in the matrix view. Defaults to 12. Max 26.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const MATRIX_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "checkedAt", value: (row) => readPath(row, "checkedAt") },
  { header: "keyword", value: (row) => readPath(row, "keyword") },
  { header: "position", value: (row) => readPath(row, "position") },
];

const KEYWORD_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "checkedAt", value: (row) => readPath(row, "checkedAt") },
  { header: "device", value: (row) => readPath(row, "device") },
  { header: "position", value: (row) => readPath(row, "position") },
];

const TREND_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "checkedAt", value: (row) => readPath(row, "checkedAt") },
  { header: "total", value: (row) => readPath(row, "total") },
  { header: "top3", value: (row) => readPath(row, "top3") },
  { header: "top4to10", value: (row) => readPath(row, "top4to10") },
  { header: "top11to20", value: (row) => readPath(row, "top11to20") },
];

export const getRankTrackerHistoryTool = {
  name: "get_rank_tracker_history",
  config: {
    title: "Get rank tracker history",
    description:
      "Read-only historical rank positions from stored weekly checks. Uses no credits. get_rank_tracker only returns the latest run vs ~last week; this tool reads the full stored series (up to 730 days). Use view=matrix for a keyword × date grid, view=keyword with trackingKeywordId for one keyword, or view=trend for top-3/10/20 counts.",
    inputSchema,
    outputSchema: z
      .object({
        view: z.enum(["matrix", "keyword", "trend"]),
        device: z.enum(["desktop", "mobile"]).optional(),
        config: looseObjectOutputSchema.optional(),
        rows: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const view = args.view ?? "matrix";
    const device = args.device ?? "mobile";
    const sinceDays = args.sinceDays ?? 365;
    const runLimit = args.runLimit ?? 12;

    if (view === "keyword") {
      if (!args.trackingKeywordId) {
        return mcpResponse({
          text: "view=keyword requires trackingKeywordId (from get_rank_tracker).",
          meta: buildProjectMeta(
            context,
            args.projectId,
            `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
          ),
          structuredContent: { view: "keyword" as const, rows: [] },
        });
      }
      const { config, rows } = await RankTrackingService.getKeywordHistory(
        args.trackerId,
        args.projectId,
        args.trackingKeywordId,
        sinceDays,
      );
      const text = [
        `Rank history for tracker ${config.id} (${config.domain}), keyword ${args.trackingKeywordId}, last ${sinceDays} days (${rows.length} checks):`,
        rows.length === 0
          ? "No completed checks in this window."
          : formatMcpTable(rows, KEYWORD_COLUMNS),
      ].join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
        ),
        structuredContent: { view: "keyword" as const, config, rows },
      });
    }

    if (view === "trend") {
      const { config, rows } = await RankTrackingService.getConfigTrend(
        args.trackerId,
        args.projectId,
        device,
        sinceDays,
      );
      const text = [
        `Rank trend for tracker ${config.id} (${config.domain}), ${device}, last ${sinceDays} days (${rows.length} runs):`,
        rows.length === 0
          ? "No completed checks in this window."
          : formatMcpTable(rows, TREND_COLUMNS),
      ].join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
        ),
        structuredContent: { view: "trend" as const, device, config, rows },
      });
    }

    const { config, rows } = await RankTrackingService.getPositionMatrix(
      args.trackerId,
      args.projectId,
      device,
      runLimit,
    );
    const text = [
      `Rank matrix for tracker ${config.id} (${config.domain}), ${device}, last ${runLimit} runs (${rows.length} rows):`,
      rows.length === 0
        ? "No completed checks yet."
        : formatMcpTable(rows, MATRIX_COLUMNS),
    ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
      ),
      structuredContent: { view: "matrix" as const, device, config, rows },
    });
  }),
};
