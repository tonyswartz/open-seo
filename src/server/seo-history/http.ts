import { env } from "cloudflare:workers";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { LocalServicesReportingService } from "@/server/features/google-ads/services/LocalServicesReportingService";
import { SeoHistoryService } from "@/server/features/seo-history/services/SeoHistoryService";
import { asAppError } from "@/server/lib/errors";
import { SEO_HISTORY_HTTP_PATH } from "@/shared/seo-history";
import {
  seoHistoryKindSchema,
  type SeoHistoryKind,
} from "@/types/schemas/seo-history";

function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function optionalInt(
  value: string | null,
  fallback: number,
  max: number,
): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function handleSeoHistoryRequest(
  request: Request,
): Promise<Response> {
  const secret = env.OPENSEO_HISTORY_READ_KEY?.trim();
  if (!secret) return new Response("Not found", { status: 404 });
  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const presented = bearerToken(request);
  if (!presented || !timingSafeEqual(presented, secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const rest = url.pathname.slice(SEO_HISTORY_HTTP_PATH.length);
  const section =
    rest === "/ranks"
      ? "ranks"
      : rest === "/snapshots"
        ? "snapshots"
        : rest === "/local-services-leads"
          ? "localServicesLeads"
          : "all";
  if (
    rest &&
    rest !== "/ranks" &&
    rest !== "/snapshots" &&
    rest !== "/local-services-leads"
  ) {
    return json(404, { error: "not_found" });
  }

  const projectId = url.searchParams.get("projectId")?.trim();
  if (!projectId) {
    return json(400, { error: "projectId is required" });
  }

  try {
    const payload: Record<string, unknown> = { projectId };

    if (section === "localServicesLeads") {
      const startDate = url.searchParams.get("startDate")?.trim() || undefined;
      const endDate = url.searchParams.get("endDate")?.trim() || undefined;
      if (Boolean(startDate) !== Boolean(endDate)) {
        return json(400, {
          error: "Provide both startDate and endDate, or neither.",
        });
      }
      const result = await LocalServicesReportingService.listLeads({
        projectId,
        startDate,
        endDate,
        limit: optionalInt(url.searchParams.get("limit"), 50, 200),
      });
      payload.currencyCode = result.currencyCode;
      payload.startDate = result.dateRange.startDate;
      payload.endDate = result.dateRange.endDate;
      payload.leads = result.leads;
      return json(200, payload);
    }

    if (section === "ranks" || section === "all") {
      const trackerId = url.searchParams.get("trackerId")?.trim();
      if (section === "ranks" && !trackerId) {
        return json(400, { error: "trackerId is required for ranks" });
      }
      if (trackerId) {
        const device =
          url.searchParams.get("device") === "desktop" ? "desktop" : "mobile";
        const runLimit = optionalInt(url.searchParams.get("runLimit"), 12, 26);
        payload.ranks = await RankTrackingService.getPositionMatrix(
          trackerId,
          projectId,
          device,
          runLimit,
        );
      }
    }

    if (section === "snapshots" || section === "all") {
      const kindParam = url.searchParams.get("kind");
      let kind: SeoHistoryKind | undefined;
      if (kindParam) {
        const parsed = seoHistoryKindSchema.safeParse(kindParam);
        if (!parsed.success) {
          return json(400, { error: "invalid kind" });
        }
        kind = parsed.data;
      }
      payload.snapshots = await SeoHistoryService.list({
        projectId,
        kind,
        sinceDays: optionalInt(url.searchParams.get("sinceDays"), 365, 730),
        limit: optionalInt(url.searchParams.get("limit"), 50, 200),
      });
    }

    return json(200, payload);
  } catch (error) {
    const appError = asAppError(error);
    if (appError?.code === "NOT_FOUND") {
      return json(404, { error: "not_found" });
    }
    if (appError?.code === "VALIDATION_ERROR") {
      return json(400, { error: appError.message });
    }
    throw error;
  }
}
