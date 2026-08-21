// SMM-38 phase 38b — OAuth TOKEN CUSTODY for the `direct` driver (owner decision D-20, design
// addendum §PD). Migration: `migrations/202608201518_social_oauth_tokens.sql` (`social_oauth_tokens`,
// THIRD RLS wall — see that file's header for the wall justification).
//
// ── WHAT THIS FILE OWNS ──────────────────────────────────────────────────────────────────────────
//   1. Sealing/opening tokens through `core/secret-box.ts` — the estate's ONE existing app-layer
//      credential vault, already used by `integration_connections` (0033) for exactly this job. This
//      file does NOT invent a second scheme; see the migration header for why that is the right call
//      and why the wa-chat-bot two-axis (subject × entity) OpenBao envelope is a different service's
//      answer to a different question (message-content PII, not a single OAuth grant).
//   2. Fail-closed resolution: `resolveActiveAccessToken` refuses a revoked or expired grant with a
//      TYPED reason and never falls back to a stale or NULL token — the ticket's own "revocation
//      fails closed" requirement, enforced twice over (the `status` check here AND the migration's
//      `sot_shred_contract`, which makes a revoked row physically incapable of holding ciphertext).
//   3. The shred: `revokeOAuthGrant` NULLs both ciphertext columns in the SAME statement that flips
//      `status`, mirroring `core/integrations.service.ts`'s `revokeConnection` byte-for-byte. The row
//      survives as an audit shell (who/when/why), exactly like SMM-36's inbox purge preserves a
//      thread/message shell after scrubbing its content.
//   4. The refresh-ahead / purge seam: `registerTokenRefresher` is a per-network registration slot
//      (same shape as `publisher/registry.ts`'s driver map and `publish-precondition.ts`'s
//      `setCreatorInfoVerifier`), EMPTY in this phase — 38b ships no OAuth client for any network, so
//      there is nothing to call yet (this phase's own DO-NOT-DO list forbids a network call). 38c/38d
//      register LinkedIn's/YouTube's real token-endpoint client here; nothing else about this file
//      changes when they do. `purgeOAuthTokens` is the `RetentionPurger`-shaped function registered
//      into SMM-36's seam (`inbox-retention-job.ts`, key `'oauth_tokens'`): on the SAME per-tenant,
//      already-module-scoped transaction, it (a) attempts a refresh for any grant within
//      `aheadMs` of `expires_at` THROUGH a registered refresher, and (b) shreds any grant that ever
//      reaches `expires_at` unrefreshed (no refresher registered, or the refresh attempt itself
//      failed) to `status='expired'`. With zero refreshers registered, (a) is a no-op count and (b)
//      is the only branch that can ever fire — which is the correct, honest behaviour for a phase
//      that ships no live OAuth client: a grant nobody can refresh is exactly a grant that should
//      expire, not one that should be pretended-current.
//
// ── DISCIPLINE THIS FILE MUST NOT VIOLATE (mirrors `publisher/keys.ts`'s header) ────────────────
// Nothing here may log, return, or embed a token — sealed OR plaintext. `resolveActiveAccessToken`
// returns a `ResolvedAccessToken` handle (mirrors `types.ts`'s `OrgHandle`): the plaintext is reachable
// only through `.secret()`, and both `JSON.stringify` and `util.inspect` (pino/console.log/Vitest's
// own diff renderer all end up calling the latter) are overridden to emit `[redacted]`.
import type { PoolClient } from "pg";
import { ServiceUnavailableException } from "@nestjs/common";
import { decryptSecret, encryptSecret } from "../../../core/secret-box";
import type { Network } from "../media-rules";
import { registerRetentionPurger, type PurgerCounts } from "../inbox-retention-job";
import { declareSocialModuleScope } from "../publish-precondition";

// ── Typed refusals ──────────────────────────────────────────────────────────────────────────────
export type OAuthTokenRefusalCode =
  /** No live grant row for this account at all (never connected, or already purged/shredded). */
  | "oauth_token_not_found"
  /** The grant was explicitly revoked. FAILS CLOSED — never falls back to a cached/stale value. */
  | "oauth_token_revoked"
  /** The grant's access token lapsed and was never refreshed (no refresher registered for the
   *  network, or the refresh attempt failed) — shredded by the purge sweep. Same fail-closed
   *  guarantee as revoked: there is no stale plaintext anywhere to fall back to. */
  | "oauth_token_expired"
  /** `INTEGRATION_TOKEN_KEY` is unset or malformed — secret-box.ts's own fail-closed 503, re-typed
   *  here so every caller in this module branches on ONE discriminated union rather than mixing this
   *  file's codes with a raw Nest `ServiceUnavailableException`. */
  | "oauth_vault_not_configured";

