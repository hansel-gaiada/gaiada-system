// SM-51 — the GOOGLE-surface sandbox: a STATEFUL OAuth issuer (authorize / token / rotate / revoke) plus
// Search Console, GA4 Data and Google Ads read+mutate envelopes (tracker §6x.3; design addendum §A12).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE BINDING SENTENCE, FIRST, BECAUSE EVERYTHING BELOW IS SUBORDINATE TO IT (§A12.5):
//   A green Google sandbox / local-issuer harness is a validated client of OUR OWN MODEL OF GOOGLE,
//   NOT a validated Google integration.
// Fixture and parser agree BY CONSTRUCTION (§4i at the vendor boundary). What this harness genuinely
// buys is a changed failure profile for SM-41G: defects surviving to staging should be wrong GOOGLE
// FACTS, not broken plumbing. Explicitly NOT established by any green run of this file — every one of
// these is an SM-41G clause:
//   * Google's consent screen, incremental consent, and what a scope STRING actually grants.
//   * refresh-token longevity under the OAuth app's publish status (a Testing-mode app's refresh
//     tokens expire in 7 days — a production-behaviour fact no local issuer can rehearse).
//   * Google-side revocation behaviour (whether revoking one token ends the whole grant, and what a
//     second revoke returns).
//   * quota / 429 / Retry-After behaviour.
//   * the Ads developer-token approval + MCC / login-customer-id semantics.
//   * whether real Google accepts our serialized requests AT ALL.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// ── A TEST-HARNESS FIXTURE, NEVER A DEPLOYABLE ENVIRONMENT (§A10.2, verbatim; §6x.3 ruling 1) ─────
// Every instance is created inside a test file's `beforeAll` via `startGoogleSandbox()`, listens on
// `127.0.0.1` at an EPHEMERAL port (`:0`), and is torn down via its returned `close()`. No compose
// service, no Dockerfile, no published port, no long-lived process, no boot registration — nothing here
// is reachable outside a test run, and nothing under `src/modules/search/` or `main.ts` imports it.
//
// PROVENANCE IS AUDIENCE, NOT LABEL (§A10.2 / §A12.2): rows minted while driving this sandbox live only
// in throwaway per-file test databases. That is what makes them honest, not a flag on the row. The
// connection rows this sandbox's tokens produce additionally carry their ISSUER HOST
// (`meta.googleIssuerHost`) and the in-flight state row carries `simulated = true`, because the sandbox
// origin is not a Google host (google-hosts.ts) — so even inside a test DB the rows say what they are.
// And §A10.4's boot guard, extended to the Google seams (modules/search/google/endpoint-guard.ts),
// refuses to BOOT a live deployment pointed at a loopback issuer, so there is nothing to point at in a
// real environment even if someone tried.
//
// ── WHY A SEPARATE `startGoogleSandbox()` RATHER THAN A BRANCH INSIDE server.ts ───────────────────
// Same directory, same lifecycle contract, same fixture discipline, same per-instance-closure state
// rule — the SM-49 pattern is extended, not replaced. What is deliberately not shared is the entry
// point: `startVendorSandbox()` REQUIRES `VendorSandboxCredentials` for three market-data vendors, and
// a Search Console test has no business supplying a DataForSEO login. Keeping them separate also keeps
// §A12's third-egress-class boundary legible in the harness itself: the money path and the
// client-private path are different servers with different credential models. The handful of tiny HTTP
// helpers below are duplicated from server.ts on purpose — extracting them would churn a just-landed
// file that is under a QA gate, for the sake of ~30 lines.
//
// ── STRICTNESS OVER MOCKS (§A10.5, AC 11 transposed) ─────────────────────────────────────────────
// This is a real listening socket with its own routing table and its own validation:
//   * an unknown path 404s in Google's error envelope — it is never treated as a near-miss;
//   * the token endpoint enforces CLIENT AUTHENTICATION, single-use authorization codes, redirect-URI
//     equality, and real PKCE S256 verification (it computes the challenge from the presented verifier
//     and compares) — a client that sends no verifier, a wrong verifier, or a re-used code is REFUSED
//     here, at the wire, where a per-test mock would have cheerfully returned a token;
//   * every data surface requires a live, unexpired, unrevoked Bearer token that THIS machine issued,
//     so "the client attached the header" and "the client attached a valid credential" are separable;
//   * required request fields are checked in Google's own shape (a searchAnalytics query with no
//     startDate gets a 400 INVALID_ARGUMENT, not a fixture).
//
// FIXTURE-FILE-DRIVEN (§A10.6): every response body is built from an imported `fixtures/google/**`
// file, never an inline literal, so SM-41G's recorded envelopes drop in as replacement fixtures with
// zero change to this file.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { tokenResponseBody } from "./fixtures/google/token-response";
import { tokenErrorBody, type OAuthErrorCode } from "./fixtures/google/token-error";
import { apiErrorBody, NOT_FOUND_BODY, RESOURCE_EXHAUSTED_BODY, UNAUTHENTICATED_BODY } from "./fixtures/google/api-error";
import { DEFAULT_GSC_SITES, gscSitesBody, type GscSiteEntry } from "./fixtures/google/gsc-sites";
import {
  deterministicRows,
  gscSearchAnalyticsBody,
  type GscAnalyticsRow,
} from "./fixtures/google/gsc-search-analytics";
import { defaultGa4Report } from "./fixtures/google/ga4-run-report";
import { defaultAdsSearch } from "./fixtures/google/ads-search";
import { adsMutateBody } from "./fixtures/google/ads-mutate";

