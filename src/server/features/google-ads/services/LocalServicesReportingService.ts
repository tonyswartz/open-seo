import { z } from "zod";
import { createGoogleAdsClient } from "@/server/lib/googleAdsClient";
import {
  GoogleAdsApiError,
  GoogleAdsConfigError,
  GoogleAdsReportError,
  GoogleAdsTokenError,
  errorLogDetails,
  isAccessPendingReason,
} from "@/server/lib/googleAdsErrors";
import { GoogleAdsConnectionRepository } from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_WINDOW_DAYS = 28;
const PACING_WINDOW_DAYS = 7;

// ProtoJSON: int64 fields arrive as strings, enums as bare strings, and
// scalar fields at their default value (false, 0) are omitted entirely.
const campaignRowSchema = z.looseObject({
  campaign: z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    status: z.string().optional(),
  }),
  campaignBudget: z
    .looseObject({
      amountMicros: z.string().optional(),
      period: z.string().optional(),
      type: z.string().optional(),
    })
    .optional(),
});

const spendRowSchema = z.looseObject({
  metrics: z.looseObject({ costMicros: z.string().optional() }).optional(),
});

const leadRowSchema = z.looseObject({
  localServicesLead: z.looseObject({
    id: z.string(),
    leadType: z.string().optional(),
    leadStatus: z.string().optional(),
    categoryId: z.string().optional(),
    serviceId: z.string().optional(),
    creationDateTime: z.string().optional(),
    leadCharged: z.boolean().optional(),
    contactDetails: z
      .looseObject({
        phoneNumber: z.string().optional(),
        email: z.string().optional(),
        consumerName: z.string().optional(),
      })
      .optional(),
  }),
});

type LocalServicesCampaign = {
  id: string;
  name: string | null;
  status: string | null;
  budgetAmountMicros: number | null;
  budgetPeriod: string | null;
};

export type LocalServicesLead = {
  id: string;
  leadType: string | null;
  leadStatus: string | null;
  categoryId: string | null;
  serviceId: string | null;
  creationDateTime: string | null;
  charged: boolean;
  consumerName: string | null;
  consumerPhoneNumber: string | null;
  consumerEmail: string | null;
};

type LocalServicesPerformance = {
  currencyCode: string | null;
  customerId: string;
  dateRange: { startDate: string; endDate: string };
  campaigns: LocalServicesCampaign[];
  spendMicros: number;
  leadTotals: {
    total: number;
    charged: number;
    booked: number;
    phoneCalls: number;
    messages: number;
    bookings: number;
    /** The window held more leads than the report counts. Spend stays exact,
     *  so every total here is a floor and cost-per-lead an upper bound. */
    truncated: boolean;
  };
  costPerChargedLeadMicros: number | null;
  pacing: {
    /** Spend over the last 7 account days (today inclusive, UTC-approximate). */
    last7DaysSpendMicros: number;
    /** Sum of enabled campaigns' daily budgets × 7; null when a budget uses a
     *  period this report doesn't normalize. */
    weeklyBudgetMicros: number | null;
    /** last7DaysSpend / weeklyBudget, 0..n, null without a weekly budget. */
    utilization: number | null;
  };
};

function assertReportDate(value: string, label: string): string {
  // Also the GAQL-injection guard: validated dates are interpolated verbatim.
  if (!DATE_PATTERN.test(value)) {
    throw new GoogleAdsReportError(
      "validation_error",
      `${label} must be YYYY-MM-DD.`,
    );
  }
  return value;
}

function mapGoogleAdsError(
  error: unknown,
  context: { report: "performance" | "leads"; projectId: string },
): GoogleAdsReportError {
  if (error instanceof GoogleAdsReportError) return error;
  // Everything past here reaches the user (dashboard card, both MCP tools) as
  // a generic code, so Google's own explanation survives only in this line.
  console.error("google_ads.report_failed", {
    ...context,
    ...errorLogDetails(error),
  });
  if (error instanceof GoogleAdsConfigError) {
    return new GoogleAdsReportError("google_ads_setup_required", error.message);
  }
  if (
    error instanceof GoogleAdsTokenError ||
    (error instanceof GoogleAdsApiError && error.status === 401)
  ) {
    return new GoogleAdsReportError(
      "google_ads_reconnect_required",
      "Google Ads connection expired. Reconnect the Google account.",
    );
  }
  if (error instanceof GoogleAdsApiError) {
    if (isAccessPendingReason(error.upstreamReason)) {
      return new GoogleAdsReportError(
        "google_ads_access_pending",
        error.message,
      );
    }
    if (error.status === 403 || error.status === 404) {
      return new GoogleAdsReportError(
        "google_ads_account_inaccessible",
        error.message,
      );
    }
    if (error.status === 429 || error.upstreamReason === "RESOURCE_EXHAUSTED") {
      return new GoogleAdsReportError(
        "google_ads_quota_exhausted",
        error.message,
      );
    }
    if (error.status === 400) {
      return new GoogleAdsReportError(
        "google_ads_request_rejected",
        "Google Ads rejected this report request. Retrying won't help.",
      );
    }
    return new GoogleAdsReportError(
      "google_ads_upstream_unavailable",
      error.message,
    );
  }
  if (error instanceof z.ZodError) {
    return new GoogleAdsReportError(
      "google_ads_malformed_response",
      "Google Ads returned an invalid reporting response.",
    );
  }
  throw error;
}

