import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { googleAdsConnections } from "@/db/schema";

export type GoogleAdsConnection = typeof googleAdsConnections.$inferSelect;

async function getByProjectId(
  projectId: string,
): Promise<GoogleAdsConnection | null> {
  const rows = await db
    .select()
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsert(input: {
  projectId: string;
  organizationId: string;
  customerId: string;
  loginCustomerId: string | null;
  customerDescriptiveName: string | null;
  currencyCode: string | null;
  connectedByUserId: string;
  googleAdsAccountId: string;
  connectedAccountEmail: string | null;
}): Promise<GoogleAdsConnection> {
  const [row] = await db
    .insert(googleAdsConnections)
    .values({ id: crypto.randomUUID(), ...input })
    .onConflictDoUpdate({
      target: googleAdsConnections.projectId,
      set: {
        organizationId: input.organizationId,
        customerId: input.customerId,
        loginCustomerId: input.loginCustomerId,
        customerDescriptiveName: input.customerDescriptiveName,
        currencyCode: input.currencyCode,
        connectedByUserId: input.connectedByUserId,
        googleAdsAccountId: input.googleAdsAccountId,
        connectedAccountEmail: sql`case
          when ${googleAdsConnections.connectedByUserId} = ${input.connectedByUserId}
            and ${googleAdsConnections.googleAdsAccountId} = ${input.googleAdsAccountId}
          then coalesce(${input.connectedAccountEmail}, ${googleAdsConnections.connectedAccountEmail})
          else ${input.connectedAccountEmail}
        end`,
        updatedAt: sql`(current_timestamp)`,
      },
    })
    .returning();
  if (!row) throw new Error("Failed to upsert google_ads_connection");
  return row;
}

async function deleteByProjectId(projectId: string): Promise<void> {
  await db
    .delete(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId));
}

async function existsForConnectorAccount(
  userId: string,
  googleAdsAccountId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: googleAdsConnections.id })
    .from(googleAdsConnections)
    .where(
      and(
        eq(googleAdsConnections.connectedByUserId, userId),
        eq(googleAdsConnections.googleAdsAccountId, googleAdsAccountId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export const GoogleAdsConnectionRepository = {
  getByProjectId,
  upsert,
  deleteByProjectId,
  existsForConnectorAccount,
};
