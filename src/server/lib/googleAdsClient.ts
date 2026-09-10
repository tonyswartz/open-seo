import { z } from "zod";
import { getAuth } from "@/lib/auth";
import {
  GoogleAdsApiError,
  GoogleAdsConfigError,
  GoogleAdsTokenError,
} from "@/server/lib/googleAdsErrors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { GOOGLE_ADS_OAUTH_PROVIDER_ID } from "@/shared/google-ads";

// Versioned base: Google sunsets each major version ~a year after release.
const GOOGLE_ADS_API_BASE = "https://googleads.googleapis.com/v25";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MAX_SEARCH_PAGES = 5;
const MAX_ERROR_BODY_LENGTH = 8_000;

// GAQL rows arrive as ProtoJSON objects keyed by resource (camelCase); the
// reporting service narrows each row with its own schema.
const searchResponseSchema = z.object({
  results: z.array(z.unknown()).optional(),
  nextPageToken: z.string().optional(),
});

const listAccessibleCustomersSchema = z.object({
  resourceNames: z.array(z.string()).optional(),
});

/** Best-effort extraction of the first Ads error detail code, e.g.
 *  { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" } → that string. */
function extractUpstreamReason(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const failures = z
      .object({
        error: z.object({
          details: z
            .array(
              z.object({
                errors: z
                  .array(
                    z.object({
                      errorCode: z.record(z.string(), z.string()).optional(),
                    }),
                  )
                  .optional(),
              }),
            )
            .optional(),
        }),
      })
      .safeParse(parsed);
    if (!failures.success) return null;
    for (const detail of failures.data.error.details ?? []) {
      for (const error of detail.errors ?? []) {
        const code = Object.values(error.errorCode ?? {})[0];
        if (code) return code;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function messageForStatus(status: number, upstreamReason: string | null) {
  if (upstreamReason === "DEVELOPER_TOKEN_NOT_APPROVED") {
    return "Google has not approved Ads API access for this developer token yet.";
  }
  if (upstreamReason === "SERVICE_DISABLED") {
    return "The Google Ads API is not enabled on the OAuth client's Google Cloud project.";
  }
  if (status === 401) return "Google Ads connection expired.";
  if (status === 403) {
    return "Google Ads denied access. Check the account's access level and API onboarding.";
  }
  if (status === 429) return "Google Ads rate limit reached.";
  return `Google Ads API error (${status}).`;
}

async function getGoogleAdsAccessToken(opts: {
  userId: string;
  googleAdsAccountId: string;
}): Promise<string> {
  let result: { accessToken?: string } | undefined;
  try {
    // Headerless call: getAccessToken trusts body.userId when no request
    // session is present, and auto-refreshes via the genericOAuth provider.
    result = await getAuth().api.getAccessToken({
      body: {
        providerId: GOOGLE_ADS_OAUTH_PROVIDER_ID,
        userId: opts.userId,
        accountId: opts.googleAdsAccountId,
      },
    });
  } catch (error) {
    throw new GoogleAdsTokenError(
      "Could not mint a Google Ads access token.",
      error,
    );
  }
  if (!result?.accessToken) {
    throw new GoogleAdsTokenError("Google Ads returned no access token.");
  }
  return result.accessToken;
}

type GoogleAdsSearchOptions = {
  /** Manager account for the login-customer-id header, digits only. */
  loginCustomerId?: string | null;
};

/** Read-only Google Ads API client. Only issues googleAds:search report
 *  requests (plus OAuth userinfo); nothing here mutates campaigns. Access
 *  tokens are minted (and auto-refreshed) by Better Auth from the connector's
 *  stored google-ads grant. */
export function createGoogleAdsClient(opts: {
  userId: string;
  googleAdsAccountId: string;
}) {
  // Memoized so a fan-out of concurrent requests mints one token — but dropped
  // again on failure. Keeping a rejected promise would poison every later call
  // on this client, turning one transient refresh blip into a permanent
  // "connection expired, reconnect" for the user.
  let accessTokenPromise: Promise<string> | undefined;
  const accessToken = () => {
    accessTokenPromise ??= getGoogleAdsAccessToken(opts).catch(
      (error: unknown) => {
        accessTokenPromise = undefined;
        throw error;
      },
    );
    return accessTokenPromise;
  };

  async function request<T>(input: {
    url: string;
    schema: z.ZodType<T>;
    body?: unknown;
    loginCustomerId?: string | null;
  }): Promise<T> {
    const developerToken = (
      await getOptionalEnvValue("GOOGLE_ADS_DEVELOPER_TOKEN")
    )?.trim();
    if (!developerToken) throw new GoogleAdsConfigError();
    const token = await accessToken();
    const hasBody = input.body !== undefined;
    let response: Response;
    try {
      response = await fetch(input.url, {
        method: hasBody ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "developer-token": developerToken,
          ...(input.loginCustomerId
            ? { "login-customer-id": input.loginCustomerId }
            : {}),
          ...(hasBody ? { "Content-Type": "application/json" } : {}),
        },
        body: hasBody ? JSON.stringify(input.body) : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new GoogleAdsApiError(
        0,
        "Google Ads API is temporarily unavailable.",
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const reason = extractUpstreamReason(
        body.slice(0, MAX_ERROR_BODY_LENGTH),
      );
      throw new GoogleAdsApiError(
        response.status,
        messageForStatus(response.status, reason),
        reason,
      );
    }
    return input.schema.parse(await response.json());
  }

  return {
    async getUserInfoEmail(): Promise<string | null> {
      const data = await request({
        url: GOOGLE_USERINFO_URL,
        schema: z.object({ email: z.string().optional() }),
      });
      return data.email ?? null;
    },

    /** `customers:listAccessibleCustomers` — customer IDs (digits only) the
     *  grant can reach directly, managers included. */
    async listAccessibleCustomers(): Promise<string[]> {
      const data = await request({
        url: `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers`,
        schema: listAccessibleCustomersSchema,
      });
      return (data.resourceNames ?? []).map((name) =>
        name.replace(/^customers\//, ""),
      );
    },

    /** `googleAds:search` with a GAQL query. Pages are a fixed 10k rows
     *  (page_size was removed from the API in v17); pagination is followed up
     *  to a small cap and rows are returned unnarrowed for the caller to
     *  schema-check. */
    async search(
      customerId: string,
      query: string,
      options?: GoogleAdsSearchOptions,
    ): Promise<unknown[]> {
      const rows: unknown[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
        const data = await request({
          url: `${GOOGLE_ADS_API_BASE}/customers/${encodeURIComponent(customerId)}/googleAds:search`,
          schema: searchResponseSchema,
          body: { query, ...(pageToken ? { pageToken } : {}) },
          loginCustomerId: options?.loginCustomerId,
        });
        rows.push(...(data.results ?? []));
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
      return rows;
    },
  };
}
