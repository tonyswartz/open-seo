import { z } from "zod";

export const SEO_HISTORY_KINDS = [
  "map_pack",
  "reviews",
  "gsc_totals",
  "gsc_queries",
  "ai_visibility",
  "lsa_audit",
  "weekly_digest",
] as const;

export type SeoHistoryKind = (typeof SEO_HISTORY_KINDS)[number];

export const seoHistoryKindSchema = z.enum(SEO_HISTORY_KINDS);

const isoDateSchema = z
  .string()
  .min(1)
  .max(40)
  .describe("ISO date or timestamp for the snapshot period.");

const jsonObjectSchema = z.record(z.string(), z.unknown());

const mapPackPayloadSchema = z
  .object({
    query: z.string().min(1).max(200),
    location: z.string().max(200).optional(),
    results: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            rank: z.number().int().positive().optional(),
            rating: z.number().optional(),
            reviews: z.number().optional(),
            cid: z.string().max(80).optional(),
          })
          .passthrough(),
      )
      .max(50),
  })
  .passthrough();

const reviewsPayloadSchema = z
  .object({
    businesses: z
      .array(
        z
          .object({
            name: z.string().min(1).max(200),
            rating: z.number().optional(),
            reviewCount: z.number().optional(),
            cid: z.string().max(80).optional(),
          })
          .passthrough(),
      )
      .max(50),
  })
  .passthrough();

const gscTotalsPayloadSchema = z
  .object({
    clicks: z.number(),
    impressions: z.number(),
    ctr: z.number().optional(),
    position: z.number().optional(),
  })
  .passthrough();

const gscQueriesPayloadSchema = z
  .object({
    queries: z
      .array(
        z
          .object({
            query: z.string().min(1).max(200),
            clicks: z.number().optional(),
            impressions: z.number().optional(),
            ctr: z.number().optional(),
            position: z.number().optional(),
          })
          .passthrough(),
      )
      .max(100),
  })
  .passthrough();

const aiVisibilityPayloadSchema = z
  .object({
    platform: z.string().max(80).optional(),
    prompts: z
      .array(
        z
          .object({
            prompt: z.string().min(1).max(500),
            mentioned: z.boolean().optional(),
            cited: z.boolean().optional(),
            rank: z.number().optional(),
          })
          .passthrough(),
      )
      .max(50),
  })
  .passthrough();

const lsaAuditPayloadSchema = z
  .object({
    spend: z.number().optional(),
    leads: z.number().optional(),
    credits: z.number().optional(),
    findings: z.unknown().optional(),
  })
  .passthrough();

const weeklyDigestPayloadSchema = z
  .object({
    summary: z.string().min(1).max(8000),
    extras: jsonObjectSchema.optional(),
  })
  .passthrough();

const seoHistoryPayloadByKind = {
  map_pack: mapPackPayloadSchema,
  reviews: reviewsPayloadSchema,
  gsc_totals: gscTotalsPayloadSchema,
  gsc_queries: gscQueriesPayloadSchema,
  ai_visibility: aiVisibilityPayloadSchema,
  lsa_audit: lsaAuditPayloadSchema,
  weekly_digest: weeklyDigestPayloadSchema,
} as const;

export const recordSeoHistorySchema = z.object({
  projectId: z.string().min(1),
  kind: seoHistoryKindSchema,
  periodStart: isoDateSchema.optional(),
  periodEnd: isoDateSchema.optional(),
  source: z.string().min(1).max(80).optional(),
  payload: jsonObjectSchema,
});

export type RecordSeoHistoryInput = z.infer<typeof recordSeoHistorySchema>;

export function parseSeoHistoryPayload(kind: SeoHistoryKind, payload: unknown) {
  return seoHistoryPayloadByKind[kind].parse(payload);
}

export const getSeoHistorySchema = z.object({
  projectId: z.string().min(1),
  kind: seoHistoryKindSchema.optional(),
  sinceDays: z.number().int().positive().max(730).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export type GetSeoHistoryInput = z.infer<typeof getSeoHistorySchema>;