function micros(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Today's date in the Ads account's own time zone. Google evaluates
 *  `segments.date` against that zone, so a UTC "today" is already tomorrow for
 *  most of a US business day — the window ends on a day that hasn't happened
 *  and starts a day late, quietly dropping a day of spend. */
function todayInAccountZone(timeZone: string | null): string {
  if (!timeZone) return new Date().toISOString().slice(0, 10);
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    // Intl throws on an unknown zone; a UTC window beats no report.
    return new Date().toISOString().slice(0, 10);
  }
}

/** Calendar arithmetic on an already-zoned date, so a DST boundary inside the
 *  window can't shift it by a day. */
function isoDateBefore(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** The report's default window: the last `REPORT_WINDOW_DAYS` account days,
 *  today included. Callers that don't pin an explicit range get this instead of
 *  computing their own from server UTC. */
function defaultRange(timeZone: string | null): {
  startDate: string;
  endDate: string;
} {
  const endDate = todayInAccountZone(timeZone);
  return { endDate, startDate: isoDateBefore(endDate, REPORT_WINDOW_DAYS - 1) };
}

async function getConnectedClient(projectId: string) {
  const connection =
    await GoogleAdsConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    throw new GoogleAdsReportError(
      "google_ads_not_connected",
      "Google Ads isn't connected for this project.",
    );
  }
  const client = createGoogleAdsClient({
    userId: connection.connectedByUserId,
    googleAdsAccountId: connection.googleAdsAccountId,
  });
  return { connection, client };
}

async function fetchSpendMicros(
  client: ReturnType<typeof createGoogleAdsClient>,
  connection: { customerId: string; loginCustomerId: string | null },
  startDate: string,
  endDate: string,
): Promise<number> {
  const rows = await client.search(
    connection.customerId,
    `SELECT campaign.id, metrics.cost_micros FROM campaign
     WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'
       AND segments.date BETWEEN '${startDate}' AND '${endDate}'`,
    { loginCustomerId: connection.loginCustomerId },
  );
  return rows
    .map((row) => spendRowSchema.parse(row))
    .reduce((sum, row) => sum + micros(row.metrics?.costMicros), 0);
}

async function fetchLeads(
  client: ReturnType<typeof createGoogleAdsClient>,
  connection: { customerId: string; loginCustomerId: string | null },
  input: { startDate: string; endDate: string; limit: number },
): Promise<LocalServicesLead[]> {
  const rows = await client.search(
    connection.customerId,
    // credit_details is PROHIBITED_FIELD_IN_SELECT_CLAUSE in Ads API v25 —
    // credit state isn't readable here until Google makes it selectable.
    `SELECT local_services_lead.id, local_services_lead.lead_type,
            local_services_lead.lead_status, local_services_lead.category_id,
            local_services_lead.service_id, local_services_lead.creation_date_time,
            local_services_lead.lead_charged, local_services_lead.contact_details
     FROM local_services_lead
     WHERE local_services_lead.creation_date_time >= '${input.startDate} 00:00:00'
       AND local_services_lead.creation_date_time <= '${input.endDate} 23:59:59'
     ORDER BY local_services_lead.creation_date_time DESC
     LIMIT ${input.limit}`,
    { loginCustomerId: connection.loginCustomerId },
  );
  return rows
    .map((row) => leadRowSchema.parse(row).localServicesLead)
    .map((lead) => ({
      id: lead.id,
      leadType: lead.leadType ?? null,
      leadStatus: lead.leadStatus ?? null,
      categoryId: lead.categoryId ?? null,
      serviceId: lead.serviceId ?? null,
      creationDateTime: lead.creationDateTime ?? null,
      charged: lead.leadCharged ?? false,
      consumerName: lead.contactDetails?.consumerName ?? null,
      consumerPhoneNumber: lead.contactDetails?.phoneNumber ?? null,
      consumerEmail: lead.contactDetails?.email ?? null,
    }));
}

const MAX_LEADS_FOR_TOTALS = 1_000;

/** Validate a caller-supplied range, or fall back to the account's own last
 *  28 days. Resolving it here is the point: only the connection knows the time
 *  zone Google will read the dates in. */
