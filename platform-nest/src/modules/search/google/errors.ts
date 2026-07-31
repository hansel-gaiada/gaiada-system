// SM-25a — the Google/OAuth domain error family (design addendum §A12).
//
// WHY A FAMILY WITH A SHARED BASE CLASS, AND WHY IT IS MAPPED IN THE SAME DIFF THAT INTRODUCES IT:
// this module has now shipped the SAME bug twice — a plain `Error` thrown from a service layer,
// invisible to `HttpErrorFilter` (`@Catch(HttpException)`), surfacing as a MESSAGE-LESS 500 that
// discards the human-actionable part the refusal exists for. SM-53 fixed it for
// `ProviderDispatchError`; SM-57 fixed it again for `GatewayNotConfiguredError`; SM-58 added the
// app-wide `LastResortExceptionFilter` backstop underneath both. A third instance would be a
// self-inflicted repeat, so every error below descends from ONE base class and
// `GoogleOAuthErrorFilter` (google-oauth-error.filter.ts) maps that base class to an honest status +
// a stable `code` discriminator. Adding a new error here means adding a `status` — the compiler
// requires it (the constructor takes it), so a new unmapped error is not expressible.
//
// STATUS CHOICES, stated so nobody "tidies" them:
//   * 503 not-configured — a DEPLOYMENT state, not a caller error and not a crash. Identical
//     reasoning to SM-57's 503 for an unconfigured AI gateway: the module failed CLOSED on purpose.
//   * 400 for a bad/forged/expired/replayed callback — the request itself is unusable. Deliberately
//     NOT 403: a 403 implies "you are known and refused", while a state that does not verify tells us
//     nothing about who is calling. The message is intentionally coarse for the same reason (see
//     GoogleOAuthStateError).
//   * 502 for an issuer/API refusal — the upstream said no. Our request may still be wrong (that is
//     exactly what SM-41G exists to find out against real Google), but the failure arrived from
//     across a network boundary, so attributing it to the caller would be a lie.
//   * 409 for a connection that is not linked / has no refresh token — the resource is in the wrong
//     state for the operation, and the fix is a human re-link, not a retry.

/** Base class for every Google-surface refusal. `status` is what GoogleOAuthErrorFilter sends; `code`
 *  is the stable machine discriminator a caller (UI Connections tab, SM-25b/c ingestion jobs) branches
 *  on. Both are set at construction — an error in this family cannot exist without a mapping. */
export abstract class GoogleSurfaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Optional non-secret detail surfaced alongside the message (never token material, never a
     *  client secret, never a code_verifier — see the redaction note in token-endpoint-client.ts). */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** FAIL-CLOSED: the Google OAuth client is not configured (GOOGLE_OAUTH_CLIENT_ID /
 *  GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REDIRECT_URI). Deliberately mirrors
 *  `GatewayNotConfiguredError`'s spirit and status: a deployment state, surfaced honestly, never a
 *  silent half-attempt against a phantom endpoint. */
export class GoogleOAuthNotConfiguredError extends GoogleSurfaceError {
  constructor(missing: string[] = []) {
    super(
      503,
      "google_oauth_not_configured",
      "Google OAuth is not configured: set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, " +
        "GOOGLE_OAUTH_REDIRECT_URI and INTEGRATION_TOKEN_KEY (the credential-vault key that seals " +
        "tokens at rest and signs the OAuth `state` parameter). Locally these may point at the " +
        "Keycloak `google-dev` realm client — see docs/runbooks/idp-keycloak.md. No Search Console / " +
        "GA4 / Ads connection can be created or refreshed until they are set.",
      missing.length ? { missing } : undefined,
    );
  }
}

/** The callback's `state` did not verify: bad signature, unknown/expired row, already consumed
 *  (replay), a redirect_uri that does not match the one the authorization request was issued for, or a
 *  principal that is not the one who started the flow.
 *
 *  THE MESSAGE IS DELIBERATELY COARSE. The caller learns "this callback is not usable" and nothing
 *  more; the specific reason goes to the server-side `detail` field ONLY as a short enum-ish token
 *  (never the presented state, never the stored verifier), because distinguishing "unknown state" from
 *  "expired state" from "wrong user" for an unauthenticated-ish redirect endpoint is a free oracle for
 *  someone probing the callback. See google-oauth.controller.ts's attack list. */
export class GoogleOAuthStateError extends GoogleSurfaceError {
  constructor(reason: StateFailureReason) {
    super(400, "google_oauth_invalid_state", "the OAuth callback could not be verified — start the connection flow again", {
      reason,
    });
  }
}

/** The closed set of reasons a callback is refused — every one of them produces the SAME coarse
 *  client-facing message and status (see GoogleOAuthStateError). Enumerated as a type so the callback
 *  path cannot invent an unlogged refusal reason. */
export type StateFailureReason =
  | "malformed_state"
  | "bad_signature"
  | "unknown_or_expired"
  | "already_consumed"
  | "redirect_uri_mismatch"
  | "principal_mismatch"
  | "provider_mismatch"
  | "issuer_error";

/** The issuer's token endpoint refused the exchange/refresh, or answered something we cannot use. */
export class GoogleTokenEndpointError extends GoogleSurfaceError {
  constructor(operation: "exchange" | "refresh" | "revoke", httpStatus: number, oauthError: string | null) {
    super(
      502,
      "google_token_endpoint_error",
      `the Google OAuth token endpoint refused the ${operation} (HTTP ${httpStatus}` +
        `${oauthError ? `, error='${oauthError}'` : ""})`,
      { operation, httpStatus, oauthError },
    );
  }
}

/** A Google API surface (Search Console / GA4 / Ads) refused an authorized request even after a
 *  refresh attempt. Carries the surface + HTTP status so SM-25b/c ingestion can branch (and so a 429
 *  is visibly distinguishable from a 403 — though what real Google actually returns under quota
 *  pressure is an SM-41G fact, NOT something a local harness establishes). */
export class GoogleApiError extends GoogleSurfaceError {
  constructor(surface: string, httpStatus: number, detailText?: string) {
    super(502, "google_api_error", `the Google ${surface} API refused the request (HTTP ${httpStatus})`, {
      surface,
      httpStatus,
      ...(detailText ? { upstream: detailText.slice(0, 400) } : {}),
    });
  }
}

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

export class GoogleConnectionNotLinkedError extends GoogleSurfaceError {
  constructor(
    connectionId: string,
    /** `grant_invalid` is the issuer's `invalid_grant` on refresh — the grant no longer exists on
     *  Google's side. It is deliberately NOT a `GoogleTokenEndpointError` (502): 502 would say "Google
     *  is broken" when the truth is "this connection must be re-authorized by a human", and it is the
     *  single most likely real-world state — it is what a user revoking access in their Google account
     *  produces, AND what a Testing-mode app's 7-day refresh-token expiry produces (SM-41G's clause).
     *  Sending someone to debug the network for that would be a lie with a cost. */
    why: "no_access_token" | "no_refresh_token" | "revoked" | "not_found" | "grant_invalid",
  ) {
    super(409, "google_connection_not_linked", `the Google connection is not usable (${why}) — re-link it to continue`, {
      connectionId,
      why,
    });
  }
}
