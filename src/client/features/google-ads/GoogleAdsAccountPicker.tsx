export type AccountSelection = { accountId: string; customerId: string };

type GrantAccounts = {
  accountId: string;
  email: string | null;
  requiresReconnect: boolean;
  accessPending: boolean;
  accountsUnavailable: boolean;
  accounts: Array<{
    customerId: string;
    loginCustomerId: string | null;
    descriptiveName: string | null;
    currencyCode: string | null;
    hasLocalServicesCampaigns: boolean;
    isSelected: boolean;
  }>;
};

export function GoogleAdsAccountPicker({
  loading,
  error,
  grants,
  selection,
  onSelect,
  onSave,
  saving,
  onRetry,
  onCancel,
  onReconnect,
}: {
  loading: boolean;
  error: boolean;
  grants: GrantAccounts[];
  selection: AccountSelection | null;
  onSelect: (selection: AccountSelection) => void;
  onSave: () => void;
  saving: boolean;
  onRetry: () => void;
  onCancel?: () => void;
  onReconnect: () => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-base-content/50">
        <span className="loading loading-spinner loading-sm" />
        Loading Google Ads accounts…
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-base-content/70">
          Could not load Google Ads accounts.
        </p>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    );
  }
  const accessPending = grants.some((grant) => grant.accessPending);
  const requiresReconnect = grants.some((grant) => grant.requiresReconnect);
  const accountsUnavailable = grants.some((grant) => grant.accountsUnavailable);
  const candidates = grants.flatMap((grant) =>
    grant.accounts.map((candidate) => ({ grant, candidate })),
  );
  return (
    <div className="space-y-4 text-sm">
      {accessPending ? (
        <div className="alert alert-warning items-start text-sm">
          <p>
            Google Ads API access is still pending on Google&apos;s side
            (developer token approval or API enablement). Account listing will
            work once Google finishes onboarding — no changes needed here.
          </p>
        </div>
      ) : null}
      {requiresReconnect ? (
        <div className="space-y-2">
          <p className="text-base-content/70">
            The Google Ads connection expired. Reconnect to continue.
          </p>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onReconnect}
          >
            Reconnect with Google
          </button>
        </div>
      ) : null}
      {candidates.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-base-content/45">
            Choose the Ads account with your Local Services campaigns
          </legend>
          {candidates.map(({ grant, candidate }) => {
            const checked =
              selection?.accountId === grant.accountId &&
              selection.customerId === candidate.customerId;
            return (
              <label
                key={`${grant.accountId}:${candidate.customerId}`}
                className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${checked ? "border-primary bg-primary/5" : "border-base-300"}`}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <input
                    type="radio"
                    name="google-ads-account"
                    className="radio radio-sm radio-primary"
                    checked={checked}
                    onChange={() =>
                      onSelect({
                        accountId: grant.accountId,
                        customerId: candidate.customerId,
                      })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {candidate.descriptiveName ?? candidate.customerId}
                    </span>
                    <span className="block truncate text-xs text-base-content/50">
                      ID {candidate.customerId}
                      {grant.email ? ` · ${grant.email}` : ""}
                    </span>
                  </span>
                </span>
                {candidate.hasLocalServicesCampaigns ? (
                  <span className="shrink-0 rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
                    Local Services
                  </span>
                ) : null}
              </label>
            );
          })}
        </fieldset>
      ) : !accessPending && !requiresReconnect ? (
        <div className="space-y-2">
          <p className="text-base-content/70">
            No Google Ads accounts found on the connected Google account.
            {accountsUnavailable
              ? " This usually means the Google Ads permission was left unchecked on Google's consent screen."
              : " If this is the wrong Google account, reconnect and pick another."}
          </p>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={onReconnect}
          >
            Reconnect with Google
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={onSave}
          disabled={!selection || saving}
        >
          {saving ? "Saving…" : "Use this account"}
        </button>
        {onCancel ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onCancel}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
