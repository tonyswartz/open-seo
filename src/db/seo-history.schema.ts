import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// Append-only weekly/monthly snapshots of live SEO signals that are not already
// stored as rank_snapshots (map-pack, reviews, GSC, AI visibility, LSA audits).
// `payload` is a per-kind JSON body of a third-party API snapshot, validated at
// the write boundary — same pattern as rank_snapshots.serp_features. Rows are
// inserted, never updated. Re-recording the same project+kind+period is a
// no-op via the partial unique index.
export const seoHistorySnapshots = sqliteTable(
  "seo_history_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(current_timestamp)`),
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
