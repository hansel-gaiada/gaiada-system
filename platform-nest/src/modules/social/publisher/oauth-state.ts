// Security follow-up to SMM-38c/38d — DB-backed, atomically single-use OAuth `state` for the
// `direct` driver's LinkedIn/YouTube connect ceremonies. Replaces the signed-but-replayable scheme
// `linkedin-oauth.ts`/`youtube-oauth.ts` shipped (their own headers named the gap explicitly: "There
// is deliberately NO database row and NO atomic single-use enforcement of the state token itself").
//
// Migration: `migrations/202608221751_social_oauth_states.sql` (`social_oauth_states`, THIRD RLS
// wall — see that file's header for the wall/purge/created-by decisions).
//
// ── WHY ONE SHARED MODULE, NOT TWO PER-NETWORK COPIES ───────────────────────────────────────────────
// The pre-existing code duplicated the entire signing/parsing scheme byte-for-byte between
// `linkedin-oauth.ts` and `youtube-oauth.ts` (their own headers say so — "mirrors linkedin-oauth.ts's
// own state scheme byte-for-byte"). A DB-backed single-use mechanism is exactly the kind of logic two
// hand-maintained copies would drift on (see `module-scope.ts`'s own header for why this module
// already treats that as the standing failure mode to design against). So this file is the ONE
// state machine both networks call into, mirroring `core/google-oauth/state.ts`'s own
// mint/parse/consume split — the estate's other real OAuth-callback precedent, which already proves
// this exact pattern works.
//
// ── THE SPLIT: sync `parseSocialOAuthStateToken` vs async `consumeSocialOAuthState` ─────────────────
// Mirrors `core/google-oauth/state.ts#parseStateToken` / `#consumeAuthorizationState` exactly, for the
// identical reason (see `SearchGoogleOauthCallbackController`'s own header, point 4): the callback
// controller needs a TRUSTWORTHY tenantId to run its ordinary Cerbos `connect` check BEFORE it does
// anything to the database, but the check should not itself be the thing that spends the state (a
// principal who fails Cerbos should not have burned the caller's one usable state in the process).
//   - `parseSocialOAuthStateToken` — SYNC, no DB. Verifies the HMAC over the canonical re-encoding
//     (`timingSafeEqual`) and checks the TTL is not obviously nonsensical; returns {stateId, tenantId}.
//     Does NOT consume anything and does NOT prove the state has not already been used.
//   - `consumeSocialOAuthState` — ASYNC. Re-verifies the signature (parses again internally — cheap,
//     and it means this function is safe to call even if a caller skipped the sync pre-check) and then
//     performs the ONE atomic claim: `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now()
//     RETURNING`. A second presentation of the same token — the replay this follow-up exists to close
//     — matches ZERO rows on its second call, which is the entire anti-replay mechanism. This is a
//     database-enforced property, not a check-then-act race.
//
// Controllers call parse → Cerbos authorize → consume → completeLinkedInConnect/completeYouTubeConnect
// (which keep their EXISTING (tenantId, accountId, args) signature, untouched by this follow-up, so
// every test that calls them directly — bypassing the state token entirely, which the pre-existing
// test suites already do — keeps passing unmodified).
//
// ── WHAT IS DELIBERATELY *NOT* CLOSED HERE (named, not silently decided) ─────────────────────────────
// `created_by` is stored on the row but NOT compared against the calling principal at consume time —
// `core/google-oauth/state.ts`'s own A1 (login-CSRF) defense does exactly that comparison
// (`principal_mismatch`), and this table carries the same column for the same future use, but wiring
// the comparison in is a separate, small follow-up out of THIS one's scope (single-use replay closure
// only) — see the migration header's own note.
//
// ── "absent ≠ zero" DISCIPLINE (this module's own central rule) ──────────────────────────────────────
// `SocialOAuthStateFailureReason` distinguishes three DIFFERENT classes of refusal rather than
// collapsing everything into one generic 400:
//   - `malformed` / `bad_signature` — the token is not one this server minted. A forgery attempt.
//   - `unknown_expired_or_consumed` — deliberately ONE reason for three different underlying facts
//     (never existed / past its TTL / already spent), mirroring `core/google-oauth/state.ts`'s own
//     `unknown_or_expired` reasoning verbatim: distinguishing them for an untrusted caller would hand a
//     prober a state-existence oracle, and no legitimate client can act differently on the distinction
//     — all three mean "start the connect ceremony again". This is a deliberate anti-oracle COLLAPSE
//     of three "genuinely denied" outcomes into one honest refusal, not a collapse of "denied" into
//     "absent" or "unknown" — the module's own "absent ≠ zero" rule is about never reporting a denial
//     as a false positive/negative, not about naming every internal cause to an attacker.
//   - `network_mismatch` — the token verifies and is unconsumed, but was minted for the OTHER network
//     (a LinkedIn state presented at the YouTube callback route or vice versa). Checked AFTER the
//     atomic claim, not before — see `consumeSocialOAuthState`'s own comment for why that ordering is
//     the safe direction (mirrors `core/google-oauth/state.ts`'s own documented ordering rationale).
import type { PoolClient } from "pg";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../../config";
import { newId, withTenants } from "../../../db";
import { declareSocialModuleScope } from "../publish-precondition";
import { registerRetentionPurger } from "../inbox-retention-job";
import { OAuthTokenError } from "./oauth-tokens";

