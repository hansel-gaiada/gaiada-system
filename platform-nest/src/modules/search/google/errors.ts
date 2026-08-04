// Search-SPECIFIC Google errors. The OAuth-generic ones moved to core/google-oauth/errors.ts
// (WD-23A-1); these three are about search's own domain — a property binding and the Ads surface — so
// they stay in the module and extend the core base class.
//
// This file is ALSO the compatibility shim: it re-exports the core errors so every existing importer
// (`./errors`) keeps resolving unchanged.
import { GoogleSurfaceError } from "../../../core/google-oauth/errors";

export {
  GoogleSurfaceError,
  GoogleOAuthNotConfiguredError,
  GoogleOAuthStateError,
  GoogleTokenEndpointError,
  GoogleApiError,
  GoogleConnectionNotLinkedError,
} from "../../../core/google-oauth/errors";
export type { StateFailureReason } from "../../../core/google-oauth/errors";

/** The connection exists but is not usable for an authorized call: no sealed access token, no refresh
 *  token to renew with, or a `revoked` status. 409 — the resource is in the wrong STATE, and the fix is
 *  a human re-link rather than a retry. */
/** SM-25b — the property has NO connection bound at all for the requested surface
 *  (`search_properties.gsc_connection_id`/`ga4_connection_id` is NULL). Deliberately a DIFFERENT class
 *  from GoogleConnectionNotLinkedError below: that one means "a connection exists but is unusable"
 *  (dead token, revoked, no refresh token) — a state reachable only AFTER a link was ever attempted;
 *  this one means "nobody has even tried to link this property yet", which the Connections-tab UI and
 *  a future automated-ingestion caller need to tell apart (one says "re-link", the other says "link").
 *  400, not 404: the property itself exists (already resolved by the caller) — what is missing is a
 *  binding on it, which is a request-shape problem ("you asked me to pull for a property with nothing
 *  bound"), not a missing-resource one. */
export class GooglePropertyNotBoundError extends GoogleSurfaceError {
  constructor(propertyId: string, surface: "google_search_console" | "google_analytics" | "google_ads") {
    const label = surface === "google_search_console" ? "Search Console" : surface === "google_analytics" ? "GA4" : "Ads";
    super(400, "google_property_not_bound", `property has no ${label} connection bound — link one first`, {
      propertyId,
      surface,
    });
  }
}

/** SM-25c — the property HAS an Ads connection bound, but that connection has no Ads customer
 *  (account) id linked yet (`integration_connections.external_account` is NULL). Deliberately a
 *  DIFFERENT class from `GooglePropertyNotBoundError`: that one means "link a connection to this
 *  property at all"; this one means "the connection exists and is usable, but nobody has told us
 *  WHICH Ads account under it to query" — a distinct request-shape gap the Connections-tab UI and a
 *  future ingestion caller need to tell apart (one says "authorize Google", the other says "set the
 *  account id"). 400, same reasoning as GooglePropertyNotBoundError: the resource exists, what is
 *  missing is a binding on it. */
export class GoogleAdsCustomerNotLinkedError extends GoogleSurfaceError {
  constructor(connectionId: string) {
    super(
      400,
      "google_ads_customer_not_linked",
      "this Google Ads connection has no customer (account) id linked — link one first " +
        "(PUT .../google/connections/:id/ads-account)",
      { connectionId },
    );
  }
}

/** SM-25c — FAIL-CLOSED: no Ads pull may even be attempted without an approved developer token
 *  (config.search.google.adsDeveloperToken). Mirrors GoogleOAuthNotConfiguredError's reasoning
 *  exactly, transposed to the one Ads-only prerequisite: a real Ads call is refused by Google outright
 *  without one (UNVERIFIED — SM-41G — but the config seam's own comment already states the AC this
 *  error implements: "empty => the Ads surface refuses rather than half-working"). A deployment
 *  state, never a caller error and never a crash — checked BEFORE any DB read or network call. */
export class GoogleAdsNotConfiguredError extends GoogleSurfaceError {
  constructor() {
    super(
      503,
      "google_ads_not_configured",
      "Google Ads is not configured: set GOOGLE_ADS_DEVELOPER_TOKEN (a Google-approved developer " +
        "token) before pulling Ads data. No Ads read can be attempted until it is set.",
    );
  }
}
