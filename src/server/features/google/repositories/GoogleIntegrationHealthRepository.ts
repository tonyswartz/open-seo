import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { googleIntegrationHealth } from "@/db/schema";

type GoogleIntegrationKey = "google_ads" | "gsc" | "ga4";
type GoogleIntegrationHealthRow = typeof googleIntegrationHealth.$inferSelect;

type BaseInput = {
  projectId: string;
  integration: GoogleIntegrationKey;
  providerId: string;
  connectedByUserId: string;
  accountId: string | null;
};

type FailureInput = BaseInput & {
  errorClass: string;
  errorCode: string | null;
  errorSuberror: string | null;
  errorMessage: string | null;
};

async function getByProjectAndIntegration(input: {
  projectId: string;
  integration: GoogleIntegrationKey;
}): Promise<GoogleIntegrationHealthRow | null> {
  const rows = await db
    .select()
    .from(googleIntegrationHealth)
    .where(
      and(
        eq(googleIntegrationHealth.projectId, input.projectId),
        eq(googleIntegrationHealth.integration, input.integration),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function markRefreshSuccess(input: BaseInput): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insert(googleIntegrationHealth)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      integration: input.integration,
      providerId: input.providerId,
      connectedByUserId: input.connectedByUserId,
      accountId: input.accountId,
      lastSuccessfulRefreshAt: now,
      lastRefreshErrorAt: null,
      lastRefreshErrorClass: null,
      lastRefreshErrorCode: null,
      lastRefreshErrorSuberror: null,
      lastRefreshErrorMessage: null,
      consecutiveRefreshFailures: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        googleIntegrationHealth.projectId,
        googleIntegrationHealth.integration,
      ],
      set: {
        providerId: input.providerId,
        connectedByUserId: input.connectedByUserId,
        accountId: input.accountId,
        lastSuccessfulRefreshAt: now,
        lastRefreshErrorAt: null,
        lastRefreshErrorClass: null,
        lastRefreshErrorCode: null,
        lastRefreshErrorSuberror: null,
        lastRefreshErrorMessage: null,
        consecutiveRefreshFailures: 0,
        updatedAt: now,
      },
    });
}

async function markRefreshFailure(input: FailureInput): Promise<number> {
  const now = new Date().toISOString();
  const [row] = await db
    .insert(googleIntegrationHealth)
    .values({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      integration: input.integration,
      providerId: input.providerId,
      connectedByUserId: input.connectedByUserId,
      accountId: input.accountId,
      lastRefreshErrorAt: now,
      lastRefreshErrorClass: input.errorClass,
      lastRefreshErrorCode: input.errorCode,
      lastRefreshErrorSuberror: input.errorSuberror,
      lastRefreshErrorMessage: input.errorMessage,
      consecutiveRefreshFailures: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        googleIntegrationHealth.projectId,
        googleIntegrationHealth.integration,
      ],
      set: {
        providerId: input.providerId,
        connectedByUserId: input.connectedByUserId,
        accountId: input.accountId,
        lastRefreshErrorAt: now,
        lastRefreshErrorClass: input.errorClass,
        lastRefreshErrorCode: input.errorCode,
        lastRefreshErrorSuberror: input.errorSuberror,
        lastRefreshErrorMessage: input.errorMessage,
        consecutiveRefreshFailures: sql`${googleIntegrationHealth.consecutiveRefreshFailures} + 1`,
        updatedAt: now,
      },
    })
    .returning({
      failures: googleIntegrationHealth.consecutiveRefreshFailures,
    });
  return row?.failures ?? 1;
}

export const GoogleIntegrationHealthRepository = {
  getByProjectAndIntegration,
  markRefreshSuccess,
  markRefreshFailure,
};
