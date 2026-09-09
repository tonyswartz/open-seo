import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { account } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { createGoogleAdsClient } from "@/server/lib/googleAdsClient";
import {
  GoogleAdsApiError,
  GoogleAdsConfigError,
  GoogleAdsTokenError,
} from "@/server/lib/googleAdsErrors";
import { GOOGLE_ADS_OAUTH_PROVIDER_ID } from "@/shared/google-ads";
import {
  GoogleAdsConnectionRepository,
  type GoogleAdsConnection,
} from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";

// Discovery bounds: a grant with access to more accounts than this gets a
// truncated (still usable) picker rather than an unbounded API fan-out.
const MAX_ACCESSIBLE_CUSTOMERS = 10;
const MAX_CANDIDATE_ACCOUNTS = 25;

const customerRowSchema = z.looseObject({
  customer: z.looseObject({
    id: z.string(),
    descriptiveName: z.string().optional(),
    manager: z.boolean().optional(),
    currencyCode: z.string().optional(),
  }),
});

const customerClientRowSchema = z.looseObject({
  customerClient: z.looseObject({
    clientCustomer: z.string(),
    descriptiveName: z.string().optional(),
    manager: z.boolean().optional(),
    currencyCode: z.string().optional(),
  }),
});

type GoogleAdsAccountCandidate = {
  customerId: string;
  loginCustomerId: string | null;
  descriptiveName: string | null;
  currencyCode: string | null;
  hasLocalServicesCampaigns: boolean;
};

async function getConnection(
  projectId: string,
): Promise<GoogleAdsConnection | null> {
  return GoogleAdsConnectionRepository.getByProjectId(projectId);
}

async function listGrantsForUser(userId: string) {
  return db
    .select({ id: account.id, accountId: account.accountId })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GOOGLE_ADS_OAUTH_PROVIDER_ID),
      ),
    );
}

async function userHasGrant(userId: string): Promise<boolean> {
  const grants = await listGrantsForUser(userId);
  return grants.length > 0;
}

function requiresReconnect(error: unknown): boolean {
  return (
    error instanceof GoogleAdsTokenError ||
    (error instanceof GoogleAdsApiError && error.status === 401)
  );
}

function accessPending(error: unknown): boolean {
  return (
    error instanceof GoogleAdsApiError &&
    (error.upstreamReason === "DEVELOPER_TOKEN_NOT_APPROVED" ||
      error.upstreamReason === "DEVELOPER_TOKEN_PROHIBITED" ||
      error.upstreamReason === "MISSING_DEVELOPER_TOKEN" ||
      error.upstreamReason === "SERVICE_DISABLED")
  );
}

async function hasLocalServicesCampaigns(
  client: ReturnType<typeof createGoogleAdsClient>,
  customerId: string,
  loginCustomerId: string | null,
): Promise<boolean> {
  const rows = await client.search(
    customerId,
    `SELECT campaign.id FROM campaign
     WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'
     LIMIT 1`,
    { loginCustomerId },
  );
  return rows.length > 0;
}

/** Expand one grant into selectable Ads accounts: directly-accessible
 *  customers plus the first level of clients under any accessible manager,
 *  each probed for Local Services campaigns. Per-account failures degrade to
 *  an unprobed candidate instead of failing the whole listing. */
