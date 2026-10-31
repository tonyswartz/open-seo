import {
  fetchRankCheckTaskHtml,
  type PostedRankCheckTask,
  type RankCheckResult,
  type RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import type {
  CheckContext,
  RankCheckResultWithDevice,
} from "@/server/workflows/rankCheckPaths";

// What a validated run checks each collected result against before it is
// written: the page that produced it, and the keyword/device pair's own recent
// history. Used by rankCheckQueuedPath; validateCollected runs inside a step
// body there, so it reads only its arguments.

/** A reading a validated run rejected, which a later crawl can confirm. */
type OffReading = { position: number; url: string | null };

/** A queued task with the number of crawls spent on its keyword/device pair. */
export type QueuedTask = PostedRankCheckTask & {
  attempt: number;
  lastOff?: OffReading;
};

export const pairKey = (task: RankCheckTaskInput) =>
  `${task.keywordId}:${task.device}`;

// Fork: Google's page carries this module when it did not apply the requested
// location to the organic ranking (the organic list is then the national one);
// a page with the location applied shows "Choose area" instead. English text,
// so RankTrackingService.triggerCheck refuses validated runs in other languages.
const LOCATION_DROPPED_MARKER = /Use precise location/i;

// A task's page HTML is up to ten Google result pages, so far fewer of those
// are read at once than the small advanced JSON results.
const HTML_FETCH_CONCURRENCY = 5;

// Fork: the second check a validated run applies. A page Google served without
// the location does not always carry the chip module above (the queue path
// mostly gets pages that look precise and still list the national ranking),
// but it always reads wrong against the keyword's own recent history: a pair
// that ranked well is suddenly absent, far lower, or ranks a different page
// below its usual one. A surprising gain (far higher, or another page at or
// above the usual position) is not rejected outright, since a new page can
// really take over: it needs a second crawl of the run to agree.
const HISTORY_DROP_TOLERANCE = 8;
const HISTORY_RANKED_CEILING = 20;
// Rows this close to the typical position count toward the usual page.
const USUAL_PAGE_SPREAD = 2;
// Two crawls agree on one page within this many positions.
const AGREEMENT_SPREAD = 2;

// The third check: the page's composition against the pair's usual sites
// (Nozzle's "usual sites", Advanced Web Ranking's SERP similarity). It is the
// one signal that also works for pairs that never rank: a page that keeps
// fewer than half of the sites the keyword usually shows is not that
// keyword's page. Needs a few stored compositions before it can judge.
const COMPOSITION_SNAPSHOTS = 5;
const COMPOSITION_MIN_SNAPSHOTS = 2;
const COMPOSITION_MIN_USUAL_SITES = 3;

/**
 * A pair's recent history: its typical position with the page that usually
 * holds it, and the sites that usually make up its page (null until enough are
 * stored).
 */
export interface PairBaseline {
  typicalPosition: number | null;
  usualUrl: string | null;
  usualSites: string[] | null;
}

type HistoryRow = {
  trackingKeywordId: string;
  device: string;
  position: number | null;
  url: string | null;
  topDomains: string | null;
};

function parseTopDomains(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/** Domains present in at least two of the pair's recent stored compositions. */
function usualSitesOf(compositions: string[][]): string[] | null {
  if (compositions.length < COMPOSITION_MIN_SNAPSHOTS) return null;
  const seenIn = new Map<string, number>();
  for (const domains of compositions) {
    for (const domain of new Set(domains)) {
      seenIn.set(domain, (seenIn.get(domain) ?? 0) + 1);
    }
  }
  const usual = [...seenIn]
    .filter(([, count]) => count >= 2)
    .map(([domain]) => domain);
  return usual.length >= COMPOSITION_MIN_USUAL_SITES ? usual : null;
}

const normalizePageUrl = (url: string) =>
  url
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .split(/[?#]/)[0]
    .replace(/\/+$/, "");

type PairReading = { position: number; url: string | null };

/** The lower median, so one fluke in either direction cannot move it. */
function typicalPositionOf(readings: PairReading[]): number | null {
  const positions = readings.map((reading) => reading.position);
  positions.sort((a, b) => a - b);
  return positions[Math.floor((positions.length - 1) / 2)] ?? null;
}

/** The page most often near the typical position; readings come newest first, so the newest wins a tie. */
function usualUrlOf(readings: PairReading[], typical: number): string | null {
  const counts = new Map<string, number>();
  for (const { position, url } of readings) {
    if (url !== null && Math.abs(position - typical) <= USUAL_PAGE_SPREAD) {
      const page = normalizePageUrl(url);
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
  }
  let usual: string | null = null;
  let usualCount = 0;
  for (const [page, count] of counts) {
    if (count > usualCount) {
      usual = page;
      usualCount = count;
    }
  }
  return usual;
}

/** Rows come newest first. */
export function buildBaselines(rows: HistoryRow[]): Map<string, PairBaseline> {
  const readings = new Map<string, PairReading[]>();
  const compositions = new Map<string, string[][]>();
  for (const row of rows) {
    const key = `${row.trackingKeywordId}:${row.device}`;
    if (row.position !== null) {
      const list = readings.get(key) ?? [];
      list.push({ position: row.position, url: row.url });
      readings.set(key, list);
    }
    const domains = parseTopDomains(row.topDomains);
    // Fork: rows stored before goto links were read list google.com in place of
    // the real sites, so they say nothing about the page.
    if (domains.length > 0 && !domains.includes("google.com")) {
      const list = compositions.get(key) ?? [];
      if (list.length < COMPOSITION_SNAPSHOTS) {
        list.push(domains);
        compositions.set(key, list);
      }
    }
  }
  const baselines = new Map<string, PairBaseline>();
  for (const key of new Set([...readings.keys(), ...compositions.keys()])) {
    const pair = readings.get(key) ?? [];
    const typicalPosition = typicalPositionOf(pair);
    baselines.set(key, {
      typicalPosition,
      usualUrl:
        typicalPosition === null ? null : usualUrlOf(pair, typicalPosition),
      usualSites: usualSitesOf(compositions.get(key) ?? []),
    });
  }
  return baselines;
}

function samePage(a: string, b: string): boolean {
  return normalizePageUrl(a) === normalizePageUrl(b);
}

function agrees(earlier: OffReading | undefined, result: RankCheckResult) {
  if (!earlier || result.position === null) return false;
  if (Math.abs(earlier.position - result.position) > AGREEMENT_SPREAD) {
    return false;
  }
  if (earlier.url === null || result.url === null) {
    return earlier.url === result.url;
  }
  return samePage(earlier.url, result.url);
}

function offPosition(
  result: RankCheckResult,
  baseline: PairBaseline,
  lastOff: OffReading | undefined,
): boolean {
  const typical = baseline.typicalPosition;
  if (typical === null) return false;
  const ranked = typical <= HISTORY_RANKED_CEILING;
  if (result.position === null) return ranked;
  if (ranked && result.position > typical + HISTORY_DROP_TOLERANCE) return true;
  // Fork: a Google goto link that would not resolve leaves no page to compare.
  const otherPage =
    result.url !== null &&
    baseline.usualUrl !== null &&
    !samePage(result.url, baseline.usualUrl);
  if (result.position > typical) return ranked && otherPage;
  const surprising =
    otherPage || result.position < typical - HISTORY_DROP_TOLERANCE;
  return surprising && !agrees(lastOff, result);
}

function offComposition(
  result: RankCheckResult,
  baseline: PairBaseline,
): boolean {
  if (!baseline.usualSites || result.topDomains.length === 0) return false;
  const present = baseline.usualSites.filter((site) =>
    result.topDomains.includes(site),
  ).length;
  return present * 2 < baseline.usualSites.length;
}

/** Which history check a reading fails, if any. */
function offHistory(
  result: RankCheckResult,
  baseline: PairBaseline | undefined,
  lastOff: OffReading | undefined,
): "position" | "composition" | null {
  if (!baseline) return null;
  if (offPosition(result, baseline, lastOff)) return "position";
  // Fork: a reading at the pair's usual position is no false drop, and usual
  // sites learned from altered pages would otherwise reject the real page.
  const typical = baseline.typicalPosition;
  if (result.position !== null && typical !== null) {
    if (result.position <= typical) return null;
  }
  if (offComposition(result, baseline)) return "composition";
  return null;
}

type PageVerdict = "localized" | "dropped" | "unread";

async function readPageVerdict(taskId: string): Promise<PageVerdict> {
  const read = await fetchRankCheckTaskHtml(taskId);
  if (read.status === "pending") return "unread";
  return read.pages.some((html) => LOCATION_DROPPED_MARKER.test(html))
    ? "dropped"
    : "localized";
}

/**
 * Validated runs: check each completed result against its own page and
 * against the pair's recent history. Either failing makes the result dropped
 * instead of written. A page that cannot be read yet keeps the task pending,
 * so it is read again next round rather than written unchecked.
 */
export async function validateCollected(
  ctx: CheckContext,
  items: Array<{ task: QueuedTask; result: RankCheckResult }>,
  baselines: Map<string, PairBaseline>,
) {
  const completed: RankCheckResultWithDevice[] = [];
  const dropped: QueuedTask[] = [];
  const unread: QueuedTask[] = [];
  let validated = 0;
  let historySuspect = 0;
  for (let i = 0; i < items.length; i += HTML_FETCH_CONCURRENCY) {
    const slice = items.slice(i, i + HTML_FETCH_CONCURRENCY);
    const verdicts = await Promise.allSettled(
      slice.map(({ task }) => readPageVerdict(task.taskId)),
    );
    verdicts.forEach((verdict, index) => {
      const { task, result } = slice[index];
      const outcome: PageVerdict =
        verdict.status === "fulfilled" ? verdict.value : "unread";
      if (outcome === "dropped") {
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} page shows Google dropped the location (attempt ${task.attempt}) keyword="${task.keyword}" device=${task.device}`,
        );
        dropped.push(task);
        return;
      }
      const failedCheck =
        outcome === "localized"
          ? offHistory(result, baselines.get(pairKey(task)), task.lastOff)
          : null;
      if (failedCheck !== null) {
        historySuspect++;
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} reading is off the pair's recent history (${failedCheck}, attempt ${task.attempt}) keyword="${task.keyword}" device=${task.device} position=${result.position} url=${result.url}`,
        );
        dropped.push(
          result.position === null
            ? task
            : {
                ...task,
                lastOff: { position: result.position, url: result.url },
              },
        );
        return;
      }
      if (outcome === "unread") {
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} page not readable yet, reading again next round`,
          verdict.status === "rejected" ? verdict.reason : "",
        );
        unread.push(task);
        return;
      }
      validated++;
      completed.push({ ...result, device: task.device });
    });
  }
  return { completed, dropped, unread, validated, historySuspect };
}
