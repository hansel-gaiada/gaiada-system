// SM-25a — the OAuth CORE: start → callback → vault, plus refresh-with-rotation, RFC-7009 revocation,
// and the per-connection access-token accessor SM-25b/SM-25c will build on (design addendum §A12).
//
// ── THE VAULT IS THE EXISTING ONE. THERE IS NO SECOND VAULT. ──────────────────────────────────────
// Tokens land in `integration_connections` (migration 0033): AES-256-GCM at rest via
// src/core/secret-box.ts, `hasToken`-only API reads, `token_key_version` stamped for future rotation.
// Migration 0035 ALREADY widened that table's CHECKs for exactly this work — provider ∈
// {google_search_console, google_analytics, google_ads} and owner_kind = 'client' — so per-client
// Google links were legal to store before this file existed; what was missing was the machinery that
// obtains the tokens. Writes go through core's own `createConnection` / `setConnectionTokens` /
// `patchConnection` / `revokeConnection`, never through hand-rolled SQL, so the vault's sealing,
// event-emit and non-exposure invariants are inherited rather than re-implemented.
//
// The ONE thing read directly here is the sealed refresh token. `core/integrations.service.ts` exports
// `readAccessToken` but no refresh-token sibling, and that file belongs to core rather than to this
// wave's Google work, so `readConnectionSecrets()` below does the tenant-scoped read + decrypt in this
// module instead of widening a core file mid-wave. TODO(follow-up): fold it into
// `core/integrations.service.ts` next to `readAccessToken` when that file's ownership frees up — the
// two are the same concern and should not stay in two places.
//
// ── TENANCY ──────────────────────────────────────────────────────────────────────────────────────
// Every credential here is PER CLIENT, PER COMPANY. `owner_kind='client'`, `owner_id = clients.id`,
// `tenant_id` = the company the link lives in, and every read/write goes through
// `withTenants([tenantId], …)` — so a connection is reachable only from the company that created it.
// There is no cross-tenant or holding-wide Google connection, deliberately (0033's own tenancy
// decision, carried unchanged): a person or agency serving N companies re-links per company.
//
// ── PROVENANCE / HONESTY (§A12.2, §A12.3) ────────────────────────────────────────────────────────
// Every connection records the ISSUER HOST it was authorized against, in `meta.googleIssuerHost`, plus
// `meta.googleIssuerIsGoogle`. §A12.3 rules this the proportionate disclosure for credential metadata
// (as against §A10's full ceremony for cross-tenant market data with dollars attached), and it is what
// makes a dev-issuer connection readable as one at a glance on any surface. The in-flight state row
// additionally carries the binary `simulated` stamp (0060).
//
// ── WHAT A GREEN RUN OF THIS FILE'S TESTS MEANS ──────────────────────────────────────────────────
// A green sandbox / Keycloak harness is a validated client of our own model of Google, not a validated
// Google integration. Deferred to SM-41G, in full: Google's consent screen, incremental consent and
// scope-grant semantics; refresh-token longevity under the OAuth app's publish status (Testing-mode
// refresh tokens expire in 7 days); Google-side revocation; quota/429 behaviour; the Ads developer
// token + MCC/login-customer-id semantics; and whether real Google accepts our requests at all.
import type { PoolClient } from "pg";

import { config, googleOAuthConfigured } from "../../../config";
import { withTenants } from "../../../db";
import { decryptSecret } from "../../../core/secret-box";
import {
  createConnection,
  patchConnection,
  revokeConnection as revokeConnectionRow,
  setConnectionTokens,
  type ConnectionResponse,
} from "../../../core/integrations.service";
import { GoogleConnectionNotLinkedError, GoogleOAuthNotConfiguredError, GoogleTokenEndpointError } from "./errors";
import { hostLabel, isGoogleHost } from "./google-hosts";
import {
  attachConnectionToState,
  consumeAuthorizationState,
  createAuthorizationState,
  type GoogleProvider,
} from "./oauth-state";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeToken,
  type FetchImpl,
} from "./token-endpoint-client";