function resolveRange(
  timeZone: string | null,
  input: { startDate?: string; endDate?: string },
): { startDate: string; endDate: string } {
  if (!input.startDate || !input.endDate) return defaultRange(timeZone);
  const startDate = assertReportDate(input.startDate, "startDate");
  const endDate = assertReportDate(input.endDate, "endDate");
  if (endDate < startDate) {
    throw new GoogleAdsReportError(
      "validation_error",
      "endDate must not be before startDate.",
    );
  }
  return { startDate, endDate };
}

async function getPerformance(input: {
  projectId: string;
  startDate?: string;
  endDate?: string;
}): Promise<LocalServicesPerformance> {
  try {
    const { connection, client } = await getConnectedClient(input.projectId);
    const { startDate, endDate } = resolveRange(connection.timeZone, input);
    const pacingEnd = todayInAccountZone(connection.timeZone);
    const [campaignRows, spendMicros, last7DaysSpendMicros, leads] =
      await Promise.all([
        client.search(
          connection.customerId,
          `SELECT campaign.id, campaign.name, campaign.status,
                  campaign_budget.amount_micros, campaign_budget.period, campaign_budget.type
           FROM campaign
           WHERE campaign.advertising_channel_type = 'LOCAL_SERVICES'`,
          { loginCustomerId: connection.loginCustomerId },
        ),
        fetchSpendMicros(client, connection, startDate, endDate),
        fetchSpendMicros(
          client,
          connection,
          isoDateBefore(pacingEnd, PACING_WINDOW_DAYS - 1),
          pacingEnd,
        ),
        // One over the cap: the extra row is how "exactly 1,000 leads" is told
        // apart from "we stopped at 1,000".
        fetchLeads(client, connection, {
          startDate,
          endDate,
          limit: MAX_LEADS_FOR_TOTALS + 1,
        }),
      ]);

    const campaigns = campaignRows
      .map((row) => campaignRowSchema.parse(row))
      .map((row) => ({
        id: row.campaign.id,
        name: row.campaign.name ?? null,
        status: row.campaign.status ?? null,
        budgetAmountMicros: row.campaignBudget?.amountMicros
          ? micros(row.campaignBudget.amountMicros)
          : null,
        budgetPeriod: row.campaignBudget?.period ?? null,
      }));

    // LSA budgets surface through the API as daily amounts (the UI's weekly
    // budget ÷ 7); only that shape is normalized to a weekly target.
    const enabled = campaigns.filter(
      (campaign) => campaign.status === "ENABLED",
    );
    const budgeted = enabled.filter(
      (campaign) => campaign.budgetAmountMicros !== null,
    );
    const weeklyBudgetMicros =
      budgeted.length > 0 &&
      budgeted.every((campaign) => campaign.budgetPeriod === "DAILY")
        ? budgeted.reduce(
            (sum, campaign) => sum + (campaign.budgetAmountMicros ?? 0),
            0,
          ) * 7
        : null;

    const truncated = leads.length > MAX_LEADS_FOR_TOTALS;
    const counted = truncated ? leads.slice(0, MAX_LEADS_FOR_TOTALS) : leads;
    const leadTotals = {
      total: counted.length,
      charged: counted.filter((lead) => lead.charged).length,
      booked: counted.filter((lead) => lead.leadStatus === "BOOKED").length,
      phoneCalls: counted.filter((lead) => lead.leadType === "PHONE_CALL")
        .length,
      messages: counted.filter((lead) => lead.leadType === "MESSAGE").length,
      bookings: counted.filter((lead) => lead.leadType === "BOOKING").length,
      truncated,
    };

    return {
      currencyCode: connection.currencyCode,
      customerId: connection.customerId,
      dateRange: { startDate, endDate },
      campaigns,
      spendMicros,
      leadTotals,
      costPerChargedLeadMicros:
        leadTotals.charged > 0
          ? Math.round(spendMicros / leadTotals.charged)
          : null,
      pacing: {
        last7DaysSpendMicros,
        weeklyBudgetMicros,
        utilization:
          weeklyBudgetMicros && weeklyBudgetMicros > 0
            ? last7DaysSpendMicros / weeklyBudgetMicros
            : null,
      },
    };
  } catch (error) {
    throw mapGoogleAdsError(error, {
      report: "performance",
      projectId: input.projectId,
    });
  }
}

async function listLeads(input: {
  projectId: string;
  startDate?: string;
  endDate?: string;
  limit: number;
}): Promise<{
  leads: LocalServicesLead[];
  currencyCode: string | null;
  dateRange: { startDate: string; endDate: string };
}> {
  const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 1_000);
  try {
    const { connection, client } = await getConnectedClient(input.projectId);
    const dateRange = resolveRange(connection.timeZone, input);
    const leads = await fetchLeads(client, connection, {
      ...dateRange,
      limit,
    });
    return { leads, currencyCode: connection.currencyCode, dateRange };
  } catch (error) {
    throw mapGoogleAdsError(error, {
      report: "leads",
      projectId: input.projectId,
    });
  }
}

export const LocalServicesReportingService = {
  getPerformance,
  listLeads,
};
