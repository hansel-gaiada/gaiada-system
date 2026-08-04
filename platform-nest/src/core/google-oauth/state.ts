// SM-25a — the in-flight authorization request: PKCE generation, the SIGNED `state` parameter, and
// the single-use consume (design addendum §A12.3).
//
// ── THE ATTACK LIST THIS FILE EXISTS TO CLOSE (§4g — publish it, don't imply it) ───────────────────
// Every item below is a real, named authorization-code-flow attack, with the mechanism that refuses it
// and the test that proves the refusal (oauth-state.test.ts / google-oauth.e2e.test.ts):
//
//  A1. CSRF / login-CSRF on the callback — attacker drives a victim's browser to
//      `…/callback?code=<attacker's code>&state=<anything>`. Without a bound state this binds the
//      ATTACKER's Google account into the VICTIM's tenant, and every later "client data" read is
//      really the attacker's account. REFUSED BY: the state must be a row this server created
//      (unknown ⇒ refused), and its `created_by` must equal the calling principal
//      ("principal_mismatch"). The row is also single-use, so even a leaked valid state is spent.
//  A2. State forgery / tenant pivot — attacker mints `state` naming a tenant they can reach, hoping
//      the callback trusts the URL for the tenant id. REFUSED BY: the state token is
//      `gs1.<stateId>.<tenantId>.<HMAC>` and the HMAC covers the tenant; an unsigned or resigned
//      token fails `timingSafeEqual` before any DB read happens ("bad_signature"). The tenant is then
//      used for the `withTenants([...])` read, so a signature that verifies still only ever opens the
//      tenant the signature names.
//  A3. Authorization-code replay — the same `code`+`state` presented twice (double-click, history
//      re-submit, or an attacker who captured a callback URL). REFUSED BY: consumption is an atomic
//      `UPDATE … WHERE consumed_at IS NULL RETURNING`; the second presentation matches ZERO rows
//      ("already_consumed"). This is a database-enforced property, not a check-then-act.
//  A4. PKCE downgrade / verifier theft — an attacker with the authorization code but not the verifier
//      tries to exchange it. REFUSED BY: `code_challenge_method` is CHECK-constrained to S256 in the
//      migration (no `plain`), and the verifier is stored SEALED (`enc:v1:` AES-256-GCM), so reading
//      the row is not enough to complete the exchange.
//  A5. Redirect-URI substitution — a stale/rotated redirect URI completing against the new config.
//      REFUSED BY: the row records the redirect_uri it was issued for, re-compared at callback
//      ("redirect_uri_mismatch").
//  A6. Provider confusion — a state issued for Search Console redeemed as an Ads connection (which
//      would attach ads-scoped tokens to a gsc connection row). REFUSED BY: the caller states the
//      provider it expects and it must match the row ("provider_mismatch").
//  A7. Cross-tenant state read — a signed state from tenant A used while acting in tenant B. REFUSED
//      BY: FORCE RLS on google_oauth_states (0076) + the signed tenant being the ONLY tenant
//      put into `withTenants`. There is no code path that reads a state row outside its own tenant.
//  A8. Stale in-flight requests accumulating with live verifiers — REFUSED BY: a short TTL
//      (`GOOGLE_OAUTH_STATE_TTL_SECONDS`, default 600s) enforced in the consume predicate itself, not
//      merely by a sweep, so an unpruned row is still unusable.
//
// NOT CLOSED HERE, and named so it is not assumed: the consent screen itself, and whether Google
// enforces PKCE/redirect-URI matching the way we assume, are SM-41G facts. A green run of this file's
// tests proves OUR half of the protocol against OUR model of an issuer (and against a real Keycloak),
// not that Google accepts it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";

import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { encryptSecret, decryptSecret } from "../secret-box";
import { GoogleOAuthNotConfiguredError, GoogleOAuthStateError, type StateFailureReason } from "./errors";
import { hostLabel, isGoogleHost } from "./hosts";

// WD-23A-1: the provider union moved to ./registry (it gained `google_drive`). Re-exported here so
// every existing importer of `oauth-state`'s union keeps resolving.
export { GOOGLE_PROVIDERS, isGoogleProvider } from "./registry";
export type { GoogleProvider, GoogleOwnerKind } from "./registry";
import type { GoogleProvider, GoogleOwnerKind } from "./registry";