/** Least-privilege READ scopes per surface. Google's own documented strings.
 *
 *  UNVERIFIED (SM-41G): whether each scope grants exactly what we need, whether Google's consent screen
 *  presents them as one grant or several, and how incremental consent behaves. A local issuer can echo
 *  any scope string back to us — it cannot tell us what the string MEANS at Google. `webmasters.readonly`
 *  and `analytics.readonly` are read-only by name; `adwords` is Google's single Ads scope and is NOT
 *  read-only, which is why SM-25c is a read binding and every Ads WRITE stays behind SM-21's
 *  approve-execute-replay + WS4 one-shot approval (§A12.1/D-8) regardless of what this token permits. */
export const DEFAULT_SCOPES: Record<GoogleProvider, string[]> = {
  google_search_console: ["https://www.googleapis.com/auth/webmasters.readonly"],
  google_analytics: ["https://www.googleapis.com/auth/analytics.readonly"],
  google_ads: ["https://www.googleapis.com/auth/adwords"],
};

/** The masked connection shape every caller and every HTTP response uses. Token material is
 *  STRUCTURALLY ABSENT, exactly like core's `ConnectionResponse` — do not add a token field here. */
export interface GoogleConnectionView {
  id: string;
  provider: GoogleProvider;
  clientId: string;
  status: string;
  hasToken: boolean;
  hasRefreshToken: boolean;
  tokenExpiresAt: string | null;
  scopes: string[];
  externalAccount: string | null;
  /** §A12.3's honesty rule: the host that actually issued these tokens. */
  issuerHost: string | null;
  /** False ⇒ a dev/sandbox issuer. Surfaces MUST render the issuer host when this is false. */
  issuerIsGoogle: boolean;
}

function viewOf(row: ConnectionResponse): GoogleConnectionView {
  const meta = row.meta ?? {};
  return {
    id: row.id,
    provider: row.provider as GoogleProvider,
    clientId: row.ownerId,
    status: row.status,
    hasToken: row.hasToken,
    hasRefreshToken: row.hasRefreshToken,
    tokenExpiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    externalAccount: row.externalAccount,
    issuerHost: typeof meta.googleIssuerHost === "string" ? meta.googleIssuerHost : null,
    issuerIsGoogle: meta.googleIssuerIsGoogle === true,
  };
}

function assertConfigured(): void {
  if (!googleOAuthConfigured()) {
    const g = config.search.google;
    const missing = [
      ...(g.clientId ? [] : ["GOOGLE_OAUTH_CLIENT_ID"]),
      ...(g.clientSecret ? [] : ["GOOGLE_OAUTH_CLIENT_SECRET"]),
      ...(g.redirectUri ? [] : ["GOOGLE_OAUTH_REDIRECT_URI"]),
    ];
    throw new GoogleOAuthNotConfiguredError(missing);
  }
}

// ── 1 · START: the authorize URL ───────────────────────────────────────────────────────────────────

export interface StartAuthorizationInput {
  tenantId: string;
  /** The CLIENT whose own Google account is being linked (clients.id). */
  clientId: string;
  propertyId?: string | null;
  provider: GoogleProvider;
  /** Optional narrowing; defaults to DEFAULT_SCOPES[provider]. Never widened beyond what is passed. */
  scopes?: string[];
  createdBy: string | null;
  loginHint?: string | null;
}

export interface StartedAuthorization {
  authorizeUrl: string;
  state: string;
  expiresAt: string;
  issuerHost: string;
  /** True when the authorize endpoint is not Google's own host (§A12.2). */
  simulated: boolean;
  scopes: string[];
}

/** Mint PKCE + a signed, single-use state row, and return the issuer's authorize URL.
 *  FAIL-CLOSED FIRST: an unconfigured OAuth client throws before any DB write or crypto work. */