async function listAccountsForGrant(input: {
  userId: string;
  googleAdsAccountId: string;
}): Promise<GoogleAdsAccountCandidate[]> {
  const client = createGoogleAdsClient(input);
  const accessible = (await client.listAccessibleCustomers()).slice(
    0,
    MAX_ACCESSIBLE_CUSTOMERS,
  );
  const candidates: GoogleAdsAccountCandidate[] = [];
  for (const customerId of accessible) {
    let customer: z.infer<typeof customerRowSchema>["customer"] | null = null;
    try {
      const rows = await client.search(
        customerId,
        `SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code FROM customer`,
      );
      customer = rows[0] ? customerRowSchema.parse(rows[0]).customer : null;
    } catch (error) {
      if (requiresReconnect(error) || error instanceof GoogleAdsConfigError) {
        throw error;
      }
      // Canceled or restricted account on the grant: skip it, keep the rest.
      continue;
    }
    if (!customer) continue;
    if (customer.manager) {
      let clients: Array<z.infer<typeof customerClientRowSchema>> = [];
      try {
        const rows = await client.search(
          customerId,
          `SELECT customer_client.client_customer, customer_client.descriptive_name,
                  customer_client.manager, customer_client.currency_code
           FROM customer_client
           WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED'`,
          { loginCustomerId: customerId },
        );
        clients = rows.map((row) => customerClientRowSchema.parse(row));
      } catch (error) {
        if (requiresReconnect(error) || error instanceof GoogleAdsConfigError) {
          throw error;
        }
        continue;
      }
      for (const { customerClient } of clients) {
        if (customerClient.manager) continue;
        candidates.push({
          customerId: customerClient.clientCustomer.replace(/^customers\//, ""),
          loginCustomerId: customerId,
          descriptiveName: customerClient.descriptiveName ?? null,
          currencyCode: customerClient.currencyCode ?? null,
          hasLocalServicesCampaigns: false,
        });
      }
    } else {
      candidates.push({
        customerId: customer.id,
        loginCustomerId: null,
        descriptiveName: customer.descriptiveName ?? null,
        currencyCode: customer.currencyCode ?? null,
        hasLocalServicesCampaigns: false,
      });
    }
  }
  const bounded = candidates.slice(0, MAX_CANDIDATE_ACCOUNTS);
  await Promise.all(
    bounded.map(async (candidate) => {
      try {
        candidate.hasLocalServicesCampaigns = await hasLocalServicesCampaigns(
          client,
          candidate.customerId,
          candidate.loginCustomerId,
        );
      } catch {
        // Leave the candidate selectable; the probe is a hint, not a gate.
      }
    }),
  );
  return bounded;
}

async function listAccountsForUserWithGrantStatus(userId: string) {
  const grants = await listGrantsForUser(userId);
  const accounts = await Promise.all(
    grants.map(async (grant) => {
      const client = createGoogleAdsClient({
        userId,
        googleAdsAccountId: grant.accountId,
      });
      try {
        const candidates = await listAccountsForGrant({
          userId,
          googleAdsAccountId: grant.accountId,
        });
        let email: string | null = null;
        try {
          email = await client.getUserInfoEmail();
        } catch {
          email = null;
        }
        return {
          accountId: grant.accountId,
          email,
          requiresReconnect: false,
          accessPending: false,
          accountsUnavailable: false,
          accounts: candidates,
        };
      } catch (error) {
        const reconnect = requiresReconnect(error);
        const pending =
          accessPending(error) || error instanceof GoogleAdsConfigError;
        if (!reconnect && !pending) {
          console.error("google_ads.account_discovery_failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            status:
              error instanceof GoogleAdsApiError ? error.status : undefined,
            reason:
              error instanceof GoogleAdsApiError
                ? error.upstreamReason
                : undefined,
          });
        }
        return {
          accountId: grant.accountId,
          email: null,
          requiresReconnect: reconnect,
          accessPending: pending,
          accountsUnavailable: !reconnect && !pending,
          accounts: [],
        };
      }
    }),
  );
  return { accounts };
}

async function setAccount(input: {
  projectId: string;
  organizationId: string;
  accountId: string;
  customerId: string;
  userId: string;
}): Promise<GoogleAdsConnection> {
  const grants = await listGrantsForUser(input.userId);
  if (!grants.some((grant) => grant.accountId === input.accountId)) {
    throw new AppError(
      "NOT_FOUND",
      "That Google account isn't connected to your OpenSEO account.",
    );
  }
  const candidates = await listAccountsForGrant({
    userId: input.userId,
    googleAdsAccountId: input.accountId,
  });
  const candidate = candidates.find(
    (entry) => entry.customerId === input.customerId,
  );
  if (!candidate) {
    throw new AppError(
      "NOT_FOUND",
      "That Google Ads account isn't available on your connected Google account.",
    );
  }

  const client = createGoogleAdsClient({
    userId: input.userId,
    googleAdsAccountId: input.accountId,
  });
  let connectedAccountEmail: string | null = null;
  try {
    connectedAccountEmail = await client.getUserInfoEmail();
  } catch {
    connectedAccountEmail = null;
  }

  return GoogleAdsConnectionRepository.upsert({
    projectId: input.projectId,
    organizationId: input.organizationId,
    customerId: candidate.customerId,
    loginCustomerId: candidate.loginCustomerId,
    customerDescriptiveName: candidate.descriptiveName,
    currencyCode: candidate.currencyCode,
    connectedByUserId: input.userId,
    googleAdsAccountId: input.accountId,
    connectedAccountEmail,
  });
}

async function unlinkUserGrant(
  userId: string,
  googleAdsAccountId: string,
): Promise<void> {
  await db
    .delete(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, GOOGLE_ADS_OAUTH_PROVIDER_ID),
        eq(account.accountId, googleAdsAccountId),
      ),
    );
}

async function disconnect(input: {
  projectId: string;
  userId: string;
}): Promise<void> {
  const connection = await GoogleAdsConnectionRepository.getByProjectId(
    input.projectId,
  );
  await GoogleAdsConnectionRepository.deleteByProjectId(input.projectId);
  if (
    connection?.googleAdsAccountId &&
    connection.connectedByUserId === input.userId
  ) {
    const stillUsed =
      await GoogleAdsConnectionRepository.existsForConnectorAccount(
        input.userId,
        connection.googleAdsAccountId,
      );
    if (!stillUsed) {
      await unlinkUserGrant(input.userId, connection.googleAdsAccountId);
    }
  }
}

export const GoogleAdsService = {
  getConnection,
  userHasGrant,
  listAccountsForUserWithGrantStatus,
  setAccount,
  disconnect,
};
