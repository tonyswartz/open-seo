import { sql } from "drizzle-orm";
import { index, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name);

// Append-only weekly/monthly snapshots of live SEO signals that are not already
// stored as rank_snapshots (map-pack, reviews, GSC, AI visibility, LSA audits).
// `payload` is a per-kind JSON body of a third-party API snapshot, validated at
// the write boundary — same pattern as rank_snapshots.serp_features. Rows are
// inserted, never updated. Re-recording the same project+kind+period is a
// no-op via the partial unique index.
export const seoHistorySnapshots = pgTable(
  "seo_history_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "map_pack",
        "reviews",
        "gsc_totals",
        "gsc_queries",
        "ai_visibility",
        "lsa_audit",
        "weekly_digest",
      ],
    }).notNull(),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    source: text("source").notNull().default("mcp"),
    payload: text("payload").notNull(),
    capturedAt: timestampColumn("captured_at").notNull().default(isoNow),
  },
  (table) => [
    index("seo_history_snapshots_project_kind_captured_idx").on(
      table.projectId,
      table.kind,
      table.capturedAt,
    ),
    uniqueIndex("seo_history_snapshots_project_kind_period_idx")
      .on(table.projectId, table.kind, table.periodStart)
      .where(sql`${table.periodStart} IS NOT NULL`),
  ],
);