export async function startAuthorization(input: StartAuthorizationInput): Promise<StartedAuthorization> {
  assertConfigured();
  const g = config.search.google;
  const scopes = input.scopes?.length ? input.scopes : DEFAULT_SCOPES[input.provider];

  const state = await createAuthorizationState({
    tenantId: input.tenantId,
    clientId: input.clientId,
    propertyId: input.propertyId ?? null,
    provider: input.provider,
    redirectUri: g.redirectUri,
    scopes,
    authorizeUrl: g.authorizeUrl,
    createdBy: input.createdBy,
  });

  return {
    authorizeUrl: buildAuthorizeUrl({
      scopes,
      state: state.stateToken,
      codeChallenge: state.codeChallenge,
      redirectUri: g.redirectUri,
      loginHint: input.loginHint ?? null,
    }),
    state: state.stateToken,
    expiresAt: state.expiresAt,
    issuerHost: state.issuerHost,
    simulated: state.simulated,
    scopes,
  };
}

// ── 2 · CALLBACK: verify, exchange, seal ───────────────────────────────────────────────────────────

export interface CompleteAuthorizationInput {
  stateToken: string;
  code: string;
  /** The principal presenting the callback. Must be the one who started the flow (attack A1). */
  principalUserId: string | null;
  provider: GoogleProvider;
  fetchImpl?: FetchImpl;
}

/** Consume the state (single-use, atomic), exchange the code, then seal the tokens into the EXISTING
 *  vault. ORDER MATTERS: the state is spent BEFORE the network call, so a code that fails at the issuer
 *  cannot be retried against the same state (see oauth-state.ts's ordering note). */
export async function completeAuthorization(input: CompleteAuthorizationInput): Promise<GoogleConnectionView> {
  assertConfigured();
  const g = config.search.google;

  const state = await consumeAuthorizationState(input.stateToken, {
    redirectUri: g.redirectUri,
    principalUserId: input.principalUserId,
    provider: input.provider,
  });

  const tokens = await exchangeAuthorizationCode(
    { code: input.code, codeVerifier: state.codeVerifier, redirectUri: state.redirectUri },
    input.fetchImpl,
  );

  // Upsert the mapping row first (0033's UNIQUE (tenant, owner_kind, owner_id, provider) makes this
  // idempotent — a re-link reuses the same row rather than accumulating duplicates), then seal.
  const mapping = await createConnection(state.tenantId, {
    ownerKind: "client",
    ownerId: state.clientId,
    provider: state.provider,
    scopes: state.scopes,
    meta: {
      // §A12.3's honesty carrier. Recorded from the STATE row, not from current config, so a row always
      // says where its own tokens came from even if the config is later repointed.
      googleIssuerHost: state.issuerHost,
      googleIssuerIsGoogle: !state.simulated,
      googleLinkedAt: new Date().toISOString(),
      ...(state.propertyId ? { googlePropertyId: state.propertyId } : {}),
    },
    createdBy: state.createdBy,
  });

  const sealed = await setConnectionTokens(state.tenantId, mapping.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    // Record what the ISSUER SAYS was granted, which may be narrower than requested (Google's actual
    // scope-grant semantics are SM-41G). Fall back to the requested set only when nothing was returned.
    scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : state.scopes,
  });

  // Audit link, best-effort (§4d secondary-failure template): a failure to annotate the spent state row
  // must never invalidate a credential that is already correctly sealed.
  try {
    await attachConnectionToState(state.tenantId, state.stateId, sealed.id);
  } catch {
    /* deliberately swallowed — the connection is the primary outcome */
  }

  // Bind the property when the flow named one, so `gsc_connection_id`/`ga4_connection_id`/
  // `ads_connection_id` (0034) resolve immediately rather than needing a second call.
  if (state.propertyId) {
    try {
      await bindPropertyConnection(state.tenantId, state.propertyId, state.provider, sealed.id);
    } catch {
      /* same reasoning: the credential is linked; the binding is re-issuable from the Connections tab */
    }
  }

  return viewOf(sealed);
}

// ── 3 · THE VAULT READ (sealed → plaintext, server-side only) ─────────────────────────────────────

interface ConnectionSecrets {
  id: string;
  provider: string;
  status: string;
  ownerId: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  meta: Record<string, unknown>;
}

/** Tenant-scoped read + decrypt. The ONLY path in this module that yields token plaintext, and it never
 *  reaches an HTTP response — callers hand the string straight to an Authorization header. */