export class OAuthTokenError extends Error {
  constructor(readonly code: OAuthTokenRefusalCode, message: string) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

/** A resolved, live access token. The plaintext is reachable ONLY through `.secret()` — see the file
 *  header. Never assign `.secret()`'s result to a variable that outlives the one call it authorizes. */
export class ResolvedAccessToken {
  constructor(
    readonly accountId: string,
    readonly network: Network,
    readonly expiresAt: Date,
    private readonly token: string,
  ) {}

  secret(): string {
    return this.token;
  }

  toJSON(): Record<string, unknown> {
    return {
      accountId: this.accountId, network: this.network,
      expiresAt: this.expiresAt.toISOString(), accessToken: "[redacted]",
    };
  }

  toString(): string {
    return `ResolvedAccessToken(${this.accountId})`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `ResolvedAccessToken(${this.accountId}) { accessToken: [redacted] }`;
  }
}

interface TokenRow {
  status: "active" | "revoked" | "expired";
  network: Network;
  access_token_enc: string | null;
  expires_at: Date;
}

/** Wraps secret-box.ts's own 503 into this file's discriminated union so a caller never has to know
 *  two different exception vocabularies for the same underlying fact ("no usable key"). */
function sealOrRefuseVaultNotConfigured<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    // secret-box.ts's ServiceUnavailableException is the ONLY error either encryptSecret/decryptSecret
    // throw for a missing/malformed key; a malformed enc:v1 envelope or a failed auth tag throws a
    // plain Error instead, which must NOT be reclassified as "vault not configured" (that would tell
    // an operator to check an env var when the real problem is corrupt/tampered ciphertext).
    if (err instanceof ServiceUnavailableException) {
      throw new OAuthTokenError("oauth_vault_not_configured", (err as Error).message);
    }
    throw err;
  }
}

/** Seal + upsert a live grant for `accountId`. Called by 38c/38d's OAuth callback finalize route
 *  once one exists — 38b ships this function so that route has something to call on day one of
 *  38c, but nothing in THIS phase calls it (no OAuth client exists yet).
 *
 *  UPSERTs on the table's `UNIQUE (account_id)`: a re-consent on an already-connected account
 *  replaces the grant in place (including clearing any prior revoked/expired shell state) rather
 *  than erroring or accumulating a second row. */
export async function storeOAuthGrant(
  c: PoolClient,
  args: {
    tenantId: string;
    accountId: string;
    network: Network;
    /** Plaintext — sealed immediately below and never retained past this call. */
    accessToken: string;
    refreshToken?: string | null;
    scopes?: string[];
    expiresAt: Date;
    refreshExpiresAt?: Date | null;
    grantedBy?: string | null;
  },
): Promise<void> {
  await declareSocialModuleScope(c);
  const accessTokenEnc = sealOrRefuseVaultNotConfigured(() => encryptSecret(args.accessToken));
  const refreshTokenEnc = args.refreshToken
    ? sealOrRefuseVaultNotConfigured(() => encryptSecret(args.refreshToken as string))
    : null;
  await c.query(
    `INSERT INTO social_oauth_tokens
       (tenant_id, account_id, network, access_token_enc, refresh_token_enc, token_key_version,
        scopes, expires_at, refresh_expires_at, status, last_refreshed_at, revoked_at, revoked_reason,
        granted_by, origin_site)
     VALUES ($1,$2,$3,$4,$5,'v1',$6,$7,$8,'active', now(), NULL, NULL, $9,'central')
     ON CONFLICT (account_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id, network = EXCLUDED.network,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       token_key_version = EXCLUDED.token_key_version, scopes = EXCLUDED.scopes,
       expires_at = EXCLUDED.expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
       status = 'active', last_refreshed_at = now(), revoked_at = NULL, revoked_reason = NULL,
       granted_by = EXCLUDED.granted_by, updated_at = now()`,
    [
      args.tenantId, args.accountId, args.network, accessTokenEnc, refreshTokenEnc,
      JSON.stringify(args.scopes ?? []), args.expiresAt, args.refreshExpiresAt ?? null,
      args.grantedBy ?? null,
    ],
  );
}

/** Resolve a LIVE, usable access token for `accountId`. FAILS CLOSED on every non-active path — see
 *  the refusal codes above. Never returns a stale token: a `revoked` or `expired` row's ciphertext
 *  columns are NULL by the migration's own `sot_shred_contract`, so even a caller that skipped the
 *  `status` check could not accidentally decrypt a shredded row's non-existent ciphertext — the
 *  status check exists to give a HONEST reason rather than a null-pointer, not as the only guard. */
