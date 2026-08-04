// SM-25a — the OAuth token/revocation endpoint client. ONE of the two new egress files in this module
// (design addendum §A12.1: "Reached ONLY via module-internal clients in `modules/search/google/`", added
// to §6e's egress-inventory set-equality pin DELIBERATELY, by exact filename).
//
// ── WHY THIS IS NOT A `SearchDataProvider` AND NEVER GOES THROUGH `dispatchProviderOp` (§A12.1) ────
// §A5's B-1 rule ("vendor SEO APIs only via SearchDataProvider through dispatchProviderOp") exists
// because that spend is SHARED, METERED and CACHED CROSS-TENANT — the dispatch choke-point is a MONEY
// choke-point. Google client-account access is different on every axis that motivated B-1:
// client-private, $0-API-billed, per-client-OAuth. There are no dollars to meter, so routing it through
// the ledger would invent synthetic cost figures and pollute §A3's cost-to-serve meaning. The bounding
// resource here is Google QUOTA, which is a per-op row/page cap in each consuming ticket's AC, not a
// budget tier. Equally binding: nothing here may write `search_data_cache` — that table is no-RLS
// shared market data by design (D-4), so client-private Search Console rows in it would be a
// cross-tenant leak BY CONSTRUCTION.
//
// ── WHAT A GREEN TEST OF THIS FILE MEANS (§A12.5, binding sentence) ───────────────────────────────
// A green sandbox / Keycloak harness is a validated client of OUR OWN MODEL OF GOOGLE, not a validated
// Google integration. What this file's tests DO establish: that our form encoding, client
// authentication, PKCE verifier submission, rotation handling and RFC-7009 revocation travel correctly
// over a real socket and that our parser reads a real response body. What they CANNOT establish, and
// what SM-41G exists for: whether Google accepts our serialized requests at all; the consent screen,
// incremental consent and scope-grant semantics; refresh-token longevity under the OAuth app's publish
// status (Testing-mode refresh tokens expire in 7 days — a production-behaviour fact no local issuer
// can rehearse); Google-side revocation behaviour; and quota/429 handling.
//
// ── SECRET DISCIPLINE ─────────────────────────────────────────────────────────────────────────────
// No function here logs, echoes, or returns a request body. The bodies contain `client_secret`,
// `code_verifier`, `refresh_token` and `code`. Error paths surface the HTTP status and the OAuth
// `error` CODE only (never `error_description`, which some issuers echo request material into) — see
// GoogleTokenEndpointError.
import { config } from "../../config";
import { GoogleOAuthNotConfiguredError, GoogleTokenEndpointError } from "./errors";
import { isGoogleHost } from "./hosts";

/** Injectable for tests, matching the vendor drivers' `fetchImpl` convention. Defaults to global
 *  fetch; SM-51's sandbox is exercised by pointing the CONFIG at it instead, so the real default
 *  path — real sockets, real header serialization — is what runs. */
export type FetchImpl = typeof fetch;

export interface TokenResponse {
  accessToken: string;
  /** Absolute expiry computed from `expires_in` at receipt. Null when the issuer omitted it. */
  expiresAt: string | null;
  /** Present on the authorization-code exchange; on REFRESH it is present only if the issuer rotates
   *  (Keycloak does by default; whether Google does is an SM-41G fact — see persistence note in
   *  oauth.ts, which COALESCEs so a missing rotation keeps the existing refresh token). */
  refreshToken: string | null;
  /** The scopes the issuer says were actually granted — which may be NARROWER than requested. Google's
   *  scope-grant semantics are an SM-41G clause; we record what we are told and never assume. */
  scope: string | null;
  tokenType: string | null;
}

interface RawTokenBody {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
  error?: string;
}

function requireOAuthClient(): { clientId: string; clientSecret: string } {
  const g = config.google;
  const missing: string[] = [];
  if (!g.clientId) missing.push("GOOGLE_OAUTH_CLIENT_ID");
  if (!g.clientSecret) missing.push("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!g.redirectUri) missing.push("GOOGLE_OAUTH_REDIRECT_URI");
  if (missing.length) throw new GoogleOAuthNotConfiguredError(missing);
  return { clientId: g.clientId, clientSecret: g.clientSecret };
}

async function postForm(
  url: string,
  form: Record<string, string>,
  operation: "exchange" | "refresh" | "revoke",
  fetchImpl?: FetchImpl,
): Promise<{ status: number; body: RawTokenBody; text: string }> {
  // THE ONE BARE `fetch` REFERENCE IN THIS FILE, and one of only two in the whole module (the other is
  // api-client.ts) — which is exactly what §6e's egress-inventory set-equality pin asserts. Callers pass
  // `fetchImpl` through as OPTIONAL and never default it themselves, so oauth.ts (the orchestrator) holds
  // no network primitive at all and the inventory stays a complete, deliberate list of two files.
  const doFetch = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.google.timeoutMs);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: RawTokenBody = {};
    try {
      body = text ? (JSON.parse(text) as RawTokenBody) : {};
    } catch {
      // A non-JSON body from a token endpoint is itself a protocol failure. Google's /revoke answers
      // an EMPTY body on success, which is why an empty string is tolerated above but a malformed
      // non-empty one is not.
      if (res.ok && operation === "revoke") body = {};
      else throw new GoogleTokenEndpointError(operation, res.status, "non_json_response");
    }
    return { status: res.status, body, text };
  } catch (err) {
    if (err instanceof GoogleTokenEndpointError) throw err;
    // A timeout/DNS/socket failure is an upstream failure, reported as one. `err` is deliberately NOT
    // interpolated: an AbortError message is safe, but a fetch failure cause can carry the full URL,
    // and these URLs are configuration, not caller input.
    throw new GoogleTokenEndpointError(operation, 0, controller.signal.aborted ? "timeout" : "network_error");
  } finally {
    clearTimeout(timer);
  }
}