/** Put this substring in a requested SCOPE to make the fake consent step DENY (an `access_denied` error
 *  redirect). Same "the subject string selects the behaviour" convention SM-49 uses — no side channel.
 *  NOTE: this models an error REDIRECT, not Google's consent UI, which is an SM-41G clause. */
export const GOOGLE_SANDBOX_DENY_SCOPE_MARKER = "sm51-deny";
/** Put this in a site URL / property id / customer id to force that surface to answer 429. Present so a
 *  future quota ticket has something to drive; it does NOT establish that Google emits 429. */
export const GOOGLE_SANDBOX_QUOTA_MARKER = "sm51-quota";
/** Force a surface to answer 404 NOT_FOUND for an unknown site/property/customer. */
export const GOOGLE_SANDBOX_NOTFOUND_MARKER = "sm51-notfound";
/** SM-26 (tracker §6bp Ruling 6) — put this in a mutate operation's JSON body (e.g. a keyword `text`)
 *  to make that PARTICULAR operation's result carry no `resourceName`, with a `partialFailureError`
 *  attached to the response — models Ruling 6.3's PER-ROW failure inside an otherwise correctly-sized
 *  response (never an addressing failure: the result COUNT still matches the operation count). */
export const GOOGLE_SANDBOX_ADS_MUTATE_ROW_FAIL_MARKER = "sm51-ads-row-fail";
/** SM-26 — put this in ANY mutate operation's JSON body to make the WHOLE response for that call come
 *  back with one FEWER result than operations sent — models Ruling 6.3's count/shape mismatch, which
 *  impeaches the whole execution's addressing (never a per-row concern). */
export const GOOGLE_SANDBOX_ADS_MUTATE_COUNT_MISMATCH_MARKER = "sm51-ads-count-mismatch";

export interface GoogleSandboxOptions {
  clientId: string;
  clientSecret: string;
  /** The exactly-registered redirect URI; the authorize + token endpoints both enforce equality. */
  redirectUri: string;
  /** Access-token lifetime. Tests that drive refresh-on-401 usually use `expireAccessTokens()` instead
   *  of waiting, but a short lifetime here lets the PROACTIVE (skew-window) refresh path be driven too. */
  accessTokenTtlSeconds?: number;
  /** When true (the DEFAULT), a refresh returns a NEW refresh token and invalidates the old one, so the
   *  rotation-persistence path is exercised. Set false to model an issuer that does not rotate — which
   *  is what Google is DOCUMENTED to do, and which our persistence must also survive. Both branches are
   *  real; which one Google takes is an SM-41G observation, not something this default asserts. */
  rotateRefreshTokens?: boolean;
}