async function readConnectionSecrets(tenantId: string, connectionId: string): Promise<ConnectionSecrets | null> {
  return withTenants([tenantId], async (c: PoolClient) => {
    const res = await c.query<{
      id: string;
      provider: string;
      status: string;
      owner_id: string;
      access_token_enc: string | null;
      refresh_token_enc: string | null;
      token_expires_at: string | null;
      scopes: string[];
      meta: Record<string, unknown>;
    }>(
      `SELECT id, provider, status, owner_id, access_token_enc, refresh_token_enc, token_expires_at,
              scopes, meta
         FROM integration_connections
        WHERE id = $1 AND deleted_at IS NULL`,
      [connectionId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      provider: r.provider,
      status: r.status,
      ownerId: r.owner_id,
      accessToken: r.access_token_enc ? decryptSecret(r.access_token_enc) : null,
      refreshToken: r.refresh_token_enc ? decryptSecret(r.refresh_token_enc) : null,
      expiresAt: r.token_expires_at,
      scopes: r.scopes ?? [],
      meta: r.meta ?? {},
    };
  });
}

function isStale(expiresAt: string | null): boolean {
  if (!expiresAt) return false; // no expiry recorded ⇒ nothing to pre-empt; a 401 is the fallback signal
  return Date.parse(expiresAt) - Date.now() <= config.search.google.refreshSkewSeconds * 1000;
}

// ── 4 · REFRESH (with rotation) ───────────────────────────────────────────────────────────────────

export interface AccessTokenResult {
  accessToken: string;
  /** True when this call performed a refresh (proactive skew or a forced renewal). */
  refreshed: boolean;
  connectionId: string;
}

/** Return a usable access token for a connection, refreshing when it is absent or within the skew
 *  window. `force` is what the refresh-on-401 path in api-client.ts uses: a 401 means the token is dead
 *  regardless of what our stored expiry claims. */
export async function getAccessToken(
  tenantId: string,
  connectionId: string,
  opts: { force?: boolean; fetchImpl?: FetchImpl } = {},
): Promise<AccessTokenResult> {
  assertConfigured();
  const secrets = await readConnectionSecrets(tenantId, connectionId);
  if (!secrets) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  if (secrets.status === "revoked") throw new GoogleConnectionNotLinkedError(connectionId, "revoked");

  const mustRefresh = opts.force === true || !secrets.accessToken || isStale(secrets.expiresAt);
  if (!mustRefresh) return { accessToken: secrets.accessToken!, refreshed: false, connectionId };

  if (!secrets.refreshToken) {
    // No way to renew: an expired access token with no refresh token is a dead connection, and the fix
    // is a human re-link (409), not a retry. This is also the shape a Testing-mode Google app produces
    // after its 7-day refresh-token expiry — a state SM-41G must observe for real, not one we simulate.
    throw new GoogleConnectionNotLinkedError(connectionId, secrets.accessToken ? "no_refresh_token" : "no_access_token");
  }

  // `invalid_grant` on refresh is NOT an upstream fault — it means the grant is gone: the user revoked
  // access in their Google account, the refresh token expired (a Testing-mode app's expire in 7 days —
  // SM-41G's clause), or the account's credentials changed. Reporting that as a 502 would send an
  // operator to debug the network when the fix is a human re-link, so it is translated to the 409.
  //
  // WHAT THIS DELIBERATELY DOES NOT DO: destroy the stored tokens. A single `invalid_grant` could also
  // arrive from a transient issuer fault, and a read path must not be able to shred a credential. The
  // row is marked `error` instead (0033's own status for exactly this), so the Connections tab can show
  // "needs re-link" without a background job, and an actual revoke stays an explicit human action.
  let tokens: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    tokens = await refreshAccessToken(secrets.refreshToken, opts.fetchImpl);
  } catch (err) {
    if (err instanceof GoogleTokenEndpointError && err.detail?.oauthError === "invalid_grant") {
      try {
        await patchConnection(tenantId, connectionId, { status: "error" });
      } catch {
        /* §4d secondary-failure template: the real refusal below must still propagate */
      }
      throw new GoogleConnectionNotLinkedError(connectionId, "grant_invalid");
    }
    throw err;
  }
  // ROTATION PERSISTENCE. When the issuer returns a NEW refresh token, it must be stored or the NEXT
  // refresh fails with the old (now-invalid) one — the classic rotation bug. When it returns none,
  // `setConnectionTokens` COALESCEs and the existing refresh token survives. Both issuers we can drive
  // locally exercise one branch each (Keycloak rotates; the sandbox rotates only when scripted to),
  // and which branch REAL Google takes is an SM-41G observation, not an assumption encoded here.
  await setConnectionTokens(tenantId, connectionId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    // Omitted (not null) when the issuer returned no scope, so `setConnectionTokens`'s COALESCE keeps
    // the previously-granted set rather than blanking it.
    ...(tokens.scope ? { scopes: tokens.scope.split(/\s+/).filter(Boolean) } : {}),
  });
  return { accessToken: tokens.accessToken, refreshed: true, connectionId };
}

