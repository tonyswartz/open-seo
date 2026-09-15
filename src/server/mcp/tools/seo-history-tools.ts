import { z } from "zod";
import { SeoHistoryService } from "@/server/features/seo-history/services/SeoHistoryService";
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
import { seoHistoryKindSchema } from "@/types/schemas/seo-history";

const HISTORY_COLUMNS: McpTableColumn<unknown>[] = [
  { header: "id", value: (row) => readPath(row, "id") },
  { header: "kind", value: (row) => readPath(row, "kind") },
  { header: "periodStart", value: (row) => readPath(row, "periodStart") },
  { header: "capturedAt", value: (row) => readPath(row, "capturedAt") },
  { header: "source", value: (row) => readPath(row, "source") },
];

const recordInputSchema = {
  projectId: projectIdSchema,
  kind: seoHistoryKindSchema.describe(
    "Snapshot type: map_pack, reviews, gsc_totals, gsc_queries, ai_visibility, lsa_audit, or weekly_digest.",
  ),
  periodStart: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Period this snapshot covers (ISO date). Same project+kind+period is idempotent — a repeat write is a no-op.",
    ),
  periodEnd: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe("Optional period end (ISO date)."),
  source: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe("Who wrote this row. Defaults to mcp."),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      "Kind-specific snapshot body. map_pack: {query, results:[{name, rank, rating, reviews}]}. reviews: {businesses:[{name, rating, reviewCount}]}. gsc_totals: {clicks, impressions, ctr, position}. gsc_queries: {queries:[{query, clicks, impressions}]}. ai_visibility: {platform, prompts:[{prompt, mentioned, cited}]}. lsa_audit: {spend, leads, credits, findings}. weekly_digest: {summary}.",
    ),
} as const;

const getInputSchema = {
  projectId: projectIdSchema,
  kind: seoHistoryKindSchema
    .optional()
    .describe("Filter to one snapshot kind."),
  sinceDays: z
    .number()
    .int()
    .positive()
    .max(730)
    .optional()
    .describe("Only rows captured in the last N days. Max 730."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("Max rows to return. Defaults to 50."),
} as const;

type RecordArgs = z.infer<z.ZodObject<typeof recordInputSchema>>;
type GetArgs = z.infer<z.ZodObject<typeof getInputSchema>>;

export const recordSeoHistoryTool = {
  name: "record_seo_history",
  config: {
    title: "Record SEO history snapshot",
    description:
      "Append a weekly/monthly SEO snapshot (map-pack, reviews, Search Console, AI visibility, LSA audit, or a digest). Uses no credits. Rows are never updated or deleted. Re-recording the same project+kind+periodStart is a no-op. Do not put rank-tracker positions here — those already live in get_rank_tracker_history.",
    inputSchema: recordInputSchema,
    outputSchema: z
      .object({
        inserted: z.boolean(),
        snapshot: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: RecordArgs, context) => {
    const { snapshot, inserted } = await SeoHistoryService.record(args);
    const text = inserted
      ? `Recorded ${snapshot.kind} snapshot ${snapshot.id} for project ${args.projectId}${snapshot.periodStart ? ` (period ${snapshot.periodStart})` : ""}.`
      : `Snapshot for ${snapshot.kind}${snapshot.periodStart ? ` period ${snapshot.periodStart}` : ""} already exists (id ${snapshot.id}); left unchanged.`;
    return mcpResponse({
      text,
      meta: buildProjectMeta(context, args.projectId),
      structuredContent: { inserted, snapshot },
    });
  }),
};

export const getSeoHistoryTool = {
  name: "get_seo_history",
  config: {
    title: "Get SEO history snapshots",
    description:
      "Read-only stored SEO snapshots (map-pack, reviews, Search Console, AI visibility, LSA audits, weekly digests). Uses no credits. Rank positions are in get_rank_tracker_history, not this tool.",
    inputSchema: getInputSchema,
    outputSchema: z
      .object({
        snapshots: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: GetArgs, context) => {
    const snapshots = await SeoHistoryService.list(args);
    const text =
      snapshots.length === 0
        ? "No SEO history snapshots in this window."
        : `SEO history snapshots (${snapshots.length}):\n` +
          formatMcpTable(snapshots, HISTORY_COLUMNS);
    return mcpResponse({
      text,
      meta: buildProjectMeta(context, args.projectId),
      structuredContent: { snapshots },
    });
  }),
};
