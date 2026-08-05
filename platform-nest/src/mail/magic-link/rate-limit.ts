// MAIL-10 — per-address + per-IP flood control on `POST /auth/magic-link` (design §9/ticket AC:
// "3 per address/hour, 10 per IP/hour"). Same in-process fixed-window shape as
// `src/mail/inbound/rate-limit.ts` (design A2: no Redis dependency anywhere in src/mail/, so auth
// mail never rides an optional dependency) — kept as a SEPARATE module/map rather than
// generalizing that file, so a concurrent session touching inbound rate-limiting cannot collide
// with this auth-critical path, and so the two limiters' windows (1 minute vs 1 hour) and keyspaces
// (provider source vs requester address/IP) never share state by accident.
//
// Deliberately PER INSTANCE, not cluster-wide, same trade-off as the inbound limiter: two platform
// instances allow up to 2x the configured rate in the worst case. At "a handful of magic-link
// requests ever" volume (the feature ships disabled by default, §MAIL_MAGIC_LINKS_ENABLED) this is
// an accepted, explicit trade-off, not an oversight.
const HOUR_MS = 60 * 60 * 1000;
const MAX_TRACKED_KEYS = 4096;

interface Window {
  windowStartMs: number;
  count: number;
}

const windows = new Map<string, Window>();

export interface RateDecision {
  allowed: boolean;
  count: number;
  limit: number;
}

/** `key` is caller-namespaced (e.g. `"addr:" + normalizedEmail` / `"ip:" + ip`) so the two
 *  dimensions in the ticket's AC (per-address, per-IP) can share one bounded map without colliding
 *  on the same counter. `limit <= 0` disables the check for that dimension. */
export function checkHourlyRate(key: string, limit: number, nowMs = Date.now()): RateDecision {
  if (limit <= 0) return { allowed: true, count: 0, limit };
  const existing = windows.get(key);
  if (!existing || nowMs - existing.windowStartMs >= HOUR_MS) {
    if (!existing && windows.size >= MAX_TRACKED_KEYS) {
      const oldest = windows.keys().next();
      if (!oldest.done) windows.delete(oldest.value);
    }
    windows.set(key, { windowStartMs: nowMs, count: 1 });
    return { allowed: true, count: 1, limit };
  }
  if (existing.count >= limit) {
    return { allowed: false, count: existing.count, limit };
  }
  existing.count += 1;
  return { allowed: true, count: existing.count, limit };
}

/** Test-only: module-level state needs a clean slate between suites/cases. */
export function resetMagicLinkRateLimitForTest(): void {
  windows.clear();
}