/** Explicit refresh, for a Connections-tab "refresh now" action. Returns the masked view. */
export async function refreshConnection(
  tenantId: string,
  connectionId: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<GoogleConnectionView> {
  await getAccessToken(tenantId, connectionId, { force: true, fetchImpl: opts.fetchImpl });
  const row = await getGoogleConnection(tenantId, connectionId);
  if (!row) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  return row;
}

// ── 5 · REVOKE (RFC 7009 at the issuer, then locally) ─────────────────────────────────────────────

export interface RevokeResult {
  connection: GoogleConnectionView;
  /** Whether the ISSUER accepted the revocation. False ⇒ local tokens are still destroyed (below). */
  issuerRevoked: boolean;
  issuerStatus: number | null;
}

/** Revoke at the issuer, then soft-revoke locally.
 *
 *  THE ORDER AND THE FAILURE POLICY ARE BOTH DELIBERATE. Issuer first, so a successful local wipe never
 *  leaves a live grant we can no longer address (we would have destroyed the only token that could
 *  revoke it). But an issuer failure does NOT abort the local revoke: refusing to forget a credential
 *  because a remote endpoint is unreachable is the wrong failure direction for a vault. So the local
 *  row is always revoked and the issuer outcome is REPORTED rather than swallowed — the caller can see
 *  that a remote grant may still exist and retry at the issuer.
 *
 *  UNVERIFIED (SM-41G): Google-side revocation behaviour — whether revoking the refresh token also kills
 *  outstanding access tokens immediately, and what a second revoke of the same grant returns. */
export async function revokeGoogleConnection(
  tenantId: string,
  connectionId: string,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<RevokeResult> {
  const secrets = await readConnectionSecrets(tenantId, connectionId);
  if (!secrets) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");

  let issuerRevoked = false;
  let issuerStatus: number | null = null;
  // Prefer the refresh token: revoking the long-lived credential is what actually ends the grant. Fall
  // back to the access token when that is all we hold.
  const target = secrets.refreshToken ?? secrets.accessToken;
  if (target && googleOAuthConfigured()) {
    try {
      const out = await revokeToken(target, opts.fetchImpl);
      issuerRevoked = out.revoked;
      issuerStatus = out.status;
    } catch (err) {
      // Reported, never fatal — see the failure-policy note above.
      issuerRevoked = false;
      issuerStatus = null;
      void err;
    }
  }

  const row = await revokeConnectionRow(tenantId, connectionId);
  return { connection: viewOf(row), issuerRevoked, issuerStatus };
}

// ── 6 · READS + property bindings ─────────────────────────────────────────────────────────────────

export async function getGoogleConnection(tenantId: string, connectionId: string): Promise<GoogleConnectionView | null> {
  const rows = await withTenants([tenantId], (c) =>
    c.query<{
      id: string; owner_kind: string; owner_id: string; provider: string; external_account: string | null;
      scopes: string[]; status: string; access_token_enc: string | null; refresh_token_enc: string | null;
      token_expires_at: string | null; meta: Record<string, unknown>;
    }>(
      `SELECT id, owner_kind, owner_id, provider, external_account, scopes, status, access_token_enc,
              refresh_token_enc, token_expires_at, meta
         FROM integration_connections WHERE id = $1 AND deleted_at IS NULL`,
      [connectionId],
    ),
  );
  const r = rows.rows[0];
  if (!r) return null;
  const meta = r.meta ?? {};
  return {
    id: r.id,
    provider: r.provider as GoogleProvider,
    clientId: r.owner_id,
    status: r.status,
    hasToken: !!r.access_token_enc,
    hasRefreshToken: !!r.refresh_token_enc,
    tokenExpiresAt: r.token_expires_at,
    scopes: r.scopes ?? [],
    externalAccount: r.external_account,
    issuerHost: typeof meta.googleIssuerHost === "string" ? meta.googleIssuerHost : null,
    issuerIsGoogle: meta.googleIssuerIsGoogle === true,
  };
}

/** List this tenant's Google connections (optionally for one client). Revoked rows are INCLUDED: the
 *  Connections tab must be able to show "this was revoked", which is different from "was never linked". */
export async function listGoogleConnections(tenantId: string, clientId?: string): Promise<GoogleConnectionView[]> {
  const args: unknown[] = [];
  const clauses = [
    "deleted_at IS NULL",
    `owner_kind = 'client'`,
    `provider IN ('google_search_console','google_analytics','google_ads')`,
  ];
  if (clientId) clauses.push(`owner_id = $${args.push(clientId)}`);
  const rows = await withTenants([tenantId], (c) =>
    c.query<{
      id: string; owner_id: string; provider: string; external_account: string | null; scopes: string[];
      status: string; access_token_enc: string | null; refresh_token_enc: string | null;
      token_expires_at: string | null; meta: Record<string, unknown>;
    }>(
      `SELECT id, owner_id, provider, external_account, scopes, status, access_token_enc,
              refresh_token_enc, token_expires_at, meta
         FROM integration_connections WHERE ${clauses.join(" AND ")} ORDER BY provider, created_at DESC`,
      args,
    ),
  );
  return rows.rows.map((r) => {
    const meta = r.meta ?? {};
    return {
      id: r.id,
      provider: r.provider as GoogleProvider,
      clientId: r.owner_id,
      status: r.status,
      hasToken: !!r.access_token_enc,
      hasRefreshToken: !!r.refresh_token_enc,
      tokenExpiresAt: r.token_expires_at,
      scopes: r.scopes ?? [],
      externalAccount: r.external_account,
      issuerHost: typeof meta.googleIssuerHost === "string" ? meta.googleIssuerHost : null,
      issuerIsGoogle: meta.googleIssuerIsGoogle === true,
    };
  });
}

/** The three binding columns 0034 created for P4. A FIXED map, never a caller-supplied column name —
 *  the provider is a union type and this record is exhaustive, so no string from a request body ever
 *  reaches the SQL text. */
const PROPERTY_BINDING_COLUMN: Record<GoogleProvider, "gsc_connection_id" | "ga4_connection_id" | "ads_connection_id"> = {
  google_search_console: "gsc_connection_id",
  google_analytics: "ga4_connection_id",
  google_ads: "ads_connection_id",
};

/** Resolve a property's connection id for one surface — the read SM-25b/SM-25c ingestion starts from.
 *  Returns null when unbound, which those tickets must treat as "not configured for this client", never
 *  as an excuse to fall back to some other tenant's connection.
 *
 *  SM-72 (tracker §6bo.1): this is the FOURTH site of the SM-63 shape (§6bb) — resolve a row by one key,
 *  never verify the row's OWN scope. gsc-client.ts and ga4-client.ts each resolve a connection id through
 *  this function and then use that connection WITHOUT checking its own `.provider` against the surface
 *  they are about to pull (ads-client.ts already carries that guard locally — SM-25c). Rather than add
 *  the same guard at each of those two call sites (and leave a future third reader to forget it, exactly
 *  as these two did), the check is hoisted HERE: the JOIN below requires the resolved connection's own
 *  `provider` column to equal the surface being asked for. A stale or wrongly-bound column (the gap
 *  SM-71 closed at WRITE time in `bindPropertyConnection`, but which a pre-existing stale row or a future
 *  write path bypassing that function could still produce) now fails the JOIN and falls out through the
 *  exact same "0 rows" branch as a genuinely unbound property — there is no separate mismatch branch to
 *  build an oracle from; both cases return `null` from the SAME query, and callers already throw the SAME
 *  `GooglePropertyNotBoundError(propertyId, provider)` for `null` (§A14.5: refuse-as-not-found, no
 *  oracle). This is safe to hoist because every production caller of this function already supplies a
 *  concrete surface to resolve FOR (gsc-client.ts/ga4-client.ts/ads-client.ts each pass their own fixed
 *  provider literal) — unlike `getGoogleConnection`/`getAccessToken`, which are also called with no
 *  surface in view at all (`refreshConnection`, the connections-tab route) and so cannot carry this
 *  check themselves without breaking those callers. ads-client.ts's OWN guard (line ~272) stays — this
 *  hoist is defence in depth on top of it, not a replacement (do not remove either). */
export async function resolvePropertyConnection(
  tenantId: string,
  propertyId: string,
  provider: GoogleProvider,
): Promise<string | null> {
  const col = PROPERTY_BINDING_COLUMN[provider];
  const rows = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ connection_id: string | null }>(
        `SELECT sp.${col} AS connection_id
           FROM search_properties sp
           JOIN integration_connections ic
             ON ic.id = sp.${col} AND ic.provider = $2 AND ic.deleted_at IS NULL
          WHERE sp.id = $1 AND sp.deleted_at IS NULL`,
        [propertyId, provider],
      ),
    { modules: ["search"] },
  );
  return rows.rows[0]?.connection_id ?? null;
}

