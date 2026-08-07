// MAIL-13 — the per-source intake rate limit (design §7.8: "Inbound flood | Size caps + per-source
// rate limit at intake").
//
// In-process fixed-window counter, keyed by source. Scope is honestly narrow and deliberately so:
//
//   * PER INSTANCE, not cluster-wide. There is no Redis dependency anywhere in `src/mail/` (design
//     A2 — auth mail must not ride an optional dependency), so a cluster-wide limiter would mean
//     introducing one for a flood control on a handful-of-mails-per-day endpoint. Two platform
//     instances therefore allow 2× the configured rate in the worst case; the same trade-off the MCP
//     hub's limiter already makes ("Redis-backed multi-instance rate limiting" is listed there as a
//     deferral, not a defect).
//   * It is a FLOOD control, not an authorization control. The wall that keeps strangers out is the
//     token in `auth.ts`; this exists so a misbehaving-or-hostile source (authenticated or not — see
//     MAIL-37, `inbound.controller.ts` now checks this BEFORE auth) cannot drive unbounded
//     sanitizer/scanner/INSERT work, or — pre-auth specifically — repeated signature-verify HMAC
//     compares on a flood of invalid-token requests from one source. The controller-level comment on
//     why the order changed (and why it's still safe) lives in `inbound.controller.ts`.
//
// The window is fixed rather than sliding: at these volumes the 2×-at-the-boundary imprecision of a
// fixed window is irrelevant, and a fixed window has no per-request allocation.

interface Window {
  windowStartMs: number;
  count: number;
}

const windows = new Map<string, Window>();

/** Bounded to keep a spoofed-source-header flood from turning the limiter itself into the memory
 *  leak it exists to prevent. When the map is full the OLDEST window is evicted, which can only ever
 *  be generous (an evicted source starts a fresh window) — never wrongly restrictive. */
const MAX_TRACKED_SOURCES = 4096;

export interface RateDecision {
  allowed: boolean;
  /** Requests already counted in the current window, INCLUDING this one when allowed. */
  count: number;
  limit: number;
}

export function checkInboundRate(source: string, limitPerMinute: number, nowMs = Date.now()): RateDecision {
  if (limitPerMinute <= 0) return { allowed: true, count: 0, limit: limitPerMinute };
  const key = source || "unknown";
  const existing = windows.get(key);
  if (!existing || nowMs - existing.windowStartMs >= 60_000) {
    if (!existing && windows.size >= MAX_TRACKED_SOURCES) {
      const oldest = windows.keys().next();
      if (!oldest.done) windows.delete(oldest.value);
    }
    windows.set(key, { windowStartMs: nowMs, count: 1 });
    return { allowed: true, count: 1, limit: limitPerMinute };
  }
  if (existing.count >= limitPerMinute) {
    return { allowed: false, count: existing.count, limit: limitPerMinute };
  }
  existing.count += 1;
  return { allowed: true, count: existing.count, limit: limitPerMinute };
}

/** Test-only: the limiter is module state, and a suite that asserts a 429 must be able to hand the
 *  next suite a clean slate. */
export function resetInboundRateLimitForTest(): void {
  windows.clear();
}
