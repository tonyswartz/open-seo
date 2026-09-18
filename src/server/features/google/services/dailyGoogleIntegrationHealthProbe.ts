import { db } from "@/db";
import { ga4Connections, googleAdsConnections, gscConnections } from "@/db/schema";
import { GA4_OAUTH_PROVIDER_ID, GA4_OAUTH_SCOPES } from "@/shared/ga4";
import {
  GOOGLE_ADS_OAUTH_PROVIDER_ID,
  GOOGLE_ADS_OAUTH_SCOPES,
} from "@/shared/google-ads";
import { GSC_OAUTH_PROVIDER_ID, GSC_OAUTH_SCOPES } from "@/shared/gsc";
import { probeAndRecordRefreshHealth } from "@/server/features/google/services/GoogleIntegrationTokenHealthService";

type ProbeTarget = {
  integration: "google_ads" | "gsc" | "ga4";
  providerId: string;
  projectId: string;
  connectedByUserId: string;
  accountId: string | null;
  scopeSet: string[];
};

function buildTargets(input: {
  ads: Array<typeof googleAdsConnections.$inferSelect>;
  gsc: Array<typeof gscConnections.$inferSelect>;
  ga4: Array<typeof ga4Connections.$inferSelect>;
}): ProbeTarget[] {
  return [
    ...input.ads.map((connection) => ({
      integration: "google_ads" as const,
      providerId: GOOGLE_ADS_OAUTH_PROVIDER_ID,
      projectId: connection.projectId,
      connectedByUserId: connection.connectedByUserId,
      accountId: connection.googleAdsAccountId,
      scopeSet: [...GOOGLE_ADS_OAUTH_SCOPES],
    })),
    ...input.gsc.map((connection) => ({
      integration: "gsc" as const,
      providerId: GSC_OAUTH_PROVIDER_ID,
      projectId: connection.projectId,
      connectedByUserId: connection.connectedByUserId,
      accountId: connection.gscAccountId ?? null,
      scopeSet: [...GSC_OAUTH_SCOPES],
    })),
    ...input.ga4.map((connection) => ({
      integration: "ga4" as const,
      providerId: GA4_OAUTH_PROVIDER_ID,
      projectId: connection.projectId,
      connectedByUserId: connection.connectedByUserId,
      accountId: connection.ga4AccountId,
      scopeSet: [...GA4_OAUTH_SCOPES],
    })),
  ];
}

export async function runDailyGoogleIntegrationHealthProbe() {
  const [ads, gsc, ga4] = await Promise.all([
    db.select().from(googleAdsConnections),
    db.select().from(gscConnections),
    db.select().from(ga4Connections),
  ]);
  const targets = buildTargets({ ads, gsc, ga4 });

  let failures = 0;
  let alerts = 0;
  for (const target of targets) {
    const result = await probeAndRecordRefreshHealth({
      integration: target.integration,
      providerId: target.providerId,
      projectId: target.projectId,
      connectedByUserId: target.connectedByUserId,
      accountId: target.accountId,
    });
    if (result.healthy) continue;
    failures += 1;
    if (result.consecutiveFailures < 2) continue;
    alerts += 1;
    console.error("google_integration.health_alert", {
      integration: target.integration,
      projectId: target.projectId,
      providerId: target.providerId,
      accountId: target.accountId,
      scopeSet: target.scopeSet,
      consecutiveFailures: result.consecutiveFailures,
    });
  }

  console.log("google_integration.health_probe_summary", {
    targets: targets.length,
    failures,
    alerts,
  });
}