export interface GoogleSandbox {
  origin: string;
  /** Config-shaped seams, so a test can assign them straight onto `config.search.google`. */
  endpoints: {
    authorizeUrl: string;
    tokenUrl: string;
    revokeUrl: string;
    searchConsoleBaseUrl: string;
    analyticsDataBaseUrl: string;
    adsBaseUrl: string;
  };
  totalHits(): number;
  hitCount(route: string): number;
  resetHitCounts(): void;
  /** Kill every outstanding access token WITHOUT touching refresh tokens — the exact state that makes
   *  the next API call 401 and forces api-client.ts's refresh-on-401 retry. Returns how many died. */
  expireAccessTokens(): number;
  /** Revoke the whole grant (access + refresh), as Google-side revocation would. Models the state a
   *  client must survive; it does not establish what Google actually does (SM-41G). */
  revokeAllGrants(): number;
  /** Inspect issued state — lets a test PROVE rotation happened rather than infer it from a green call. */
  issuedAccessTokenCount(): number;
  issuedRefreshTokenCount(): number;
  isRefreshTokenLive(token: string): boolean;
  seedGscSites(entries: GscSiteEntry[]): void;
  seedSearchAnalytics(siteUrl: string, rows: GscAnalyticsRow[] | null): void;
  seedGa4Report(propertyId: string, body: unknown): void;
  seedAdsSearch(customerId: string, body: unknown): void;
  close(): Promise<void>;
}

// ── tiny HTTP helpers (duplicated from server.ts deliberately — see file header) ───────────────────

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Deterministic-per-call-but-unguessable opaque token, prefixed so a test failure message says which
 *  kind of token was involved. Random, unlike SM-49's task ids: a token's VALUE must not be predictable
 *  from its inputs, or the harness would be modelling something weaker than an OAuth issuer. */
function mintToken(kind: "at" | "rt" | "code"): string {
  return `sm51-${kind}-${b64url(randomBytes(24))}`;
}

interface GrantState {
  id: string;
  scope: string;
  revoked: boolean;
}
interface AccessTokenState {
  grantId: string;
  scope: string;
  expiresAtMs: number;
  revoked: boolean;
}
interface RefreshTokenState {
  grantId: string;
  scope: string;
  revoked: boolean;
}
interface AuthCodeState {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  used: boolean;
}

