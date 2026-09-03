import { eq, inArray } from "drizzle-orm";
import { runBatch } from "@/db/runBatch";
import {
  rankCheckRuns,
  rankSnapshots,
  rankTrackingConfigs,
  rankTrackingKeywords,
} from "@/db/schema";

// Children are removed explicitly (snapshots → runs → keywords → config)
// rather than leaning on the schema's ON DELETE cascade: SQLite only honors
// cascades when the connection enforces foreign keys, which self-host
// backends don't all guarantee. runBatch keeps the four statements one
// atomic, ordered write on both dialects.
export async function deleteConfigCascade(configId: string) {
  await runBatch((tx) => [
    tx
      .delete(rankSnapshots)
      .where(
        inArray(
          rankSnapshots.runId,
          tx
            .select({ id: rankCheckRuns.id })
            .from(rankCheckRuns)
            .where(eq(rankCheckRuns.configId, configId)),
        ),
      ),
    tx.delete(rankCheckRuns).where(eq(rankCheckRuns.configId, configId)),
    tx
      .delete(rankTrackingKeywords)
      .where(eq(rankTrackingKeywords.configId, configId)),
    tx.delete(rankTrackingConfigs).where(eq(rankTrackingConfigs.id, configId)),
  ]);
}