/** Bind a connection to a property. Both rows are resolved through the SAME tenant+module-scoped
 *  connection, so a property id from another tenant matches zero rows and the UPDATE is a no-op rather
 *  than an FK-accepted cross-tenant write (the FK-tenant-validation hazard search.controller.ts's
 *  header documents: FK checks run as the table owner, OUTSIDE RLS).
 *
 *  SM-71 (tracker §6bm.1): this is the THIRD site of the SM-63 shape (§6bb) — resolve a row by one key,
 *  never verify the row's OWN scope. A connection was resolved by `id` alone and bound into whichever
 *  surface column the caller named, without checking that the connection's own `.provider` matches that
 *  surface — so a Search Console connection could be bound into the Ads column (or vice versa). The
 *  existence check below now also checks provider, and a mismatch is folded into the SAME "0 rows"
 *  outcome as a genuinely nonexistent connection: per addendum §A14.5, the identity disposition here is
 *  refuse-as-not-found with NO ORACLE — this function's boolean return already collapses both cases into
 *  a single `false`, and callers (this route's own `if (!bound) throw new NotFoundException(...)`) must
 *  not be able to tell "wrong provider" apart from "no such connection". Do NOT split this into a
 *  separate error/branch — that would reintroduce the oracle this fix exists to close. */