/** The `withTenants` options a surface's rows require.
 *
 *  THE RULE, and it is the heart of WD-23A-1: `app_module_allowed(mod)` reads the REQUEST-DECLARED
 *  `app.scopes` GUC (migration 0028) — it is NOT about which modules a company has enabled. So the row's
 *  `module` column and the request's declared module scope must MATCH, and the policy checks exactly
 *  that. A surface stamping `module:'search'` therefore keeps declaring `{modules:['search']}` on every
 *  read and write of its own rows, which is what makes 0060's wall byte-equivalent after the promotion.
 *  A core surface (`module: null`) declares nothing, and its rows carry no module requirement.
 *
 *  Getting this wrong in the safe-LOOKING direction — dropping `module` from the row — would have
 *  silently deleted search's third wall during a refactor. Getting it wrong the other way, as the first
 *  draft of this file did, fails loudly and immediately: every INSERT is refused by WITH CHECK.
 */
function moduleScope(module: string | null | undefined): { modules: string[] } | undefined {
  return module ? { modules: [module] } : undefined;
}

const STATE_TOKEN_PREFIX = "gs1";

// ── PKCE (RFC 7636) ────────────────────────────────────────────────────────────────────────────────

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes → 43-char base64url verifier (RFC 7636 §4.1 allows 43-128 chars). */
export function generateCodeVerifier(): string {
  return b64url(randomBytes(32));
}

/** S256 only (RFC 7636 §4.2). `plain` is not implemented and the migration's CHECK forbids storing it. */
export function codeChallengeFor(verifier: string): string {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}

// ── The signed state token ─────────────────────────────────────────────────────────────────────────

/** Derived from the credential-vault key rather than adding a second secret to configure: if the vault
 *  key is absent, tokens could not be sealed anyway, so there is nothing this flow could usefully do.
 *  Domain-separated by a fixed label so this HMAC key can never coincide with the AES key's own use. */
function stateSigningKey(): Buffer {
  const b64 = config.integrationTokenKey;
  if (!b64) throw new GoogleOAuthNotConfiguredError(["INTEGRATION_TOKEN_KEY"]);
  return createHmac("sha256", Buffer.from(b64, "base64")).update("gaiada:search:google:oauth-state:v1").digest();
}

function signingInput(stateId: string, tenantId: string): string {
  return `${STATE_TOKEN_PREFIX}.${b64url(Buffer.from(stateId, "utf8"))}.${b64url(Buffer.from(tenantId, "utf8"))}`;
}

/** `gs1.<b64url(stateId)>.<b64url(tenantId)>.<b64url(HMAC-SHA256)>`. The tenant travels INSIDE the
 *  signature (A2) so the callback needs no tenant in its URL — which is what lets a single, exactly-
 *  registered redirect URI serve every company, as real Google requires (no wildcard redirect URIs). */
export function signStateToken(stateId: string, tenantId: string): string {
  const input = signingInput(stateId, tenantId);
  return `${input}.${b64url(createHmac("sha256", stateSigningKey()).update(input).digest())}`;
}

export interface ParsedStateToken {
  stateId: string;
  tenantId: string;
}

/** Verify + unpack. Throws GoogleOAuthStateError (→ 400, coarse message) on anything unusable; the
 *  specific reason is carried in the error's server-side `detail`, never spelled out to the caller. */
export function parseStateToken(token: string): ParsedStateToken {
  const parts = (token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== STATE_TOKEN_PREFIX) throw new GoogleOAuthStateError("malformed_state");
  let stateId: string;
  let tenantId: string;
  try {
    stateId = Buffer.from(parts[1], "base64url").toString("utf8");
    tenantId = Buffer.from(parts[2], "base64url").toString("utf8");
  } catch {
    throw new GoogleOAuthStateError("malformed_state");
  }
  if (!stateId || !tenantId) throw new GoogleOAuthStateError("malformed_state");
  // Recompute over the CANONICAL re-encoding of the decoded ids, not over the caller's own first two
  // segments: that way a token whose segments decode to the same ids but are spelled differently
  // (padding, alternate base64 alphabet) cannot present a second valid form of the same state.
  const expected = createHmac("sha256", stateSigningKey()).update(signingInput(stateId, tenantId)).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(parts[3], "base64url");
  } catch {
    throw new GoogleOAuthStateError("bad_signature");
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    throw new GoogleOAuthStateError("bad_signature");
  }
  return { stateId, tenantId };
}

// ── Persistence ────────────────────────────────────────────────────────────────────────────────────

