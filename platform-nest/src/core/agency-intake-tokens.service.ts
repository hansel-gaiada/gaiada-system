// AD-2 — mint / verify / revoke for agency discovery intake capability tokens.
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md
//   §2 (access model — "capability-token authenticated, not public") · §2.2 (token handling rules)
//   §6.1 (submit idempotency lock namespace)
//
// This file is the WHOLE authentication mechanism for a caller who is not a platform user (design
// §5.1: "a prospect is not a principal"). Two disciplines matter more here than anywhere else in the
// estate:
//   - the plaintext is handed to the MINTING STAFF MEMBER exactly once, in `mintInviteToken`'s
//     return value. Nothing downstream of this function ever sees it again, nothing here logs it,
//     and only `sha256(plaintext)` is ever written to `agency_intake_tokens.token_hash`.
//   - the read path (`findIntakeTokenByPlaintext`) looks the token up BY HASH — an indexed exact
//     match — never by scanning stored hashes and comparing plaintexts one at a time, which is what
//     design §2.2 means by "the lookup itself is not a timing oracle".
//
// ── WHY THE LOOKUP TAKES `tenantId`, AND WHERE IT COMES FROM (a design gap, flagged not hidden) ────
// `agency_intake_tokens` is FORCE-RLS tenant-walled (migration 202609050857) and — UNLIKE
// `client_contacts` (0072 §7b) — deliberately ships NO `principal_lookup`-style cross-tenant SELECT
// policy; the migration's own header says so ("nothing here is read during principal assembly —
// every read runs under withTenants"). A hash lookup for an UNAUTHENTICATED caller needs a tenant
// ALREADY IN HAND to scope that `withTenants([tenantId], ...)` call, or RLS filters out every row
// before the WHERE clause is even evaluated (an unset `app.current_tenant_ids` GUC makes the USING
// clause's `tenant_id = ANY(NULL::uuid[])` evaluate to NULL, i.e. false, for every row).
//
// `core/client-invites.ts` solves the identical bootstrap problem by putting the tenant INSIDE a
// signed, structured token (`inv1.<id>.<tenantId>.<hmac>`). Design §2.2 instead specifies a FLAT
// opaque secret — `crypto.randomBytes(32).toString('base64url')`, nothing encoded — so that
// mechanism is not available here without contradicting the design's own token format. The only
// remaining source for the scoping tenant id is the route's own `:tenantId` path segment, which is
// the SAME convention every other `/api/:tenantId/*` route in this codebase already uses
// (platform-nest/CLAUDE.md). This is NOT a trust boundary weakening: the path segment is used only
// to SCOPE the RLS-bound query, never to authorize anything. If the presented token does not
// actually belong to the tenant named in the path, RLS excludes the row and the lookup returns
// nothing — indistinguishable from an unknown hash. See this ticket's report: this mismatch between
// §2.2's literal token shape and the migration's own "no principal_lookup policy" note is flagged
// there as a design-doc gap that this file works around rather than silently re-deciding.
import { createHash, randomBytes } from "node:crypto";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";

/** 'AI' + 1 (design §6.1). Its own advisory-lock namespace, deliberately distinct from
 *  `PIPELINE_RUN_LOCK_NS` (0x50520001, pipeline-lock.ts): the resource being serialized here is the
 *  TOKEN, and (unlike the convert path, §6.2) no run id exists yet to lock on instead. */
export const AGENCY_INTAKE_LOCK_NS = 0x41490001;

export type IntakeTokenKind = "invite" | "open";

export interface IntakeTokenRow {
  id: string;
  tenantId: string;
  /** NULL only for `kind='open'` (schema-admitted, endpoint-refused in v1 — design §2.1, AD-9). */
  leadId: string | null;
  kind: IntakeTokenKind;
  expiresAt: string | null;
  usedAt: string | null;
  revokedAt: string | null;
}

/** SHA-256 of the UTF-8 plaintext, as a `Buffer` — the exact shape `token_hash bytea` expects, so no
 *  hex/base64 re-encoding step exists to get out of sync between mint and lookup. Exported so both
 *  halves of this file (and its test) share the one implementation, and so a test can pin the digest
 *  algorithm without minting a real row. */
export function hashIntakeToken(plaintext: string): Buffer {
  return createHash("sha256").update(plaintext, "utf8").digest();
}

/** Default 30 days (design §11 OQ-4: "re-mintable without losing the lead"). A `let`, not a `const`,
 *  ONLY so tests can drive a real expired/soon-to-expire token without a fake clock — mirrors
 *  connection-reveal.ts's `REVEAL_GRANT_TTL_MS` test seam. Nothing in production ever calls the
 *  setter. */
let INVITE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export function setInviteTokenTtlMsForTests(ms: number | null): void {
  INVITE_TOKEN_TTL_MS = ms ?? 30 * 24 * 60 * 60 * 1000;
}

/** Pure — no DB. Split out of `mintInviteToken` so the TTL default/override logic is testable
 *  without a database connection. */
export function computeExpiresAt(ttlMs?: number): string {
  return new Date(Date.now() + (ttlMs ?? INVITE_TOKEN_TTL_MS)).toISOString();
}

