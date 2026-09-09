import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  CardShell,
  moreDetailsClass,
  Stat,
} from "@/client/features/dashboard/cardParts";
import { getLocalServicesDashboardReport } from "@/serverFunctions/google-ads";

function money(microsValue: number | null | undefined): string {
  if (typeof microsValue !== "number") return "—";
  return `$${(microsValue / 1_000_000).toFixed(2)}`;
}

/** Rendered only when the Google Ads connection exists; the connect flow
 *  lives on the integrations settings page, not the dashboard. */
export function LocalServicesCard({ projectId }: { projectId: string }) {
  const reportQuery = useQuery({
    queryKey: ["dashboardLocalServicesReport", projectId],
    queryFn: () => getLocalServicesDashboardReport({ data: { projectId } }),
  });
  const report = reportQuery.data;

  return (
    <CardShell
      title="Local Services Ads"
      stamp="Google Ads · last 28 days"
      action={
        <Link
          to="/p/$projectId/settings/integrations"
          params={{ projectId }}
          hash="google-ads"
          className={moreDetailsClass}
        >
          Manage
        </Link>
      }
    >
      {reportQuery.isPending ? (
        <div className="grid grid-cols-2 gap-3" aria-busy>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-20" />
          ))}
        </div>
      ) : reportQuery.isError ? (
        <p className="text-sm text-base-content/60">
          Couldn&rsquo;t load Local Services data. Try again shortly.
        </p>
      ) : report?.connected &&
        "accessPending" in report &&
        report.accessPending ? (
        <p className="text-sm text-base-content/60">
          Waiting on Google&rsquo;s Ads API access approval. Data appears here
          automatically once Google finishes onboarding.
        </p>
      ) : report?.connected && report.performance ? (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Spend" value={money(report.performance.spendMicros)} />
          <Stat
            label="Leads"
            value={`${report.performance.leadTotals.total}`}
            sub={
              <span className="text-xs text-base-content/50">
                {report.performance.leadTotals.charged} charged ·{" "}
                {report.performance.leadTotals.booked} booked
              </span>
            }
          />
          <Stat
            label="Cost / charged lead"
            value={money(report.performance.costPerChargedLeadMicros)}
          />
          <Stat
            label="7-day pacing"
            value={
              report.performance.pacing.utilization === null
                ? "—"
                : `${Math.round(report.performance.pacing.utilization * 100)}%`
            }
            sub={
              <span className="text-xs text-base-content/50">
                {money(report.performance.pacing.last7DaysSpendMicros)} of{" "}
                {money(report.performance.pacing.weeklyBudgetMicros)}/wk
              </span>
            }
          />
        </div>
      ) : (
        <p className="text-sm text-base-content/60">
          The Google Ads connection needs attention.{" "}
          <Link
            to="/p/$projectId/settings/integrations"
            params={{ projectId }}
            hash="google-ads"
            className="link"
          >
            Reconnect
          </Link>
        </p>
      )}
    </CardShell>
  );
}
