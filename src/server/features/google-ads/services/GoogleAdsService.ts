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
  isAccessPendingReason,
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
    .select({
      id: account.id,
      accountId: account.accountId,
      scope: account.scope,
    })
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

async function grantExists(
  userId: string,
  googleAdsAccountId: string,
): Promise<boolean> {
  const grants = await listGrantsForUser(userId);
  return grants.some((grant) => grant.accountId === googleAdsAccountId);
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
    isAccessPendingReason(error.upstreamReason)
  );
}

/** Grant-wide failures (expired grant, missing config, Google-side
 *  onboarding) abort discovery so the caller can classify them; anything else
 *  is treated as one bad account and skipped. */
function abortsDiscovery(error: unknown): boolean {
  return (
    requiresReconnect(error) ||
    accessPending(error) ||
    error instanceof GoogleAdsConfigError
  );
}

function errorLogDetails(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : "UnknownError",
    status: error instanceof GoogleAdsApiError ? error.status : undefined,
    reason:
      error instanceof GoogleAdsApiError ? error.upstreamReason : undefined,
  };
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
 *  customers plus every enabled non-manager client under any accessible
 *  manager, each probed for Local Services campaigns. A failure on a single
 *  account is logged and skipped — unless nothing survives, in which case the
 *  first failure is rethrown so the caller classifies a real access problem
 *  instead of reporting a (misleading) empty account list. */
async function listAccountsForGrant(input: {
  userId: string;
  googleAdsAccountId: string;
}): Promise<GoogleAdsAccountCandidate[]> {
  const client = createGoogleAdsClient(input);
  const allAccessible = await client.listAccessibleCustomers();
  const accessible = allAccessible.slice(0, MAX_ACCESSIBLE_CUSTOMERS);
  console.info("google_ads.accessible_customers", {
    count: allAccessible.length,
    customerIds: accessible,
  });
  const candidates: GoogleAdsAccountCandidate[] = [];
  const skipErrors: unknown[] = [];
  const skip = (customerId: string, step: string, error: unknown) => {
    skipErrors.push(error);
    console.warn("google_ads.customer_skipped", {
      customerId,
      step,
      ...errorLogDetails(error),
    });
  };
  for (const customerId of accessible) {
    let customer: z.infer<typeof customerRowSchema>["customer"] | null = null;
    try {
      const rows = await client.search(
        customerId,
        `SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code FROM customer`,
      );
      customer = rows[0] ? customerRowSchema.parse(rows[0]).customer : null;
    } catch (error) {
      if (abortsDiscovery(error)) throw error;
      skip(customerId, "customer", error);
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
           WHERE customer_client.level >= 1 AND customer_client.status = 'ENABLED'`,
          { loginCustomerId: customerId },
        );
        clients = rows.map((row) => customerClientRowSchema.parse(row));
      } catch (error) {
        if (abortsDiscovery(error)) throw error;
        skip(customerId, "customer_client", error);
        continue;
      }
      const eligible = clients.filter(
        ({ customerClient }) => !customerClient.manager,
      );
      console.info("google_ads.manager_expanded", {
        managerId: customerId,
        clientRows: clients.length,
        eligible: eligible.length,
      });
      for (const { customerClient } of eligible) {
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
  if (bounded.length === 0 && skipErrors.length > 0) {
    throw skipErrors[0];
  }
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
  console.info("google_ads.account_discovery", {
    accessible: accessible.length,
    candidates: bounded.length,
    skipped: skipErrors.length,
  });
  return bounded;
}

async function listAccountsForUserWithGrantStatus(userId: string) {
  const grants = await listGrantsForUser(userId);
  const accounts = await Promise.all(
    grants.map(async (grant) => {
      console.info("google_ads.grant_discovery", {
        googleAccountId: grant.accountId,
        scope: grant.scope ?? null,
      });
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
          console.error(
            "google_ads.account_discovery_failed",
            errorLogDetails(error),
          );
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
  if (!(await grantExists(input.userId, input.accountId))) {
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

  const connection = await GoogleAdsConnectionRepository.upsert({
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
  // Discovery above is several Google round trips long. Disconnecting another
  // project that shares this Google login releases the grant, so it can vanish
  // inside that window — leaving a saved connection whose refresh token is
  // already gone. Undo rather than store a dead link.
  if (!(await grantExists(input.userId, input.accountId))) {
    await GoogleAdsConnectionRepository.deleteByProjectId(input.projectId);
    throw new AppError(
      "NOT_FOUND",
      "That Google account was disconnected while saving. Reconnect and try again.",
    );
  }
  return connection;
}

async function disconnect(input: {
  projectId: string;
  userId: string;
}): Promise<void> {
  const connection = await GoogleAdsConnectionRepository.getByProjectId(
    input.projectId,
  );
  await GoogleAdsConnectionRepository.deleteByProjectId(input.projectId);
  if (connection && connection.connectedByUserId === input.userId) {
    await GoogleAdsConnectionRepository.unlinkGrantIfUnused(
      input.userId,
      connection.googleAdsAccountId,
    );
  }
}

export const GoogleAdsService = {
  getConnection,
  userHasGrant,
  listAccountsForUserWithGrantStatus,
  setAccount,
  disconnect,
};
