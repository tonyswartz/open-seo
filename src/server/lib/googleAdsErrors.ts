export class GoogleAdsApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Google error detail code, e.g. "DEVELOPER_TOKEN_NOT_APPROVED". */
    public readonly upstreamReason: string | null = null,
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

export class GoogleAdsTokenError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoogleAdsTokenError";
  }
}

/** GOOGLE_ADS_DEVELOPER_TOKEN is not configured on this deployment. */
export class GoogleAdsConfigError extends Error {
  constructor() {
    super("Google Ads is not configured. Set GOOGLE_ADS_DEVELOPER_TOKEN.");
    this.name = "GoogleAdsConfigError";
  }
}

type GoogleAdsReportErrorCode =
  | "validation_error"
  | "google_ads_not_connected"
  | "google_ads_setup_required"
  | "google_ads_reconnect_required"
  // Developer token awaiting Google approval, or the Ads API not yet enabled
  // on the OAuth client's Cloud project — expected until onboarding finishes.
  | "google_ads_access_pending"
  | "google_ads_account_inaccessible"
  | "google_ads_quota_exhausted"
  | "google_ads_upstream_unavailable"
  | "google_ads_malformed_response";

export class GoogleAdsReportError extends Error {
  constructor(
    public readonly code: GoogleAdsReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GoogleAdsReportError";
  }
}