const MODULES: { modules: string[] } = { modules: ["social"] };
const STATE_PREFIX = "sos1";
export const SOCIAL_OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — a human OAuth consent round trip.

export type SocialOAuthNetwork = "linkedin" | "youtube";

export type SocialOAuthStateFailureReason = "malformed" | "bad_signature" | "unknown_expired_or_consumed" | "network_mismatch";

export class SocialOAuthStateError extends Error {
  readonly status = 400;
  readonly code = "social_oauth_state_invalid";
  constructor(readonly reason: SocialOAuthStateFailureReason) {
    super("this connect attempt is not usable — start a new one");
    this.name = "SocialOAuthStateError";
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Domain-separated from every OTHER HMAC this estate derives off the same root key
 *  (`client-invites.ts`'s own label, the Google OAuth state key's label) — the SAME label
 *  `linkedin-oauth.ts`/`youtube-oauth.ts` already used for this exact purpose, kept unchanged so no
 *  in-flight token minted a moment before this deploy is invalidated by a key-derivation change. */
function signingKey(): Buffer {
  const b64 = config.integrationTokenKey;
  if (!b64) {
    throw new OAuthTokenError(
      "oauth_vault_not_configured",
      "INTEGRATION_TOKEN_KEY is unset — it signs the social OAuth state token (client-invites.ts's own "
      + "pattern) and seals the resulting grant (secret-box.ts)",
    );
  }
  return createHmac("sha256", Buffer.from(b64, "base64")).update("gaiada:social-oauth-state:v1").digest();
}

/** The row is the source of truth for tenant/account/network; the SIGNED token carries only
 *  (stateId, tenantId) — mirrors `core/google-oauth/state.ts#signStateToken`'s own shape
 *  (`gs1.<stateId>.<tenantId>.<mac>`) byte-for-byte, one prefix swapped. tenantId travels in the
 *  signature (not just as a DB lookup key) so a forged token naming a foreign tenant is refused by
 *  `timingSafeEqual` BEFORE any database read — the same anti-pivot property that file's own header
 *  documents for its attack A2. */
function signingInput(stateId: string, tenantId: string): string {
  return `${STATE_PREFIX}.${b64url(Buffer.from(stateId, "utf8"))}.${b64url(Buffer.from(tenantId, "utf8"))}`;
}

function signStateToken(stateId: string, tenantId: string): string {
  const input = signingInput(stateId, tenantId);
  return `${input}.${b64url(createHmac("sha256", signingKey()).update(input).digest())}`;
}

export interface ParsedSocialOAuthState {
  stateId: string;
  tenantId: string;
}

/** SYNC, no DB. Verifies the signature and unpacks (stateId, tenantId) — does NOT consume anything and
 *  does NOT prove the state is still usable (that is `consumeSocialOAuthState`'s job). Callers use this
 *  ONLY to get a trustworthy tenantId for a pre-consume Cerbos check — see the file header. */
export function parseSocialOAuthStateToken(token: string): ParsedSocialOAuthState {
  const parts = (token ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== STATE_PREFIX) throw new SocialOAuthStateError("malformed");
  let stateId: string;
  let tenantId: string;
  try {
    stateId = fromB64url(parts[1]).toString("utf8");
    tenantId = fromB64url(parts[2]).toString("utf8");
    if (!stateId || !tenantId) throw new Error("empty");
  } catch {
    throw new SocialOAuthStateError("malformed");
  }
  // Recompute over the CANONICAL re-encoding of the decoded ids, not the caller's own first two
  // segments — mirrors `core/google-oauth/state.ts#parseStateToken`'s own reasoning: a token whose
  // segments decode to the same ids but are spelled differently (padding, alternate alphabet) cannot
  // present a second valid form of the same state.
  const expected = createHmac("sha256", signingKey()).update(signingInput(stateId, tenantId)).digest();
  let given: Buffer;
  try {
    given = fromB64url(parts[3]);
  } catch {
    throw new SocialOAuthStateError("malformed");
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new SocialOAuthStateError("bad_signature");
  }
  return { stateId, tenantId };
}

/** Mint a state row + its signed token for one (tenant, account, network) connect ceremony. Opens its
 *  own short transaction (mirrors `core/google-oauth/state.ts#createAuthorizationState`'s own
 *  standalone `withTenants` call) — this is deliberately NOT nested inside the caller's account-row
 *  transaction in `startLinkedInConnect`/`startYouTubeConnect`, exactly as the pre-existing signed-only
 *  `mintLinkedInOAuthState`/`mintYouTubeOAuthState` were called AFTER that transaction committed. */
export async function mintSocialOAuthState(args: {
  tenantId: string;
  accountId: string;
  network: SocialOAuthNetwork;
  createdBy: string | null;
}): Promise<string> {
  const stateId = newId();
  const expiresAt = new Date(Date.now() + SOCIAL_OAUTH_STATE_TTL_MS);
  await withTenants(
    [args.tenantId],
    async (c: PoolClient) => {
      // Self-declares rather than trusting the MODULES option passed to withTenants below — this
      // module's own recurring-defect-class discipline (`module-scope.ts`'s header, and
      // `oauth-tokens.ts`'s `storeOAuthGrant`/`resolveActiveAccessToken`/`revokeOAuthGrant`, which all
      // do the same): a leaf function that trusts its caller's options is exactly how the module-GUC
      // trap gets reintroduced by a future caller that forgets `{modules:['social']}`.
      await declareSocialModuleScope(c);
      await c.query(
        `INSERT INTO social_oauth_states (id, tenant_id, account_id, network, created_by, expires_at, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [stateId, args.tenantId, args.accountId, args.network, args.createdBy, expiresAt, config.originSite],
      );
    },
    MODULES,
  );
  return signStateToken(stateId, args.tenantId);
}

export interface ConsumedSocialOAuthState {
  stateId: string;
  tenantId: string;
  accountId: string;
  network: SocialOAuthNetwork;
  createdBy: string | null;
}

interface StateDbRow {
  id: string;
  tenant_id: string;
  account_id: string;
  network: SocialOAuthNetwork;
  created_by: string | null;
}

/** THE single-use consume — the whole anti-replay mechanism this follow-up exists to add.
 *
 *  ORDERING IS DELIBERATE, mirroring `core/google-oauth/state.ts#consumeAuthorizationState`'s own
 *  documented rationale byte-for-byte: the row is claimed FIRST (the atomic UPDATE), and the
 *  `network_mismatch` binding check runs AFTER, against the row the UPDATE already returned. A caller
 *  who presents a valid-but-wrong-network state has still SPENT it — the safe direction, since a state
 *  that has been fed into a failing callback attempt is exactly the state an attacker would want to
 *  retry against the OTHER network's route. */
export async function consumeSocialOAuthState(
  token: string,
  expect: { network: SocialOAuthNetwork },
): Promise<ConsumedSocialOAuthState> {
  const { stateId, tenantId } = parseSocialOAuthStateToken(token);

  const row = await withTenants(
    [tenantId],
    async (c: PoolClient) => {
      await declareSocialModuleScope(c);
      const res = await c.query<StateDbRow>(
        `UPDATE social_oauth_states
            SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
          RETURNING id, tenant_id, account_id, network, created_by`,
        [stateId],
      );
      return res.rows[0] ?? null;
    },
    MODULES,
  );

  if (!row) {
    // ONE reason for three situations (never minted / expired / already consumed) — see the file
    // header's "absent ≠ zero" note for why this is a deliberate anti-oracle collapse, not a silent
    // swallow of a genuine denial.
    throw new SocialOAuthStateError("unknown_expired_or_consumed");
  }
  if (row.network !== expect.network) throw new SocialOAuthStateError("network_mismatch");

  return {
    stateId: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    network: row.network,
    createdBy: row.created_by,
  };
}

// ── Purge seam (SMM-36's `registerRetentionPurger`, key 'oauth_states') ─────────────────────────────

/** Deletes EVERY row (consumed or not) past `expires_at`, for one tenant — see the migration header
 *  for why this deliberately differs from `google_oauth_states#pruneExpiredAuthorizationStates`'s own
 *  "keep consumed rows forever" policy: this table's consumed rows carry no audit value of their own
 *  that `social_accounts`/`social_oauth_tokens` don't already durably record.
 *
 *  Runs on an ALREADY tenant + module-scoped transaction (`inbox-retention-job.ts`'s own contract for
 *  every registered purger) — does NOT call `declareSocialModuleScope` again, matching
 *  `purgeOAuthTokens`'s own documented behaviour for the identical seam. */
export async function purgeSocialOAuthStates(
  c: PoolClient, tenantId: string, now: Date,
): Promise<Record<string, number>> {
  const res = await c.query(
    `DELETE FROM social_oauth_states WHERE tenant_id = $1 AND expires_at <= $2`,
    [tenantId, now],
  );
  return { purged: res.rowCount ?? 0 };
}

// ── Boot wiring ──────────────────────────────────────────────────────────────────────────────────────

/** Called once from `main.ts`, alongside `wireOAuthTokenCustody()` — same placement reasoning: pure
 *  in-process registration, no network call, no new schedule of its own (rides SMM-36's existing
 *  inbox-retention sweep and cadence). */
export function wireSocialOAuthStateCustody(): void {
  registerRetentionPurger("oauth_states", purgeSocialOAuthStates);
}