export interface MintInviteTokenInput {
  tenantId: string;
  /** The lead this token is minted FOR. Design §2.1: an invite token is minted by staff for one
   *  NAMED prospect, and the lead row is created up front by the caller (lead creation is AD-4's
   *  surface) so the queue can show "sent, not yet returned".
   *
   *  This function never CREATES a lead, but it does ADVANCE one: minting flips `new -> invited` in
   *  the same transaction as the insert (see below). That is the whole point of the 'invited' state,
   *  and leaving it to the caller is what made every invited lead sit in the wrong queue tier. */
  leadId: string;
  createdBy: string | null;
  originSite?: string;
  ttlMs?: number;
}
export interface MintedInviteToken {
  id: string;
  /** The RAW token. Returned exactly once (design §2.2) — never stored (only its hash is), never
   *  logged, and never recoverable from any later read of this row. The caller is responsible for
   *  delivering it (mirrors `createInvite`'s own contract in client-invites.ts: there is no mail
   *  transport in this estate yet). */
  plaintext: string;
  expiresAt: string;
}

/** Mint an `invite` token. `kind='open'` is deliberately not offered by this function at all — it is
 *  schema-admitted (so enabling it later needs no migration) but AD-9's job, never this one's. */
export async function mintInviteToken(input: MintInviteTokenInput): Promise<MintedInviteToken> {
  const id = newId();
  const plaintext = randomBytes(32).toString("base64url");
  const expiresAt = computeExpiresAt(input.ttlMs);
  await withTenants([input.tenantId], async (c) => {
    await c.query(
      `INSERT INTO agency_intake_tokens
         (id, tenant_id, lead_id, kind, token_hash, expires_at, created_by, origin_site)
       VALUES ($1, $2, $3, 'invite', $4, $5, $6, $7)`,
      [
        id, input.tenantId, input.leadId, hashIntakeToken(plaintext), expiresAt,
        input.createdBy, input.originSite ?? config.originSite,
      ],
    );

    // ── Advance the lead to 'invited', IN THE SAME TRANSACTION ──────────────────────────────────
    // Minting used to insert the token and stop there, so a lead stayed 'new' forever after we had
    // actually sent someone the form. QA caught it by pinning the row. The cost was not cosmetic:
    // `queueRank()` sorts 'new' ABOVE 'invited' precisely because 'new' means *we still owe them
    // the form* — so every invited prospect kept sitting in the "chase us" tier, and the one signal
    // the queue exists to carry was inverted for exactly the leads that had been handled.
    //
    // Guarded on the states an invite can legitimately advance. A re-mint for an expired link on a
    // lead that has already SUBMITTED must not drag it backwards out of the review queue — that
    // would hide a submission a reviewer is holding.
    await c.query(
      `UPDATE agency_leads
          SET status = 'invited', updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND status IN ('new', 'invited')`,
      [input.leadId, input.tenantId],
    );

    await emitEvent(c, input.tenantId, "agency_lead", input.leadId, "agency.lead.invited", {
      tokenId: id, expiresAt, actorId: input.createdBy ?? null,
    });
  });
  return { id, plaintext, expiresAt };
}

/** Revoke a token. Idempotent — revoking an already-revoked (or already-used) token is a no-op, not
 *  an error: there is nothing unsafe about a second revoke, and treating it as a failure would only
 *  punish a careful caller for checking twice. Returns whether THIS call was the one that revoked
 *  it, for a caller that wants to report "already was revoked" distinctly. */
export async function revokeIntakeToken(tenantId: string, tokenId: string): Promise<{ revoked: boolean }> {
  const r = await withTenants([tenantId], (c) =>
    c.query(`UPDATE agency_intake_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [tokenId]),
  );
  return { revoked: (r.rowCount ?? 0) > 0 };
}

/** THE read path `IntakeTokenGuard` calls. Looks the token up BY HASH — a single indexed
 *  equality match (`ux_tok_hash` is UNIQUE), never a scan comparing plaintexts — so the lookup
 *  carries no timing signal about whether, or which, stored hash the presented plaintext matches
 *  (design §2.2). No further application-level `timingSafeEqual` is needed on top of this: unlike
 *  `client-invites.ts` (which verifies an HMAC signature BEFORE the DB read, then re-compares a hash
 *  AFTER as defence in depth against a compromised signing key), this scheme has only the one
 *  lookup mechanism — there is no second, independent check left for a manual buffer comparison to
 *  add anything to.
 *
 *  `tenantId` scopes the RLS-bound query — see this file's header for why that value, not the row's
 *  own `tenant_id`, is what bootstraps the read. A token that hashes to a real row in a DIFFERENT
 *  tenant than `tenantId` is indistinguishable from no such hash existing at all: RLS excludes the
 *  row before this function ever sees it, which is exactly the fail-closed shape an existence oracle
 *  must not leak past. */
export async function findIntakeTokenByPlaintext(tenantId: string, plaintext: string): Promise<IntakeTokenRow | null> {
  const hash = hashIntakeToken(plaintext);
  return withTenants([tenantId], async (c) => {
    const r = await c.query<{
      id: string; tenant_id: string; lead_id: string | null; kind: IntakeTokenKind;
      expires_at: string | null; used_at: string | null; revoked_at: string | null;
    }>(
      `SELECT id, tenant_id, lead_id, kind, expires_at, used_at, revoked_at
         FROM agency_intake_tokens WHERE token_hash = $1`,
      [hash],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      id: row.id, tenantId: row.tenant_id, leadId: row.lead_id, kind: row.kind,
      expiresAt: row.expires_at, usedAt: row.used_at, revokedAt: row.revoked_at,
    };
  });
}