export async function startGoogleSandbox(opts: GoogleSandboxOptions): Promise<GoogleSandbox> {
  const accessTokenTtlSeconds = opts.accessTokenTtlSeconds ?? 3599;
  const rotateRefreshTokens = opts.rotateRefreshTokens !== false;

  // ALL mutable state lives in THIS closure, returned fresh on every call — the same structural
  // "no shared mutable singleton across concurrent scopes" property SM-49's server.ts enforces.
  const grants = new Map<string, GrantState>();
  const accessTokens = new Map<string, AccessTokenState>();
  const refreshTokens = new Map<string, RefreshTokenState>();
  const authCodes = new Map<string, AuthCodeState>();
  const hits = new Map<string, number>();

  let gscSites: GscSiteEntry[] = [...DEFAULT_GSC_SITES];
  const searchAnalytics = new Map<string, GscAnalyticsRow[] | null>();
  const ga4Reports = new Map<string, unknown>();
  const adsResults = new Map<string, unknown>();

  function bump(route: string): void {
    hits.set(route, (hits.get(route) ?? 0) + 1);
    hits.set("__all__", (hits.get("__all__") ?? 0) + 1);
  }

  function oauthError(res: ServerResponse, status: number, code: OAuthErrorCode, description: string): void {
    sendJson(res, status, tokenErrorBody(code, description));
  }

  /** Constant-time secret comparison — the harness models an issuer, and an issuer that leaks its own
   *  secret comparison by early return is a bad model of one. */
  function secretMatches(presented: string): boolean {
    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(opts.clientSecret, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ── 1 · AUTHORIZE (a fake consent step: validate, then redirect with a code) ─────────────────────
  // NOT a model of Google's consent SCREEN — there is no UI, no account chooser, no scope-grant
  // decision. It models the PROTOCOL half only: parameter validation and the code redirect. The screen
  // itself, incremental consent and scope-grant semantics are SM-41G, and no assertion here may be read
  // as covering them.
  function handleAuthorize(res: ServerResponse, url: URL): void {
    bump("google:authorize");
    const q = url.searchParams;
    const redirectUri = q.get("redirect_uri") ?? "";
    const state = q.get("state") ?? "";

    // Parameter faults that Google would show a human as an error PAGE (never a redirect, because an
    // unvalidated redirect_uri must not be honoured) → a 400 here.
    if (q.get("client_id") !== opts.clientId) {
      oauthError(res, 400, "unauthorized_client", "client_id does not match the registered client");
      return;
    }
    if (redirectUri !== opts.redirectUri) {
      // THE open-redirect defence: an unregistered redirect_uri is refused OUTRIGHT, never redirected
      // to. A sandbox that redirected anywhere the caller asked would be a strictly weaker model than
      // a real issuer, and would silently bless a client bug.
      oauthError(res, 400, "invalid_request", "redirect_uri does not exactly match the registered value");
      return;
    }
    if (q.get("response_type") !== "code") {
      oauthError(res, 400, "invalid_request", "response_type must be 'code'");
      return;
    }
    const codeChallenge = q.get("code_challenge") ?? "";
    const method = q.get("code_challenge_method") ?? "";
    if (!codeChallenge || method !== "S256") {
      // PKCE is REQUIRED by this machine, and only S256. A client that silently dropped PKCE would
      // otherwise pass every local test and then meet the problem in staging.
      oauthError(res, 400, "invalid_request", "code_challenge is required and code_challenge_method must be S256");
      return;
    }
    const scope = q.get("scope") ?? "";
    if (!scope) {
      oauthError(res, 400, "invalid_scope", "scope is required");
      return;
    }

    // Faults AFTER the redirect_uri is validated are reported as an error REDIRECT, per RFC 6749 §4.1.2.1.
    if (scope.includes(GOOGLE_SANDBOX_DENY_SCOPE_MARKER)) {
      const deny = new URL(redirectUri);
      deny.searchParams.set("error", "access_denied");
      if (state) deny.searchParams.set("state", state);
      res.writeHead(302, { location: deny.toString() });
      res.end();
      return;
    }

    const code = mintToken("code");
    authCodes.set(code, {
      clientId: opts.clientId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod: method,
      scope,
      used: false,
    });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    // 302 with `Location` — a bare-fetch test reads it with `redirect: "manual"`, exactly as a browser
    // would be redirected. There is no HTML anywhere in this machine.
    res.writeHead(302, { location: target.toString() });
    res.end();
  }

  // ── 2 · TOKEN (the stateful machine: issue / refresh / rotate) ───────────────────────────────────
  async function handleToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
    bump("google:token");
    if ((req.method ?? "GET") !== "POST") {
      oauthError(res, 405, "invalid_request", "the token endpoint accepts POST only");
      return;
    }
    const ctype = String(req.headers["content-type"] ?? "");
    if (!ctype.includes("application/x-www-form-urlencoded")) {
      // Real issuers require form encoding here. A client that sent JSON would be accepted by a lenient
      // mock and refused by Google, so this is checked.
      oauthError(res, 400, "invalid_request", "content-type must be application/x-www-form-urlencoded");
      return;
    }
    const form = new URLSearchParams((await readBody(req)).toString("utf8"));

    // CLIENT AUTHENTICATION (client_secret_post, which is what we send).
    if (form.get("client_id") !== opts.clientId || !secretMatches(form.get("client_secret") ?? "")) {
      bump("google:token_auth_refused");
      oauthError(res, 401, "invalid_client", "client authentication failed");
      return;
    }

    const grantType = form.get("grant_type");
    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const entry = authCodes.get(code);
      if (!entry) {
        oauthError(res, 400, "invalid_grant", "unknown authorization code");
        return;
      }
      if (entry.used) {
        // SINGLE-USE, enforced by the machine. RFC 6749 §4.1.2 requires it, and it is the property that
        // makes authorization-code replay a non-issue at the issuer as well as at our own state row.
        bump("google:token_code_replay_refused");
        oauthError(res, 400, "invalid_grant", "authorization code already redeemed");
        return;
      }
      if ((form.get("redirect_uri") ?? "") !== entry.redirectUri) {
        oauthError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request");
        return;
      }
      // REAL PKCE VERIFICATION: compute S256 over the presented verifier and compare with the stored
      // challenge. Not a presence check — a wrong verifier is refused.
      const verifier = form.get("code_verifier") ?? "";
      if (!verifier) {
        bump("google:token_pkce_missing_refused");
        oauthError(res, 400, "invalid_grant", "code_verifier is required");
        return;
      }
      const computed = b64url(createHash("sha256").update(verifier, "ascii").digest());
      if (computed !== entry.codeChallenge) {
        bump("google:token_pkce_mismatch_refused");
        oauthError(res, 400, "invalid_grant", "code_verifier does not match code_challenge");
        return;
      }
      entry.used = true;

      const grantId = b64url(createHmac("sha256", "sm51-grant").update(code).digest()).slice(0, 16);
      grants.set(grantId, { id: grantId, scope: entry.scope, revoked: false });
      const at = mintToken("at");
      const rt = mintToken("rt");
      accessTokens.set(at, { grantId, scope: entry.scope, expiresAtMs: Date.now() + accessTokenTtlSeconds * 1000, revoked: false });
      refreshTokens.set(rt, { grantId, scope: entry.scope, revoked: false });
      sendJson(res, 200, tokenResponseBody({ accessToken: at, refreshToken: rt, scope: entry.scope, expiresInSeconds: accessTokenTtlSeconds }));
      return;
    }

    if (grantType === "refresh_token") {
      const presented = form.get("refresh_token") ?? "";
      const rtState = refreshTokens.get(presented);
      if (!rtState || rtState.revoked) {
        bump("google:token_refresh_refused");
        oauthError(res, 400, "invalid_grant", "refresh token is invalid, expired, or revoked");
        return;
      }
      const grant = grants.get(rtState.grantId);
      if (!grant || grant.revoked) {
        bump("google:token_refresh_refused");
        oauthError(res, 400, "invalid_grant", "the grant has been revoked");
        return;
      }
      const at = mintToken("at");
      accessTokens.set(at, { grantId: grant.id, scope: rtState.scope, expiresAtMs: Date.now() + accessTokenTtlSeconds * 1000, revoked: false });

      let rotated: string | null = null;
      if (rotateRefreshTokens) {
        // ROTATION: mint a new refresh token and INVALIDATE the presented one. A client that fails to
        // persist the rotation succeeds once and then breaks — the exact bug this branch exists to catch.
        rotated = mintToken("rt");
        refreshTokens.set(rotated, { grantId: grant.id, scope: rtState.scope, revoked: false });
        rtState.revoked = true;
        bump("google:token_rotated");
      }
      sendJson(res, 200, tokenResponseBody({ accessToken: at, refreshToken: rotated, scope: rtState.scope, expiresInSeconds: accessTokenTtlSeconds }));
      return;
    }

    oauthError(res, 400, "unsupported_grant_type", `unsupported grant_type: ${grantType ?? "(absent)"}`);
  }

  // ── 3 · REVOKE (RFC 7009) ───────────────────────────────────────────────────────────────────────
  async function handleRevoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    bump("google:revoke");
    if ((req.method ?? "GET") !== "POST") {
      oauthError(res, 405, "invalid_request", "the revocation endpoint accepts POST only");
      return;
    }
    const form = new URLSearchParams((await readBody(req)).toString("utf8"));
    const token = form.get("token") ?? "";
    if (!token) {
      oauthError(res, 400, "invalid_request", "token is required");
      return;
    }
    // Google's documented /revoke takes a BARE `token` body and no client credentials, which is why
    // token-endpoint-client.ts omits them for Google hosts and includes them for others. This machine
    // accepts either — it deliberately does not enforce client auth here, because enforcing it would
    // make the sandbox stricter than Google on the one dimension where Google is the looser party, and
    // a client tuned to pass this would then fail against… nothing. The RFC-required-auth case is
    // covered by the REAL Keycloak round trip instead, which does enforce it.
    let matched = false;
    const rt = refreshTokens.get(token);
    if (rt) {
      matched = true;
      rt.revoked = true;
      // Revoking a refresh token ends the GRANT — access tokens under it die too. This mirrors what
      // Google DOCUMENTS ("revoking a token revokes the grant"). It is a documented claim we have not
      // observed; SM-41G confirms it.
      const grant = grants.get(rt.grantId);
      if (grant) grant.revoked = true;
    }
    const at = accessTokens.get(token);
    if (at) {
      matched = true;
      at.revoked = true;
    }
    if (!matched) {
      // RFC 7009 §2.2 says an invalid token still yields 200. Google's own docs describe a 400
      // `invalid_token` for a bad token — so this machine returns the GOOGLE-shaped answer, and
      // token-endpoint-client.ts treats BOTH as "revoked" (an already-dead token is a successful
      // revocation from the client's point of view). Which one Google truly sends: SM-41G.
      bump("google:revoke_unknown_token");
      oauthError(res, 400, "invalid_token", "token was not recognized");
      return;
    }
    // 200 with an EMPTY body, as Google documents — which is why the client tolerates an empty body on
    // revoke but not on token.
    res.writeHead(200, { "content-type": "application/json" });
    res.end("");
  }

  // ── 4 · Bearer validation for every data surface ────────────────────────────────────────────────
  /** Returns the live token state, or null after having already written the 401. Separated so all three
   *  surfaces share ONE definition of "is this credential usable", rather than three near-copies. */
  function requireLiveBearer(req: IncomingMessage, res: ServerResponse, route: string): AccessTokenState | null {
    const header = req.headers.authorization;
    const raw = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const st = raw ? accessTokens.get(raw) : undefined;
    const grant = st ? grants.get(st.grantId) : undefined;
    const live = !!st && !st.revoked && st.expiresAtMs > Date.now() && !!grant && !grant.revoked;
    if (!live) {
      bump(`${route}:auth_refused`);
      // 401 in Google's own error envelope — this is precisely what drives api-client.ts's
      // refresh-on-401 retry, so the status and the shape both matter.
      sendJson(res, 401, UNAUTHENTICATED_BODY);
      return null;
    }
    return st!;
  }

  function markerRefusal(res: ServerResponse, subject: string, route: string): boolean {
    if (subject.includes(GOOGLE_SANDBOX_QUOTA_MARKER)) {
      bump(`${route}:quota`);
      // Modelled, not observed — see api-error.ts's header. `Retry-After` is included because a real
      // 429 usually carries one, so a future handler has something to read.
      sendJson(res, 429, RESOURCE_EXHAUSTED_BODY, { "retry-after": "30" });
      return true;
    }
    if (subject.includes(GOOGLE_SANDBOX_NOTFOUND_MARKER)) {
      bump(`${route}:notfound`);
      sendJson(res, 404, NOT_FOUND_BODY);
      return true;
    }
    return false;
  }

  // ── 5 · Search Console ─────────────────────────────────────────────────────────────────────────
  async function handleSearchConsole(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (url.pathname === "/webmasters/v3/sites" && (req.method ?? "GET") === "GET") {
      bump("gsc:sites_list");
      if (!requireLiveBearer(req, res, "gsc:sites_list")) return;
      sendJson(res, 200, gscSitesBody(gscSites));
      return;
    }

    // `POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query`. The site URL is percent-encoded in
    // the path (it is itself a URL), so the pattern captures one encoded segment.
    const m = /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(url.pathname);
    if (m && (req.method ?? "GET") === "POST") {
      bump("gsc:search_analytics");
      if (!requireLiveBearer(req, res, "gsc:search_analytics")) return;
      const siteUrl = decodeURIComponent(m[1]);
      if (markerRefusal(res, siteUrl, "gsc:search_analytics")) return;

      let body: Record<string, unknown> = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "request body is not valid JSON"));
        return;
      }
      // STRICTNESS: startDate/endDate are REQUIRED by the API. A driver that forgot them would be served
      // a fixture by a lenient mock; here it gets the vendor-shaped 400.
      if (typeof body.startDate !== "string" || typeof body.endDate !== "string") {
        bump("gsc:search_analytics_missing_dates");
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "startDate and endDate are required"));
        return;
      }
      // The site must be one the account can see — otherwise 403, which is what Google returns for a
      // property outside the grant. (That it is 403 rather than 404 is a docs-level claim: SM-41G.)
      if (!gscSites.some((s) => s.siteUrl === siteUrl)) {
        bump("gsc:search_analytics_forbidden");
        sendJson(res, 403, apiErrorBody(403, "PERMISSION_DENIED", `User does not have sufficient permission for site '${siteUrl}'.`));
        return;
      }

      const dimensions = Array.isArray(body.dimensions) ? (body.dimensions as string[]) : [];
      const seeded = searchAnalytics.get(siteUrl);
      if (seeded !== undefined) {
        sendJson(res, 200, gscSearchAnalyticsBody(seeded));
        return;
      }
      // Unseeded: a deterministic two-row set derived from the site + dimensions, so a test that does not
      // care about values still gets stable, non-empty data (SM-49's "unseeded returns a defined default"
      // convention, which keeps a fixture-shape assertion from needing a seed call).
      const subjects = dimensions.length
        ? [[`${siteUrl}-alpha`], [`${siteUrl}-beta`]].map((k) => [...k, ...dimensions.slice(1).map((d) => `${d}-value`)])
        : [[siteUrl]];
      sendJson(res, 200, gscSearchAnalyticsBody(deterministicRows(dimensions.length ? dimensions : ["date"], subjects)));
      return;
    }

    bump("gsc:unknown_path");
    sendJson(res, 404, apiErrorBody(404, "NOT_FOUND", `unknown Search Console path: ${url.pathname}`));
  }

  // ── 6 · GA4 Data API ───────────────────────────────────────────────────────────────────────────
  async function handleAnalyticsData(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const m = /^\/v1beta\/properties\/([^/:]+):runReport$/.exec(url.pathname);
    if (m && (req.method ?? "GET") === "POST") {
      bump("ga4:run_report");
      if (!requireLiveBearer(req, res, "ga4:run_report")) return;
      const propertyId = decodeURIComponent(m[1]);
      if (markerRefusal(res, propertyId, "ga4:run_report")) return;

      let body: Record<string, unknown> = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "request body is not valid JSON"));
        return;
      }
      // `dateRanges` is required by runReport. Checked for the same reason GSC's dates are.
      if (!Array.isArray(body.dateRanges) || body.dateRanges.length === 0) {
        bump("ga4:run_report_missing_date_ranges");
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "dateRanges is required"));
        return;
      }
      const seeded = ga4Reports.get(propertyId);
      sendJson(res, 200, seeded ?? defaultGa4Report(propertyId));
      return;
    }

    bump("ga4:unknown_path");
    sendJson(res, 404, apiErrorBody(404, "NOT_FOUND", `unknown GA4 Data API path: ${url.pathname}`));
  }

  // ── 7 · Google Ads (read; mutate envelope served for SM-26's future code only) ──────────────────
  async function handleAds(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const search = /^\/v\d+\/customers\/([^/:]+)\/googleAds:search$/.exec(url.pathname);
    if (search && (req.method ?? "GET") === "POST") {
      bump("ads:search");
      if (!requireLiveBearer(req, res, "ads:search")) return;
      const customerId = decodeURIComponent(search[1]);
      if (markerRefusal(res, customerId, "ads:search")) return;

      let body: Record<string, unknown> = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "request body is not valid JSON"));
        return;
      }
      if (typeof body.query !== "string" || !body.query.trim()) {
        bump("ads:search_missing_query");
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "query (GAQL) is required"));
        return;
      }
      // NOT ENFORCED HERE, ON PURPOSE: the `developer-token` header. A real Ads call fails without an
      // APPROVED developer token, and refusing it here would make every local test require a fake token
      // while proving nothing about the real approval. The honest statement is that developer-token and
      // MCC/login-customer-id semantics are SM-41G clauses — recorded in api-client.ts, in the fixture,
      // and here, rather than papered over with a check that models nothing.
      const seeded = adsResults.get(customerId);
      sendJson(res, 200, seeded ?? defaultAdsSearch(customerId));
      return;
    }

    const mutate = /^\/v\d+\/customers\/([^/:]+)\/([a-zA-Z]+):mutate$/.exec(url.pathname);
    if (mutate && (req.method ?? "GET") === "POST") {
      bump("ads:mutate");
      if (!requireLiveBearer(req, res, "ads:mutate")) return;
      const customerId = decodeURIComponent(mutate[1]);
      if (markerRefusal(res, customerId, "ads:mutate")) return;
      const resource = mutate[2];

      let body: Record<string, unknown> = {};
      try {
        const raw = (await readBody(req)).toString("utf8");
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "request body is not valid JSON"));
        return;
      }
      const operations = Array.isArray(body.operations) ? (body.operations as unknown[]) : [];
      if (operations.length === 0) {
        bump("ads:mutate_missing_operations");
        sendJson(res, 400, apiErrorBody(400, "INVALID_ARGUMENT", "operations is required and must be non-empty"));
        return;
      }

      // SM-26 (tracker §6bp Ruling 6) — echo ONE result per operation IN ORDER by default (the
      // documented vendor contract this executor's positional pairing depends on), rather than the
      // fixed single-result stub SM-51 originally shipped: a real multi-operation batch's count MUST
      // match for a driver's positional-pairing happy path to be exercisable over real sockets at all.
      let rowFailIndex = -1;
      let mismatch = false;
      operations.forEach((raw, i) => {
        const s = JSON.stringify(raw);
        if (rowFailIndex === -1 && s.includes(GOOGLE_SANDBOX_ADS_MUTATE_ROW_FAIL_MARKER)) rowFailIndex = i;
        if (s.includes(GOOGLE_SANDBOX_ADS_MUTATE_COUNT_MISMATCH_MARKER)) mismatch = true;
      });

      const results = operations.map((_, i) =>
        i === rowFailIndex
          ? { resourceName: null }
          : { resourceName: `customers/${customerId}/${resource}/${i + 1}` },
      );
      if (mismatch) {
        // Models Ruling 6.3's count/shape mismatch: one FEWER result than operations sent. Dropping
        // the LAST one (rather than always index 0) so a test can also assert the mismatch is detected
        // regardless of which end of the array is short.
        results.pop();
        bump("ads:mutate_count_mismatch");
      }
      if (rowFailIndex !== -1) bump("ads:mutate_row_fail");

      sendJson(
        res,
        200,
        adsMutateBody({
          results,
          partialFailure: rowFailIndex !== -1 ? { code: 3, message: "one or more operations failed" } : null,
        }),
      );
      return;
    }

    bump("ads:unknown_path");
    sendJson(res, 404, apiErrorBody(404, "NOT_FOUND", `unknown Google Ads path: ${url.pathname}`));
  }

  // ── routing ────────────────────────────────────────────────────────────────────────────────────
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://google-sandbox.invalid");
    bump("__requests__");
    const p = url.pathname;

    const route = async (): Promise<void> => {
      // OAuth endpoints. Paths mirror Google's own (`/o/oauth2/v2/auth`, `/token`, `/revoke`) so the
      // configured seams look like the real thing apart from the origin.
      if (p === "/o/oauth2/v2/auth") return void handleAuthorize(res, url);
      if (p === "/token") return handleToken(req, res);
      if (p === "/revoke") return handleRevoke(req, res);
      // Data surfaces, matched on their own documented path prefixes. Anything else is a genuine
      // unknown path and 404s — never a permissive fallback (§A10.5's strictness rule).
      if (p.startsWith("/webmasters/")) return handleSearchConsole(req, res, url);
      if (p.startsWith("/v1beta/properties/")) return handleAnalyticsData(req, res, url);
      if (/^\/v\d+\/customers\//.test(p)) return handleAds(req, res, url);
      bump("unknown_path");
      sendJson(res, 404, apiErrorBody(404, "NOT_FOUND", `unknown path: ${p}`));
    };

    route().catch((err: Error) => {
      // A harness-internal bug must fail the test loudly, but still answer so the client's own fetch
      // does not hang out its timeout (SM-49's server.ts does exactly this).
      sendJson(res, 500, apiErrorBody(500, "INTERNAL", `google-sandbox internal error: ${err.message}`));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${addr.port}`;

  return {
    origin,
    endpoints: {
      authorizeUrl: `${origin}/o/oauth2/v2/auth`,
      tokenUrl: `${origin}/token`,
      revokeUrl: `${origin}/revoke`,
      searchConsoleBaseUrl: origin,
      analyticsDataBaseUrl: origin,
      adsBaseUrl: origin,
    },
    totalHits: () => hits.get("__all__") ?? 0,
    hitCount: (r: string) => hits.get(r) ?? 0,
    resetHitCounts: () => hits.clear(),
    expireAccessTokens: () => {
      let n = 0;
      for (const st of accessTokens.values()) {
        if (!st.revoked && st.expiresAtMs > Date.now()) {
          st.expiresAtMs = Date.now() - 1000;
          n += 1;
        }
      }
      return n;
    },
    revokeAllGrants: () => {
      let n = 0;
      for (const g of grants.values()) {
        if (!g.revoked) {
          g.revoked = true;
          n += 1;
        }
      }
      for (const rt of refreshTokens.values()) rt.revoked = true;
      return n;
    },
    issuedAccessTokenCount: () => accessTokens.size,
    issuedRefreshTokenCount: () => refreshTokens.size,
    isRefreshTokenLive: (t: string) => {
      const st = refreshTokens.get(t);
      if (!st || st.revoked) return false;
      const g = grants.get(st.grantId);
      return !!g && !g.revoked;
    },
    seedGscSites: (entries) => {
      gscSites = [...entries];
    },
    seedSearchAnalytics: (siteUrl, rows) => searchAnalytics.set(siteUrl, rows),
    seedGa4Report: (propertyId, body) => ga4Reports.set(propertyId, body),
    seedAdsSearch: (customerId, body) => adsResults.set(customerId, body),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