export interface CreateAuthorizationStateInput {
  tenantId: string;
  /** WHO the resulting credential belongs to, mirroring integration_connections. Replaces the old
   *  `clientId` + its NOT NULL FK to clients(id), which was structurally wrong for a Drive link (owned
   *  by a USER). Losing that FK costs no tenant safety: FK checks run as the table owner, OUTSIDE RLS —
   *  the protection is, and always was, that every read/write goes through withTenants([signedTenant]). */
  ownerKind: GoogleOwnerKind;
  ownerId: string;
  /** Optional destination the completed connection should bind to, interpreted by the surface's own
   *  post-link hook (search: a search_properties id). Was `propertyId`. */
  bindTargetId?: string | null;
  /** The module whose third wall applies to this row, or null for a core surface. Stamped, not assumed. */
  module?: string | null;
  provider: GoogleProvider;
  redirectUri: string;
  scopes: string[];
  /** The authorize endpoint this request is being sent to — decides `simulated` + `issuer_host`. */
  authorizeUrl: string;
  createdBy: string | null;
}

export interface CreatedAuthorizationState {
  stateId: string;
  stateToken: string;
  codeVerifier: string;
  codeChallenge: string;
  expiresAt: string;
  issuerHost: string;
  /** §A12.2 provenance: false ONLY when the authorize endpoint is Google's own host. */
  simulated: boolean;
}

/** Create the row + the signed token. The verifier is returned to the caller ONLY so the caller can
 *  hand it straight back on the exchange in the same process if it wishes; the durable copy in the row
 *  is sealed, and `consumeAuthorizationState` is the normal way to get it back. */
export async function createAuthorizationState(
  input: CreateAuthorizationStateInput,
): Promise<CreatedAuthorizationState> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = codeChallengeFor(codeVerifier);
  // Seal BEFORE opening a transaction, so an unconfigured vault (503) aborts with no DB write at all —
  // the same ordering discipline setConnectionTokens uses.
  const verifierEnc = encryptSecret(codeVerifier);
  // Derived, never caller-supplied: a caller cannot ask for a row to be stamped "real Google".
  const simulated = !isGoogleHost(input.authorizeUrl);
  const issuerHost = hostLabel(input.authorizeUrl);
  const stateId = newId();
  const expiresAt = new Date(Date.now() + config.google.stateTtlSeconds * 1000).toISOString();

  await withTenants(
    [input.tenantId],
    (c) =>
      c.query(
        `INSERT INTO google_oauth_states
           (id, tenant_id, owner_kind, owner_id, module, bind_target_id, provider, code_verifier_enc,
            code_challenge, code_challenge_method, redirect_uri, scopes, issuer_host, simulated,
            created_by, expires_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'S256', $10, $11, $12, $13, $14, $15, $16)`,
        [
          stateId, input.tenantId, input.ownerKind, input.ownerId, input.module ?? null,
          input.bindTargetId ?? null, input.provider, verifierEnc, codeChallenge, input.redirectUri,
          input.scopes, issuerHost, simulated, input.createdBy, expiresAt, config.originSite,
        ],
      ),
    moduleScope(input.module),
  );

  return {
    stateId,
    stateToken: signStateToken(stateId, input.tenantId),
    codeVerifier,
    codeChallenge,
    expiresAt,
    issuerHost,
    simulated,
  };
}

export interface ConsumedAuthorizationState {
  stateId: string;
  tenantId: string;
  ownerKind: GoogleOwnerKind;
  ownerId: string;
  /** The module stamped at mint time, or null for a core surface. */
  module: string | null;
  /** Was `propertyId`; its meaning belongs to the surface's own post-link hook. */
  bindTargetId: string | null;
  provider: GoogleProvider;
  codeVerifier: string;
  redirectUri: string;
  scopes: string[];
  issuerHost: string;
  simulated: boolean;
  createdBy: string | null;
}

export interface ConsumeExpectations {
  /** The redirect URI currently configured — must match the one the row was issued for (A5). */
  redirectUri: string;
  /** The calling principal's user id. Must equal the row's `created_by` (A1). Pass `null` ONLY when
   *  the row itself has no creator, which the check below then requires to be true on both sides. */
  principalUserId: string | null;
  /** The provider the caller believes it is completing (A6). */
  provider: GoogleProvider;
  /** The module whose rows the caller is entitled to consume, or null/absent for a core surface.
   *
   *  Required as an EXPECTATION rather than read from the row, because the row cannot be read at all
   *  without declaring the scope first — that is the point of the wall. A caller that declares the
   *  wrong module (or none, for a module row) matches zero rows and gets the same coarse
   *  `unknown_or_expired` as a forged state, which is the correct outcome: it must not be able to tell
   *  "exists but not mine" from "does not exist". */
  module?: string | null;
}

