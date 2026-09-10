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
 *  instead of reporting a (misleading) empty account list.
 *
 *  `truncated` reports that a discovery bound was hit, so the picker can say
 *  the list is partial rather than letting an account the user is looking for
 *  simply not be there. */
async function listAccountsForGrant(input: {
  userId: string;
  googleAdsAccountId: string;
}): Promise<{ accounts: GoogleAdsAccountCandidate[]; truncated: boolean }> {
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
  // One customer can arrive twice — reachable through two managers, or both
  // directly and under a manager. Same account either way, so keep one entry,
  // preferring the direct route (it needs no login-customer-id header).
  const unique = new Map<string, GoogleAdsAccountCandidate>();
  for (const candidate of candidates) {
    const existing = unique.get(candidate.customerId);
    if (!existing || (existing.loginCustomerId && !candidate.loginCustomerId)) {
      unique.set(candidate.customerId, candidate);
    }
  }
  const deduped = [...unique.values()];
  const bounded = deduped.slice(0, MAX_CANDIDATE_ACCOUNTS);
  const truncated =
    allAccessible.length > MAX_ACCESSIBLE_CUSTOMERS ||
    deduped.length > MAX_CANDIDATE_ACCOUNTS;
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
    duplicatesDropped: candidates.length - deduped.length,
    skipped: skipErrors.length,
    truncated,
  });
  return { accounts: bounded, truncated };
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
        const discovered = await listAccountsForGrant({
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
          setupRequired: false,
          accountsUnavailable: false,
          truncated: discovered.truncated,
          accounts: discovered.accounts,
        };
      } catch (error) {
        const reconnect = requiresReconnect(error);
        const pending = accessPending(error);
        // A missing developer token is this deployment's own setup gap, not
        // Google taking its time on approval. Same empty picker, but the two
        // need different copy or the self-hoster waits for nothing.
        const setupRequired = error instanceof GoogleAdsConfigError;
        if (!reconnect && !pending && !setupRequired) {
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
          setupRequired,
          accountsUnavailable: !reconnect && !pending && !setupRequired,
          truncated: false,
          accounts: [],
        };
      }
    }),
  );
  return { accounts };
}

const accountUnavailable = () =>
  new AppError(
    "NOT_FOUND",
    "That Google Ads account isn't available on your connected Google account.",
  );

/** Confirm the one account the user picked, rather than re-running discovery
 *  to look it up. Discovery fans out over every accessible customer, so a blip
 *  on an unrelated account could reject the account they had just chosen from
 *  a list that was right in front of them.
 *
 *  `loginCustomerId` arrives from the client, so it is checked against the
 *  managers this grant can actually reach before it is used as a header or
 *  stored — and the reporting fields come from Google's answer, never the
 *  request. */
async function verifyAccountForGrant(input: {
  userId: string;
  googleAdsAccountId: string;
  customerId: string;
  loginCustomerId: string | null;
}): Promise<GoogleAdsAccountCandidate> {
  const client = createGoogleAdsClient({
    userId: input.userId,
    googleAdsAccountId: input.googleAdsAccountId,
  });
  const accessible = await client.listAccessibleCustomers();
  // Either the manager the account hangs off, or the account itself when the
  // grant reaches it directly.
  if (!accessible.includes(input.loginCustomerId ?? input.customerId)) {
    throw accountUnavailable();
  }
  const rows = await client.search(
    input.customerId,
    `SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code FROM customer`,
    { loginCustomerId: input.loginCustomerId },
  );
  const customer = rows[0] ? customerRowSchema.parse(rows[0]).customer : null;
  // Managers hold no campaigns of their own; discovery expands them instead of
  // offering them, so one arriving here is a stale or hand-made selection.
  if (!customer || customer.id !== input.customerId || customer.manager) {
    throw accountUnavailable();
  }
  return {
    customerId: customer.id,
    loginCustomerId: input.loginCustomerId,
    descriptiveName: customer.descriptiveName ?? null,
    currencyCode: customer.currencyCode ?? null,
    hasLocalServicesCampaigns: false,
  };
}

async function setAccount(input: {
  projectId: string;
  organizationId: string;
  accountId: string;
  customerId: string;
  loginCustomerId: string | null;
  userId: string;
}): Promise<GoogleAdsConnection> {
  if (!(await grantExists(input.userId, input.accountId))) {
    throw new AppError(
      "NOT_FOUND",
      "That Google account isn't connected to your OpenSEO account.",
    );
  }
  const candidate = await verifyAccountForGrant({
    userId: input.userId,
    googleAdsAccountId: input.accountId,
    customerId: input.customerId,
    loginCustomerId: input.loginCustomerId,
  });

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
  // Verification above is a couple of Google round trips. Disconnecting another
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