export async function resolveActiveAccessToken(
  c: PoolClient, accountId: string,
): Promise<ResolvedAccessToken> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<TokenRow>(
    `SELECT status, network, access_token_enc, expires_at
       FROM social_oauth_tokens WHERE account_id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) {
    throw new OAuthTokenError("oauth_token_not_found", `no OAuth grant is on file for account ${accountId}`);
  }
  if (row.status === "revoked") {
    throw new OAuthTokenError(
      "oauth_token_revoked",
      `the OAuth grant for account ${accountId} was revoked — a revoked grant is never usable again; a fresh connect is required`,
    );
  }
  if (row.status === "expired" || !row.access_token_enc) {
    throw new OAuthTokenError(
      "oauth_token_expired",
      `the OAuth grant for account ${accountId} expired and was never refreshed — a fresh connect is required`,
    );
  }
  const plaintext = sealOrRefuseVaultNotConfigured(() => decryptSecret(row.access_token_enc as string));
  return new ResolvedAccessToken(accountId, row.network, row.expires_at, plaintext);
}

/** The crypto-shred. Sets `status`, stamps the audit trail, and NULLs both ciphertext columns in the
 *  SAME statement — mirroring `core/integrations.service.ts`'s `revokeConnection` exactly. Idempotent:
 *  revoking an already-revoked row is a no-op WHERE clause (status still lands on 'revoked' with the
 *  NEW reason/timestamp only on the first call that actually matches `status = 'active'`). */
export async function revokeOAuthGrant(
  c: PoolClient, accountId: string, reason: string,
): Promise<{ revoked: boolean }> {
  await declareSocialModuleScope(c);
  const { rowCount } = await c.query(
    `UPDATE social_oauth_tokens
        SET status = 'revoked', access_token_enc = NULL, refresh_token_enc = NULL,
            revoked_at = now(), revoked_reason = $2, updated_at = now()
      WHERE account_id = $1 AND status = 'active'`,
    [accountId, reason],
  );
  return { revoked: (rowCount ?? 0) > 0 };
}

// ── Refresh-ahead / purge seam ──────────────────────────────────────────────────────────────────

/** What a refresher returns on success. Never re-embed the OLD token anywhere in here. */
export interface RefreshedGrant {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date;
  refreshExpiresAt?: Date | null;
}

/** A per-network token refresher — the real HTTP call against that network's token endpoint. NONE
 *  is registered in 38b (no OAuth client exists yet for any network); 38c/38d each register their
 *  own. Receives the DECRYPTED refresh token for exactly the one call that needs it and must not
 *  retain, log, or return it beyond that call. */
export type TokenRefresher = (grant: {
  accountId: string; network: Network; refreshToken: string;
}) => Promise<RefreshedGrant>;

const refreshers = new Map<Network, TokenRefresher>();

/** Register (or replace) a network's refresher. Exported for 38c/38d. */
export function registerTokenRefresher(network: Network, refresher: TokenRefresher): void {
  refreshers.set(network, refresher);
}

/** Test/boot seam, matching `resetPublishers()`/`resetRetentionPurgers()`. Restores the EMPTY
 *  registry — unlike `resetRetentionPurgers`, empty IS this file's correct baseline: 38b registers
 *  no refresher for anything, and a test that forgets to call this still runs against "no live
 *  refresher for any network" rather than a previous test's stub leaking across files. */
export function resetTokenRefreshers(): void {
  refreshers.clear();
}

interface RefreshCandidateRow {
  account_id: string;
  network: Network;
  refresh_token_enc: string | null;
}

/** The `RetentionPurger`-shaped function registered into SMM-36's seam
 *  (`inbox-retention-job.ts`, key `'oauth_tokens'`). Runs on an ALREADY tenant + module-scoped
 *  transaction (the caller declared it before this runs — see that file's header) — this function
 *  does NOT call `declareSocialModuleScope` again, per that seam's own instruction.
 *
 *  Two passes, in order:
 *    (a) REFRESH-AHEAD — every `active` grant within `aheadMs` of `expires_at` that HAS a registered
 *        refresher for its network gets one refresh attempt. Success re-seals and re-stamps
 *        `expires_at`/`last_refreshed_at` in place; failure is counted and left for the next sweep
 *        (never auto-retried within this same pass — a transient failure gets another whole
 *        `aheadMs` window of tries before the grant actually lapses).
 *    (b) SHRED — every grant that is PAST `expires_at` and still `active` (nothing refreshed it in
 *        time, in this pass or any prior one) is shredded to `expired` via the exact same statement
 *        shape as `revokeOAuthGrant`.
 *  With zero refreshers registered (38b's shipped state), pass (a) always counts 0 refreshed and
 *  pass (b) is the only one that can ever act — the honest behaviour for a phase with no live OAuth
 *  client: a grant nobody can refresh is a grant that expires, not one this code should pretend is
 *  still current. */
export async function purgeOAuthTokens(
  c: PoolClient, tenantId: string, now: Date, aheadMs = 24 * 3600 * 1000,
): Promise<PurgerCounts> {
  const counts: PurgerCounts = { refreshed: 0, refreshFailed: 0, refreshSkippedNoRefresher: 0, shredded: 0 };

  // (a) refresh-ahead. `aheadSecs` is computed in JS (never `$n - make_interval(...)` inside the
  // query) — this module's own sibling ticket (SMM-36's tracker entry) named the exact trap of
  // letting Postgres infer a bind parameter's type from its position in a `make_interval(...)`
  // expression; binding an already-converted plain number to the named `secs =>` argument sidesteps
  // that inference question entirely.
  const aheadSecs = aheadMs / 1000;
  const { rows: due } = await c.query<RefreshCandidateRow>(
    `SELECT account_id, network, refresh_token_enc
       FROM social_oauth_tokens
      WHERE tenant_id = $1 AND status = 'active'
        AND expires_at > $2 AND expires_at <= $2::timestamptz + make_interval(secs => $3)`,
    [tenantId, now, aheadSecs],
  );
  for (const row of due) {
    const refresher = refreshers.get(row.network);
    if (!refresher || !row.refresh_token_enc) {
      counts.refreshSkippedNoRefresher += 1;
      continue;
    }
    try {
      const refreshToken = decryptSecret(row.refresh_token_enc);
      const result = await refresher({ accountId: row.account_id, network: row.network, refreshToken });
      const accessTokenEnc = encryptSecret(result.accessToken);
      const refreshTokenEnc = result.refreshToken ? encryptSecret(result.refreshToken) : row.refresh_token_enc;
      await c.query(
        `UPDATE social_oauth_tokens
            SET access_token_enc = $2, refresh_token_enc = $3, expires_at = $4,
                refresh_expires_at = COALESCE($5, refresh_expires_at), last_refreshed_at = now(),
                updated_at = now()
          WHERE account_id = $1 AND status = 'active'`,
        [row.account_id, accessTokenEnc, refreshTokenEnc, result.expiresAt, result.refreshExpiresAt ?? null],
      );
      counts.refreshed += 1;
    } catch {
      // A network/token-endpoint failure here must never abort the sweep for every other tenant's
      // other grants (same discipline as `runInboxRetentionPurge`'s per-tenant try/catch, one level
      // down) — counted, left `active`, retried on the next sweep within the SAME aheadMs window.
      counts.refreshFailed += 1;
    }
  }

  // (b) shred anything that reached expiry unrefreshed
  const shredded = await c.query(
    `UPDATE social_oauth_tokens
        SET status = 'expired', access_token_enc = NULL, refresh_token_enc = NULL, updated_at = now()
      WHERE tenant_id = $1 AND status = 'active' AND expires_at <= $2`,
    [tenantId, now],
  );
  counts.shredded = shredded.rowCount ?? 0;

  return counts;
}

// ── Boot wiring ─────────────────────────────────────────────────────────────────────────────────

/** Called once from `main.ts`, alongside `wireSocialPublisher()` (that ticket's own header names
 *  exactly this placement: "at module boot, alongside wherever 38b registers its publisher driver").
 *  Registers `purgeOAuthTokens` into SMM-36's seam under the key `'oauth_tokens'` — no new job, no
 *  new schedule, no network call.
 *
 *  ⚠ STALE-COMMENT UPDATE (SMM-38 phase 38c, this module's own defect class #4b): this header used
 *  to say "deliberately does NOT call `registerTokenRefresher` for anything" and "does NOT register
 *  the `direct` driver" — both TRUE for 38b, both now WRONG for 38c. `boot.ts#wireSocialPublisher`
 *  now registers `direct` (real LinkedIn capability) AND calls `registerLinkedInTokenRefresher()`
 *  (`linkedin-oauth.ts`) — NOT from this function, which still only wires the purge seam, but from
 *  its own sibling call in `main.ts`/`boot.ts`. See `publisher/boot.ts`'s header for how the
 *  `resolvePublisher` empty-registry heuristic was fixed (not left broken) to keep that registration
 *  behaviourally inert on every live path today. */
export function wireOAuthTokenCustody(): void {
  registerRetentionPurger("oauth_tokens", purgeOAuthTokens);
}
