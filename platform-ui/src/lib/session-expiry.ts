// Edge-safe expiry peek for the session cookie (fault register finding 01, 2026-09-08).
//
// ── WHY A SEPARATE FILE FROM session.ts ──────────────────────────────────────────────────────────
// `session.ts` signs and verifies with `node:crypto`, which the Edge runtime cannot load — that is
// exactly why `middleware.ts` has only ever done a cookie PRESENCE check. But middleware is the one
// place that runs before a page renders AND can set a cookie, so it is where a token refresh has to
// be decided. This module gives it the single fact it needs (when does the access token expire?)
// using only APIs Edge has.
//
// ── READING WITHOUT VERIFYING IS SAFE *HERE*, AND ONLY HERE ──────────────────────────────────────
// This deliberately does NOT check the HMAC. It cannot — that needs node:crypto. What it returns is
// therefore ATTACKER-INFLUENCED and must never be used to grant anything. It is used for exactly one
// decision: "should this request be sent to /auth/refresh first?" The refresh route then verifies the
// signature properly before touching any token, and Keycloak independently rejects a refresh token it
// did not issue. So the worst a forged value achieves is redirecting the forger to a route that
// refuses them. Do not extend this module to answer any other question.
//
// Returns null whenever it cannot tell — a dev-mode session (no expiry exists), a malformed cookie,
// or anything it does not recognise. Callers must treat null as "do nothing", never as "expired".

const OIDC_PREFIX = "oidc:";

/** base64url -> utf8, using only Edge-available primitives (no Buffer). */
function b64urlToString(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Epoch-ms expiry of the access token inside a sealed session cookie, or null if there isn't one
 * (dev-mode session, malformed cookie, unsigned-but-unparseable payload).
 *
 * `sealed` is `<payload>.<signature>`; the payload for an OIDC session is
 * `oidc:<base64url(JSON)>`. Split on the LAST dot, matching `openSession`'s own parsing — the
 * base64url payload never contains ".", but reproducing the same split rule keeps the two in step.
 */
export function peekSessionExpiry(sealed: string | undefined): number | null {
  if (!sealed) return null;
  const idx = sealed.lastIndexOf(".");
  if (idx <= 0) return null;
  const payload = sealed.slice(0, idx);
  if (!payload.startsWith(OIDC_PREFIX)) return null; // dev-mode session — nothing to refresh
  try {
    const json = JSON.parse(b64urlToString(payload.slice(OIDC_PREFIX.length))) as { e?: unknown };
    return typeof json.e === "number" && Number.isFinite(json.e) ? json.e : null;
  } catch {
    return null;
  }
}

/** Refresh this many ms BEFORE the token actually expires.
 *
 *  Not zero, and the margin is not arbitrary: a page render fans out several `platformFetch` calls,
 *  and a token that is valid when middleware waves the request through can expire while those are
 *  still in flight. 120s comfortably covers a slow render plus clock skew between this host and
 *  Keycloak, while staying a rounding error against the realm's 3600s token lifetime. */
export const REFRESH_SKEW_MS = 120_000;

/** True when a refresh should be attempted before serving this request. */
export function needsRefresh(expiresAt: number | null, now: number = Date.now()): boolean {
  if (expiresAt === null) return false;   // unknown / dev session -> never redirect
  return now >= expiresAt - REFRESH_SKEW_MS;
}