export async function bindPropertyConnection(
  tenantId: string,
  propertyId: string,
  provider: GoogleProvider,
  connectionId: string | null,
): Promise<boolean> {
  const col = PROPERTY_BINDING_COLUMN[provider];
  const res = await withTenants(
    [tenantId],
    async (c) => {
      if (connectionId) {
        const owned = await c.query<{ provider: string }>(
          `SELECT provider FROM integration_connections WHERE id = $1 AND deleted_at IS NULL`,
          [connectionId],
        );
        const row = owned.rows[0];
        if (!row || row.provider !== provider) return 0;
      }
      const upd = await c.query(
        `UPDATE search_properties SET ${col} = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [propertyId, connectionId],
      );
      return upd.rowCount ?? 0;
    },
    { modules: ["search"] },
  );
  return res > 0;
}

/** Exported for the honesty line on any connections surface: the issuer host, and whether it is
 *  Google's. Computed from CURRENT config (what a NEW link would use), as against a stored row's own
 *  recorded issuer — both are shown, because they can legitimately differ after a repoint. */
export function currentIssuerDisclosure(): { issuerHost: string; issuerIsGoogle: boolean } {
  return {
    issuerHost: hostLabel(config.search.google.authorizeUrl),
    issuerIsGoogle: isGoogleHost(config.search.google.authorizeUrl),
  };
}
