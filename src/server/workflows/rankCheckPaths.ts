import type { WorkflowStep } from "cloudflare:workers";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  fetchRankCheckTaskHtml,
  fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST,
} from "@/server/lib/dataforseo";
import type {
  createDataforseoClient,
  PostedRankCheckTask,
  RankCheckResult,
  RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import { AppError } from "@/server/lib/errors";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { KEYWORDS_PER_BATCH } from "@/shared/rank-tracking";
import { pgStep } from "@/server/workflows/pgStep";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

// Fork: how long checkBatchLive waits before each further attempt at a live
// call DataForSEO failed on its own side. Two entries is two retries.
const LIVE_RETRY_BACKOFFS_MS = [5_000, 10_000];

// Fork: a live batch is still a single attempt at the step level (the calls
// are metered), but it can now run three rounds of them. Each round is capped
// by the client's 60s request timeout, so the worst case is 3 x 60s plus 15s
// of backoff. Past its timeout a step throws and the run skips every batch
// after it, so these steps get room SINGLE_ATTEMPT_STEP_CONFIG does not give.
const LIVE_BATCH_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "5 minutes" as const,
};

type KeywordEntry = { id: string; keyword: string };
type RankCheckResultWithDevice = RankCheckResult & {
  device: "desktop" | "mobile";
};

function mapResultsToSnapshotRows(
  runId: string,
  results: RankCheckResultWithDevice[],
) {
  return results.map((r) => ({
    runId,
    trackingKeywordId: r.keywordId,
    keyword: r.keyword,
    device: r.device,
    position: r.position,
    url: r.url,
    serpFeatures:
      r.serpFeatures.length > 0 ? JSON.stringify(r.serpFeatures) : null,
  }));
}

interface CheckContext {
  client: ReturnType<typeof createDataforseoClient>;
  keywords: KeywordEntry[];
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  runId: string;
  /**
   * Fork: check every queued result against its own page and withhold the
   * ones Google served without the requested location (see runQueuedCheck).
   */
  validateSerps?: boolean;
}

/** Expand keywords into one task input per keyword/device pair. */
function expandToTaskInputs(
  keywords: KeywordEntry[],
  devices: RankTrackingConfig["devices"],
): RankCheckTaskInput[] {
  const deviceList: Array<"desktop" | "mobile"> =
    devices === "both" ? ["desktop", "mobile"] : [devices];
  return keywords.flatMap((kw) =>
    deviceList.map((device) => ({
      keyword: kw.keyword,
      keywordId: kw.id,
      device,
    })),
  );
}

// ---------------------------------------------------------------------------
// Step bodies. Each runs inside a single step.do: inputs are its parameters,
// the return value is what the workflow engine persists and replays. They must
// not touch any mutable state outside their arguments.
// ---------------------------------------------------------------------------

/**
 * DataForSEO's search engine erroring on its own side (40101) often clears
 * within seconds, so the call is worth another try. A timeout is not: it
 * already spent the whole request budget, and it may have been billed without
 * our seeing the cost.
 */
function isRetryableProviderFailure(reason: unknown): boolean {
  return (
    reason instanceof AppError &&
    reason.code === "UPSTREAM_UNAVAILABLE" &&
    reason.name !== "DataForSEOTimeoutError"
  );
}

/**
 * Check keyword/device pairs against the live endpoint and persist snapshots.
 * Each round of calls is billed with one credit hold and one settle. A pair
 * DataForSEO fails on its own side goes into the next round (see
 * LIVE_RETRY_BACKOFFS_MS); DataForSEO bills those failures, so every attempt
 * is paid for. Other per-call failures are logged and skipped. If the hold
 * itself fails, no call runs and every pair in the round fails with that
 * error. Returns the snapshot count written.
 */