function toTokenResponse(body: RawTokenBody, operation: "exchange" | "refresh", status: number): TokenResponse {
  if (!body.access_token) throw new GoogleTokenEndpointError(operation, status, body.error ?? "missing_access_token");
  return {
    accessToken: body.access_token,
    expiresAt: typeof body.expires_in === "number" ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
    refreshToken: body.refresh_token ?? null,
    scope: body.scope ?? null,
    tokenType: body.token_type ?? null,
  };
}

/** Authorization-code → tokens (RFC 6749 §4.1.3 + RFC 7636 §4.5). `client_secret_post` form, which is
 *  what Google documents for a web-server (confidential) client and what Keycloak's `google-dev` realm
 *  client is provisioned to accept. */
export async function exchangeAuthorizationCode(
  params: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl?: FetchImpl,
): Promise<TokenResponse> {
  const { clientId, clientSecret } = requireOAuthClient();
  const { status, body } = await postForm(
    config.google.tokenUrl,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
    },
    "exchange",
    fetchImpl,
  );
  if (status >= 400) throw new GoogleTokenEndpointError("exchange", status, body.error ?? null);
  return toTokenResponse(body, "exchange", status);
}

/** Refresh (RFC 6749 §6). ROTATION IS HANDLED BY THE CALLER, not assumed here: this returns whatever
 *  the issuer sent, and oauth.ts persists a new refresh token when one arrives while keeping the
 *  existing one when it does not. Both behaviours are real — Keycloak rotates by default; Google
 *  historically does not, and its actual behaviour is an SM-41G observation, not a fact we encode. */
export async function refreshAccessToken(refreshToken: string, fetchImpl?: FetchImpl): Promise<TokenResponse> {
  const { clientId, clientSecret } = requireOAuthClient();
  const { status, body } = await postForm(
    config.google.tokenUrl,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
    "refresh",
    fetchImpl,
  );
  if (status >= 400) throw new GoogleTokenEndpointError("refresh", status, body.error ?? null);
  return toTokenResponse(body, "refresh", status);
}

/** RFC 7009 token revocation.
 *
 *  THE CLIENT-AUTH BRANCH IS DELIBERATE AND IS THE ONE PLACE THIS FILE VARIES BY ISSUER. RFC 7009 §2.1
 *  requires a CONFIDENTIAL client to authenticate at the revocation endpoint, and Keycloak enforces
 *  exactly that. Google documents its own `/revoke` as taking a bare `token=` body and says nothing
 *  about client credentials. Rather than guess which side to break, the body carries client credentials
 *  ONLY when the configured revoke endpoint is NOT a Google host — so the Google path sends exactly
 *  Google's documented body, and the local-issuer path sends what the RFC requires.
 *
 *  UNVERIFIED (SM-41G): Google's real revocation behaviour — the status for an already-revoked or
 *  unknown token, and whether revoking an access token also invalidates the refresh token (Google's
 *  docs say revoking either revokes the grant; that is a documented claim we have not observed).
 *  `NOT_FOUND_IS_SUCCESS` below encodes the RFC's own guidance, not an observation of Google. */
export async function revokeToken(token: string, fetchImpl?: FetchImpl): Promise<{ revoked: boolean; status: number }> {
  const g = config.google;
  const form: Record<string, string> = { token };
  if (!isGoogleHost(g.revokeUrl)) {
    const { clientId, clientSecret } = requireOAuthClient();
    form.client_id = clientId;
    form.client_secret = clientSecret;
  }
  const { status, body } = await postForm(g.revokeUrl, form, "revoke", fetchImpl);
  // RFC 7009 §2.2: "the authorization server responds with HTTP 200 ... if the token is invalid ... the
  // server responds with 200 as well" — an already-dead token is a SUCCESSFUL revocation from the
  // client's point of view, and treating it as an error would make our own local revoke un-retryable.
  // A 400 `invalid_token` is therefore accepted as revoked; any other 4xx/5xx is a genuine refusal.
  if (status === 200) return { revoked: true, status };
  if (status === 400 && (body.error === "invalid_token" || body.error === undefined)) return { revoked: true, status };
  throw new GoogleTokenEndpointError("revoke", status, body.error ?? null);
}

/** The authorize-URL builder (RFC 6749 §4.1.1 + Google's own documented params). Pure — no egress —
 *  but it lives here so every OAuth-protocol parameter name in this module is in ONE file.
 *
 *  `access_type=offline` + `prompt=consent` are Google-specific and are what make a refresh token
 *  arrive at all; both are harmless extras to Keycloak (unknown params are ignored per RFC 6749 §3.1),
 *  which is why the same builder serves the dev issuer without a branch. */
export function buildAuthorizeUrl(params: {
  scopes: string[];
  state: string;
  codeChallenge: string;
  redirectUri: string;
  /** Google-only hint; omitted when empty. */
  loginHint?: string | null;
}): string {
  const { clientId } = requireOAuthClient();
  const url = new URL(config.google.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Ask for a refresh token, and ask the consent screen to re-appear so one is actually re-issued on a
  // re-link. UNVERIFIED (SM-41G): whether Google re-issues a refresh token on every consent, and how
  // incremental consent interacts with `include_granted_scopes`, which we deliberately do not send.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  if (params.loginHint) url.searchParams.set("login_hint", params.loginHint);
  return url.toString();
}