interface StateDbRow {
  id: string;
  tenant_id: string;
  owner_kind: GoogleOwnerKind;
  owner_id: string;
  module: string | null;
  bind_target_id: string | null;
  provider: string;
  code_verifier_enc: string;
  redirect_uri: string;
  scopes: string[];
  issuer_host: string;
  simulated: boolean;
  created_by: string | null;
}

/** Single-use consume. The `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING` is the
 *  whole anti-replay mechanism (A3/A8): it is one atomic statement, so two concurrent callbacks cannot
 *  both win, and an expired row is unusable even if the pruning sweep has not run.
 *
 *  ORDERING IS DELIBERATE: the row is claimed FIRST, then the binding facts are checked. A caller who
 *  presents a valid state but fails the redirect/principal/provider checks has still SPENT it. That is
 *  the safe direction — a state that has been fed into a failing callback attempt is exactly the state
 *  an attacker would want to retry. */
export async function consumeAuthorizationState(
  stateToken: string,
  expect: ConsumeExpectations,
): Promise<ConsumedAuthorizationState> {
  const { stateId, tenantId } = parseStateToken(stateToken);

  const row = await withTenants(
    [tenantId],
    async (c: PoolClient) => {
      const res = await c.query<StateDbRow>(
        `UPDATE google_oauth_states
            SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
          RETURNING id, tenant_id, owner_kind, owner_id, module, bind_target_id, provider, code_verifier_enc, redirect_uri,
                    scopes, issuer_host, simulated, created_by`,
        [stateId],
      );
      return res.rows[0] ?? null;
    },
    moduleScope(expect.module),
  );

  if (!row) {
    // Deliberately ONE reason for three distinct situations (never created / expired / already
    // consumed). Distinguishing them for the caller would hand a prober a state-existence oracle, and
    // no legitimate client can act differently on the distinction: all three mean "start again".
    throw new GoogleOAuthStateError("unknown_or_expired");
  }
  if (row.redirect_uri !== expect.redirectUri) throw new GoogleOAuthStateError("redirect_uri_mismatch");
  if ((row.created_by ?? null) !== (expect.principalUserId ?? null)) {
    throw new GoogleOAuthStateError("principal_mismatch");
  }
  if (row.provider !== expect.provider) throw new GoogleOAuthStateError("provider_mismatch");

  return {
    stateId: row.id,
    tenantId: row.tenant_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    module: row.module,
    bindTargetId: row.bind_target_id,
    provider: row.provider as GoogleProvider,
    codeVerifier: decryptSecret(row.code_verifier_enc),
    redirectUri: row.redirect_uri,
    scopes: row.scopes ?? [],
    issuerHost: row.issuer_host,
    simulated: row.simulated,
    createdBy: row.created_by,
  };
}

/** Link the completed connection back onto the (already-consumed) state row, for audit. Best-effort by
 *  design: a failure here must never undo a successfully-linked credential, so callers swallow it —
 *  the §4d secondary-failure template (the primary outcome survives an audit-write failure). */
export async function attachConnectionToState(
  tenantId: string,
  stateId: string,
  connectionId: string,
  /** The module the row was stamped with — required to reach it at all (see moduleScope). */
  module?: string | null,
): Promise<void> {
  await withTenants(
    [tenantId],
    (c) => c.query(`UPDATE google_oauth_states SET connection_id = $2 WHERE id = $1`, [stateId, connectionId]),
    moduleScope(module),
  );
}

/** Housekeeping: drop expired, never-consumed requests for one tenant. Not a security control (the
 *  consume predicate already refuses expired rows — A8); this just keeps sealed verifiers from
 *  accumulating. Returns the number of rows removed. */
export async function pruneExpiredAuthorizationStates(
  tenantId: string,
  /** Prunes only rows of THIS module (or only core rows when absent). Deliberately not a global sweep:
   *  a caller cannot reach another surface's rows, so housekeeping cannot become a cross-module delete. */
  module?: string | null,
): Promise<number> {
  const res = await withTenants(
    [tenantId],
    (c) => c.query(`DELETE FROM google_oauth_states WHERE consumed_at IS NULL AND expires_at <= now()`),
    moduleScope(module),
  );
  return res.rowCount ?? 0;
}