async function checkBatchLive(
  ctx: CheckContext,
  tasks: RankCheckTaskInput[],
): Promise<number> {
  let written = 0;
  let firstError: string | null = null;
  let pending = tasks;
  for (let attempt = 0; pending.length > 0; attempt++) {
    const round = pending;
    if (attempt > 0) {
      const backoffMs = LIVE_RETRY_BACKOFFS_MS[attempt - 1];
      console.warn(
        `[rank-check] ${ctx.runId} retrying ${round.length} live call(s) in ${backoffMs / 1000}s (retry ${attempt} of ${LIVE_RETRY_BACKOFFS_MS.length})`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    let settled: PromiseSettledResult<RankCheckResult>[];
    let callsRan = true;
    try {
      settled = await ctx.client.serp.rankCheckBatch(
        round.map((task) => ({
          keyword: task.keyword,
          keywordId: task.keywordId,
          locationCode: ctx.locationCode,
          languageCode: ctx.languageCode,
          locationName: ctx.locationName,
          device: task.device,
          targetDomain: ctx.domain,
          depth: ctx.serpDepth,
        })),
      );
    } catch (error) {
      callsRan = false;
      settled = round.map(() => ({ status: "rejected", reason: error }));
    }
    const canRetry = callsRan && attempt < LIVE_RETRY_BACKOFFS_MS.length;

    const results: RankCheckResultWithDevice[] = [];
    const retry: RankCheckTaskInput[] = [];
    settled.forEach((outcome, index) => {
      const task = round[index];
      if (outcome.status === "fulfilled") {
        results.push({ ...outcome.value, device: task.device });
        return;
      }
      const reason: unknown = outcome.reason;
      if (canRetry && isRetryableProviderFailure(reason)) {
        retry.push(task);
        return;
      }
      const code = reason instanceof AppError ? reason.code : "UNKNOWN";
      const message = reason instanceof Error ? reason.message : String(reason);
      firstError ??= message;
      // DataForSEO erring on its own side is a provider flake, not our bug: the
      // keyword just misses this run and finalize reports it to the user. Every
      // other rejection (no credits, bad API key) is ours and stays at error.
      const log =
        code === "UPSTREAM_UNAVAILABLE" ? console.warn : console.error;
      log(
        `[rank-check] ${ctx.runId} live call failed (${code}) keyword="${task.keyword}" device=${task.device}: ${message}`,
      );
    });
    // Written per round, so a later round can only add to what the run has.
    if (results.length > 0) {
      await RankTrackingRepository.insertSnapshots(
        mapResultsToSnapshotRows(ctx.runId, results),
      );
      written += results.length;
    }
    pending = retry;
  }
  if (firstError) {
    await RankTrackingRepository.setRunErrorIfEmpty(ctx.runId, firstError);
  }
  return written;
}

/**
 * Check keywords via Live API, parallel devices per keyword, real-time progress.
 * Snapshots are written incrementally after each batch so partial results
 * survive batch failures. ~6s per keyword batch, longer when calls are retried.
 * Each round of a batch's calls is billed with one credit hold and one settle
 * (checkBatchLive).
 */
export async function runLiveCheck(
  step: WorkflowStep,
  ctx: CheckContext,
): Promise<void> {
  for (let i = 0; i < ctx.keywords.length; i += KEYWORDS_PER_BATCH) {
    const keywordBatch = ctx.keywords.slice(i, i + KEYWORDS_PER_BATCH);
    const batchTasks = expandToTaskInputs(keywordBatch, ctx.devices);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);
    const keywordsChecked = i + keywordBatch.length;

    await pgStep(
      step,
      `live-batch-${batchIndex}`,
      LIVE_BATCH_STEP_CONFIG,
      async () => {
        const written = await checkBatchLive(ctx, batchTasks);
        // Progress for the UI; finalize recounts from the DB anyway.
        await RankTrackingRepository.updateRun(ctx.runId, {
          keywordsChecked,
        });
        return written;
      },
    );
  }
}

// Poll cadence for queued tasks. Standard-priority tasks complete in ~5
// minutes on average, so the first check waits 4 minutes; cumulative waits are
// 4 / 6 / 8 / 10 / 12 / 15 minutes, after which stragglers fall back to the
// live endpoint.
const QUEUED_POLL_INTERVALS = [
  "4 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "3 minutes",
] as const;

/** Concurrent task_get requests within a collect step. */
const TASK_GET_CONCURRENCY = 25;

/** Max task_get calls per collect round (bounds one round's fan-out). */
const TASK_GETS_PER_COLLECT = 500;

// Fork: Google's page carries this module when it did not apply the requested
// location to the organic ranking (the organic list is then the national one);
// a page with the location applied shows "Choose area" instead. English only.
const LOCATION_DROPPED_MARKER = /Use precise location/i;

/** Crawls a reading gets on a validated run before it is withheld. */
const MAX_VALIDATION_ATTEMPTS = 4;

// Reposts stop after this poll round so the new crawl can still be collected
// inside the window QUEUED_POLL_INTERVALS leaves (see runQueuedCheck).
const LAST_REPOST_ROUND = 3;

/** A queued task with the number of crawls spent on its keyword/device pair. */
type QueuedTask = PostedRankCheckTask & { attempt: number };

function withheldMessage(count: number): string {
  return `Withheld ${count} reading(s): Google dropped the tracker's location on every attempt; previous positions kept.`;
}

// Collect steps may issue hundreds of task_get calls, so they get more room
// than SINGLE_ATTEMPT_STEP_CONFIG's 2-minute timeout. Unlike the metered
// steps, retrying is safe and free: task_get isn't charged and snapshot
// inserts are onConflictDoNothing.
const COLLECT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

interface CollectRoundOutcome {
  /** Snapshots written this round. */
  collected: number;
  /** Tasks still in DataForSEO's queue — poll again next round. */
  stillPending: QueuedTask[];
  /** Tasks DataForSEO failed — route to the live fallback. */
  failed: QueuedTask[];
  /** Completed tasks whose page shows Google dropped the location. */
  dropped: QueuedTask[];
  /** Completed tasks whose page showed the location applied. */
  validated: number;
  /** Completed tasks written unchecked because their page could not be read. */
  htmlUnavailable: number;
}

/**
 * Fetch results for queued tasks (one free task_get each), persist completed
 * snapshots, and update run progress. Transient task_get failures stay
 * pending for the next round. On a validated run each completed result is
 * checked against its own page (one more free call): a page carrying Google's
 * dropped-location module comes back as dropped instead of being written, and
 * a page that cannot be read is written as is, so a secondary failure never
 * costs a reading.
 */
async function collectQueuedRound(
  ctx: CheckContext,
  tasks: QueuedTask[],
): Promise<CollectRoundOutcome> {
  const completed: RankCheckResultWithDevice[] = [];
  const stillPending: QueuedTask[] = [];
  const failed: QueuedTask[] = [];
  const dropped: QueuedTask[] = [];
  let validated = 0;
  let htmlUnavailable = 0;
  let firstError: string | null = null;

  for (let i = 0; i < tasks.length; i += TASK_GET_CONCURRENCY) {
    const chunk = tasks.slice(i, i + TASK_GET_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((task) =>
        fetchRankCheckTaskResult({
          taskId: task.taskId,
          keywordId: task.keywordId,
          keyword: task.keyword,
          targetDomain: ctx.domain,
        }),
      ),
    );
    const toValidate: Array<{ task: QueuedTask; result: RankCheckResult }> = [];
    settled.forEach((result, index) => {
      const task = chunk[index];
      if (result.status === "rejected") {
        // Transient fetch failure — try again next round.
        console.warn(
          `[rank-check] ${ctx.runId} task_get failed:`,
          result.reason,
        );
        stillPending.push(task);
      } else if (result.value.status === "pending") {
        stillPending.push(task);
      } else if (result.value.status === "failed") {
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} failed: ${result.value.message}`,
        );
        firstError ??= result.value.message;
        failed.push(task);
      } else if (ctx.validateSerps) {
        toValidate.push({ task, result: result.value.result });
      } else {
        completed.push({ ...result.value.result, device: task.device });
      }
    });

    const pages = await Promise.allSettled(
      toValidate.map(({ task }) => fetchRankCheckTaskHtml(task.taskId)),
    );
    pages.forEach((page, index) => {
      const { task, result } = toValidate[index];
      if (page.status === "rejected" || page.value === null) {
        htmlUnavailable++;
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} page unavailable, reading kept unchecked`,
          page.status === "rejected" ? page.reason : "",
        );
        completed.push({ ...result, device: task.device });
      } else if (LOCATION_DROPPED_MARKER.test(page.value)) {
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} page shows Google dropped the location (attempt ${task.attempt}) keyword="${task.keyword}" device=${task.device}`,
        );
        dropped.push(task);
      } else {
        validated++;
        completed.push({ ...result, device: task.device });
      }
    });
  }

  if (firstError) {
    await RankTrackingRepository.setRunErrorIfEmpty(ctx.runId, firstError);
  }
  if (completed.length > 0) {
    await RankTrackingRepository.insertSnapshots(
      mapResultsToSnapshotRows(ctx.runId, completed),
    );
    // Progress for the UI; finalize recounts from the DB anyway.
    const snapshots = await RankTrackingRepository.getSnapshotsForRun(
      ctx.runId,
    );
    await RankTrackingRepository.updateRun(ctx.runId, {
      keywordsChecked: new Set(snapshots.map((s) => s.trackingKeywordId)).size,
    });
  }

  return {
    collected: completed.length,
    stillPending,
    failed,
    dropped,
    validated,
    htmlUnavailable,
  };
}

/** Per-run accounting for the queued path, in keyword/device task units. */
export interface QueuedCheckStats {
  /** Tasks accepted into DataForSEO's queue. */
  queueTasks: number;
  /** Task results collected from the queue within the polling window. */
  queueCollected: number;
  /** Tasks routed to the live fallback (rejected, failed, or timed out). */
  fallbackTasks: number;
  /** Fallback tasks that produced a snapshot. */
  fallbackChecked: number;
  /** Validated run: results whose page showed the location applied. */
  validated: number;
  /** Validated run: results whose page showed Google dropped the location. */
  locationDropped: number;
  /** Validated run: dropped results crawled again. */
  reposted: number;
  /** Validated run: readings withheld so the previous position stands. */
  withheld: number;
  /** Validated run: results written unchecked because their page was unreadable. */
  htmlUnavailable: number;
}

/**
 * Check keywords via DataForSEO's standard task queue (~30% of live cost).
 * Posts every keyword/device pair as a queued task, then polls task_get for
 * ~15 minutes, writing snapshots incrementally as tasks complete. Anything
 * still unfinished after the polling window — plus tasks DataForSEO rejected
 * or failed — gets one shot at the live endpoint so a run never hangs on a
 * stuck queue. Billing happens at task_post (and per live-fallback batch).
 */
export async function runQueuedCheck(
  step: WorkflowStep,
  ctx: CheckContext,
): Promise<QueuedCheckStats> {
  const taskInputs = expandToTaskInputs(ctx.keywords, ctx.devices);

  // Fork: the dropped-location module is matched by its English text, so a
  // validated run in another language is a plain queued run.
  const validate =
    ctx.validateSerps === true && /^en(?:[-_]|$)/i.test(ctx.languageCode);
  if (ctx.validateSerps && !validate) {
    console.warn(
      `[rank-check] ${ctx.runId} SERP validation skipped for language_code=${ctx.languageCode} (English pages only)`,
    );
  }
  const roundCtx: CheckContext = { ...ctx, validateSerps: validate };

  // Post all tasks to the queue, <=100 per request, one metered step each.
  // A failed chunk must not abort the run — earlier chunks were already
  // charged at DataForSEO, so their results have to be collected. The failed
  // chunk's pairs go to the live fallback instead.
  let pending: QueuedTask[] = [];
  const fallback: RankCheckTaskInput[] = [];
  const withheld: RankCheckTaskInput[] = [];
  for (let i = 0; i < taskInputs.length; i += MAX_TASKS_PER_POST) {
    const chunk = taskInputs.slice(i, i + MAX_TASKS_PER_POST);
    const postIndex = Math.floor(i / MAX_TASKS_PER_POST);
    let posted: PostedRankCheckTask[];
    try {
      posted = await pgStep(
        step,
        `post-tasks-${postIndex}`,
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () =>
          ctx.client.serp.rankCheckTaskPost({
            tasks: chunk,
            locationCode: ctx.locationCode,
            languageCode: ctx.languageCode,
            locationName: ctx.locationName,
            depth: ctx.serpDepth,
            targetDomain: ctx.domain,
          }),
      );
    } catch (error) {
      console.warn(
        `[rank-check] ${ctx.runId} post-tasks-${postIndex} failed:`,
        error,
      );
      fallback.push(...chunk);
      continue;
    }
    pending.push(...posted.map((task) => ({ ...task, attempt: 1 })));
    if (posted.length < chunk.length) {
      const acceptedKeys = new Set(
        posted.map((t) => `${t.keywordId}:${t.device}`),
      );
      fallback.push(
        ...chunk.filter((t) => !acceptedKeys.has(`${t.keywordId}:${t.device}`)),
      );
    }
  }

  const stats: QueuedCheckStats = {
    queueTasks: pending.length,
    queueCollected: 0,
    fallbackTasks: 0,
    fallbackChecked: 0,
    validated: 0,
    locationDropped: 0,
    reposted: 0,
    withheld: 0,
    htmlUnavailable: 0,
  };

  // Poll until everything is collected or the ~15 minute window closes. A
  // collect failure (past its retries) leaves that round's tasks pending for
  // the next round — or the live fallback — instead of failing the run; the
  // posted tasks are already paid for.
  for (
    let round = 0;
    round < QUEUED_POLL_INTERVALS.length && pending.length > 0;
    round++
  ) {
    await step.sleep(`wait-${round}`, QUEUED_POLL_INTERVALS[round]);

    // Cap task_gets per round so one collect step stays well inside the
    // per-invocation subrequest limit at the 1000-keyword config ceiling.
    const batch = pending.slice(0, TASK_GETS_PER_COLLECT);
    const overflow = pending.slice(TASK_GETS_PER_COLLECT);

    let outcome: CollectRoundOutcome;
    try {
      outcome = await pgStep(
        step,
        `collect-${round}`,
        COLLECT_STEP_CONFIG,
        () => collectQueuedRound(roundCtx, batch),
      );
    } catch (error) {
      console.warn(`[rank-check] ${ctx.runId} collect-${round} failed:`, error);
      continue;
    }

    stats.queueCollected += outcome.collected;
    stats.validated += outcome.validated;
    stats.htmlUnavailable += outcome.htmlUnavailable;
    stats.locationDropped += outcome.dropped.length;
    pending = [...outcome.stillPending, ...overflow];
    fallback.push(...outcome.failed);

    // A dropped reading is crawled again while attempts and the window allow;
    // otherwise it is withheld and the keyword keeps its previous position.
    const repost = outcome.dropped.filter(
      (task) =>
        task.attempt < MAX_VALIDATION_ATTEMPTS && round <= LAST_REPOST_ROUND,
    );
    withheld.push(...outcome.dropped.filter((task) => !repost.includes(task)));
    for (let i = 0; i < repost.length; i += MAX_TASKS_PER_POST) {
      const chunk = repost.slice(i, i + MAX_TASKS_PER_POST);
      const chunkIndex = Math.floor(i / MAX_TASKS_PER_POST);
      let posted: PostedRankCheckTask[] = [];
      try {
        posted = await pgStep(
          step,
          `repost-${round}-${chunkIndex}`,
          SINGLE_ATTEMPT_STEP_CONFIG,
          async () =>
            ctx.client.serp.rankCheckTaskPost({
              tasks: chunk,
              locationCode: ctx.locationCode,
              languageCode: ctx.languageCode,
              locationName: ctx.locationName,
              depth: ctx.serpDepth,
              targetDomain: ctx.domain,
            }),
        );
      } catch (error) {
        console.warn(
          `[rank-check] ${ctx.runId} repost-${round}-${chunkIndex} failed:`,
          error,
        );
      }
      const byKey = new Map(
        chunk.map((task) => [`${task.keywordId}:${task.device}`, task]),
      );
      for (const task of posted) {
        const key = `${task.keywordId}:${task.device}`;
        const previous = byKey.get(key);
        if (!previous) continue;
        byKey.delete(key);
        pending.push({ ...task, attempt: previous.attempt + 1 });
      }
      stats.reposted += posted.length;
      withheld.push(...byKey.values());
    }
  }

  if (validate) {
    // Live results cannot be checked against their page, so a validated run
    // withholds what the queue did not deliver instead of falling back. The
    // run's error line tells the user which readings kept their old position.
    withheld.push(...pending, ...fallback);
    stats.withheld = withheld.length;
    if (withheld.length > 0) {
      const pairs = withheld.map((t) => `${t.keyword}/${t.device}`).join(", ");
      console.warn(
        `[rank-check] ${ctx.runId} withheld ${withheld.length} reading(s): ${pairs.slice(0, 500)}`,
      );
      await pgStep(step, "withhold", SINGLE_ATTEMPT_STEP_CONFIG, () =>
        RankTrackingRepository.setRunErrorIfEmpty(
          ctx.runId,
          withheldMessage(withheld.length),
        ),
      );
    }
    return stats;
  }

  // Live fallback: queued tasks that never finished, failed, or were rejected
  // at post time. A straggler is double-billed (customer was metered the
  // queued post cost and now the live call too — fractions of a cent).
  // Progress isn't updated here; finalize recounts keywordsChecked from the
  // DB.
  const stragglers: RankCheckTaskInput[] = [...fallback, ...pending];
  stats.fallbackTasks = stragglers.length;
  if (stragglers.length === 0) return stats;

  console.log(
    `[rank-check] ${ctx.runId} live fallback for ${stragglers.length} task(s)`,
  );

  for (let i = 0; i < stragglers.length; i += KEYWORDS_PER_BATCH) {
    const batch = stragglers.slice(i, i + KEYWORDS_PER_BATCH);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);

    stats.fallbackChecked += await pgStep(
      step,
      `fallback-batch-${batchIndex}`,
      LIVE_BATCH_STEP_CONFIG,
      () => checkBatchLive(ctx, batch),
    );
  }

  return stats;
}
