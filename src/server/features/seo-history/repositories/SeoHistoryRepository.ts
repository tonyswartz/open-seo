import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { seoHistorySnapshots } from "@/db/schema";

type SeoHistoryInsert = typeof seoHistorySnapshots.$inferInsert;
export type SeoHistorySnapshot = typeof seoHistorySnapshots.$inferSelect;

async function insert(
  values: SeoHistoryInsert,
): Promise<{ row: SeoHistorySnapshot; inserted: boolean }> {
  const [row] = await db
    .insert(seoHistorySnapshots)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (row) return { row, inserted: true };

  // Partial unique index only applies when period_start is set. A conflict
  // means this project+kind+period already exists — return that row.
  if (values.periodStart) {
    const existing = await db
      .select()
      .from(seoHistorySnapshots)
      .where(
        and(
          eq(seoHistorySnapshots.projectId, values.projectId),
          eq(seoHistorySnapshots.kind, values.kind),
          eq(seoHistorySnapshots.periodStart, values.periodStart),
        ),
      )
      .limit(1);
    if (existing[0]) return { row: existing[0], inserted: false };
  }

  throw new Error("Failed to insert seo_history_snapshot");
}

async function listForProject(opts: {
  projectId: string;
  kind?: SeoHistorySnapshot["kind"];
  capturedSince?: string;
  limit: number;
}): Promise<SeoHistorySnapshot[]> {
  const conditions = [eq(seoHistorySnapshots.projectId, opts.projectId)];
  if (opts.kind) conditions.push(eq(seoHistorySnapshots.kind, opts.kind));
  if (opts.capturedSince) {
    conditions.push(gte(seoHistorySnapshots.capturedAt, opts.capturedSince));
  }

  return db
    .select()
    .from(seoHistorySnapshots)
    .where(and(...conditions))
    .orderBy(desc(seoHistorySnapshots.id))
    .limit(opts.limit);
}

export const SeoHistoryRepository = {
  insert,
  listForProject,
};
