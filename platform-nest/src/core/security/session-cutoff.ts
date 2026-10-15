// DW-7h (FRONTEND-BFF-CONTRACT §52.4) — is this token's session one IT signed out, or does it belong to a user whose
// login IT blocked? The access token a person holds lives up to an hour after Keycloak's session ends, and the principal
// re-reads `users.session_version` on every request (so bumping it cuts nothing); a `security_session_revocations` row
// is what refuses that token.
//
// The table is GLOBAL and small (rows stop counting at `expires_at`, past the ERP session's 12 h life), so the whole
// active set is read in one query and kept for at most 10 seconds per process: a sign-out or a block takes effect
// within 10 seconds on every box, and the hot path costs one query per process per 10 seconds, not one per request.
import { withGlobal } from "../../db";
import { TtlLoader } from "./caches";

export const REVOCATION_CACHE_TTL_MS = 10_000;

export interface RevocationSnapshot {
  /** Session ids (the token's `sid`) IT signed out. */
  sessions: Set<string>;
  /** Per user, the LATEST `revoked_at` (epoch ms) of a "Block login" row (session_id NULL). A token issued before any
   *  of that user's active rows is cut, which is the same as being issued before the latest one. */
  userCutoffs: Map<string, number>;
}

export interface RevocationRow {
  user_id: string;
  session_id: string | null;
  revoked_at: Date;
}

export function snapshotOf(rows: RevocationRow[]): RevocationSnapshot {
  const sessions = new Set<string>();
  const userCutoffs = new Map<string, number>();
  for (const r of rows) {
    if (r.session_id) {
      sessions.add(r.session_id);
      continue;
    }
    const at = r.revoked_at.getTime();
    if (at > (userCutoffs.get(r.user_id) ?? -Infinity)) userCutoffs.set(r.user_id, at);
  }
  return { sessions, userCutoffs };
}

export interface TokenFacts {
  userId: string | null;
  /** The token's `sid` (or `session_state`); null when it names no session. */
  sessionId?: string | null;
  /** The token's `iat`, epoch SECONDS; undefined on every service-token path (dev header, OBO envelope), which carry
   *  no token of the user's own, so the "Block login" rule cannot apply to them. */
  tokenIssuedAt?: number | null;
}

/** The pure decision. `iat` is whole seconds and `revoked_at` has milliseconds, so the comparison is done in ms
 *  (`iat * 1000 < revoked_at`): a token issued in the same second as the block, before or after it, is cut. That
 *  errs towards a needless sign-in, never towards letting a blocked token through. */
export function isRevoked(snap: RevocationSnapshot, tok: TokenFacts): boolean {
  if (tok.sessionId && snap.sessions.has(tok.sessionId)) return true;
  if (tok.userId && typeof tok.tokenIssuedAt === "number" && Number.isFinite(tok.tokenIssuedAt)) {
    const cutoff = snap.userCutoffs.get(tok.userId);
    if (cutoff !== undefined && tok.tokenIssuedAt * 1000 < cutoff) return true;
  }
  return false;
}

/** Does this request carry anything a revocation could match? The service-token paths carry neither, and are spared
 *  the lookup entirely. */
export function canBeRevoked(tok: TokenFacts): boolean {
  return !!tok.sessionId || (!!tok.userId && typeof tok.tokenIssuedAt === "number");
}

export async function loadRevocations(): Promise<RevocationSnapshot> {
  // withGlobal is right here: the table is global (no RLS), like `users`, because a session belongs to the person and
  // not to one company.
  const { rows } = await withGlobal((c) =>
    c.query<RevocationRow>(
      `SELECT user_id, session_id, revoked_at FROM security_session_revocations WHERE expires_at > now()`,
    ),
  );
  return snapshotOf(rows);
}

export interface SessionCutoff {
  isRevoked(tok: TokenFacts): Promise<boolean>;
}

export function createSessionCutoff(
  load: () => Promise<RevocationSnapshot> = loadRevocations,
  now: () => number = Date.now,
): SessionCutoff {
  const cache = new TtlLoader<"all", RevocationSnapshot>(REVOCATION_CACHE_TTL_MS, 1, now);
  return {
    async isRevoked(tok) {
      if (!canBeRevoked(tok)) return false;
      return isRevoked(await cache.get("all", load), tok);
    },
  };
}
