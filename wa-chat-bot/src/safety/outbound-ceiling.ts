// Global outbound ceiling: the last-resort brake across ALL chats/surfaces combined, so a
// single incident (a bug, a loop that slips both other guards, a flood of legitimate-looking
// mentions) cannot produce enough outbound WhatsApp traffic to look like spam/abuse to WAHA's
// underlying WhatsApp connection. Per-(chat,sender) budgets (reply-budget.ts) and the action
// rate limiter (executor.ts) both bound a single actor; this bounds the bot's TOTAL egress
// regardless of how it's distributed across chats and senders.
//
// Two independent buckets (both must allow): a short per-minute burst cap and a longer
// per-hour sustained cap. Exhaustion is NEVER silent — a warn is logged and the block/sent
// counters (getOutboundCeilingStatus) are incremented, so an operator/dashboard can see it
// happened; unlike the per-sender reply budget, going silent here would hide an active incident
// from the very people who need to react to it.
import { checkRate } from "./rate-limit";
import { config } from "../config";

const MIN_KEY = "outbound-ceiling:min";
const HOUR_KEY = "outbound-ceiling:hour";

let sent = 0;
let blocked = 0;
let lastBlockedAt: number | null = null;

/** True if another outbound send may proceed right now; consumes from BOTH buckets if so. */
export function checkOutboundCeiling(now?: number): { allowed: boolean; retryAfterMs: number } {
  const perMin = checkRate(MIN_KEY, {
    capacity: config.outboundCeilingPerMinCapacity,
    refillPerSec: config.outboundCeilingPerMinCapacity / 60,
    now,
  });
  const perHour = checkRate(HOUR_KEY, {
    capacity: config.outboundCeilingPerHourCapacity,
    refillPerSec: config.outboundCeilingPerHourCapacity / 3600,
    now,
  });
  const allowed = perMin.allowed && perHour.allowed;
  if (allowed) {
    sent++;
  } else {
    blocked++;
    lastBlockedAt = now ?? Date.now();
    console.warn(
      `[safety] global outbound ceiling exceeded — send blocked (sent=${sent}, blocked=${blocked}); ` +
        `retry in ~${Math.ceil(Math.max(perMin.retryAfterMs, perHour.retryAfterMs) / 1000)}s`,
    );
  }
  return { allowed, retryAfterMs: Math.max(perMin.retryAfterMs, perHour.retryAfterMs) };
}

/** Distinguishable error thrown by callers (surface.ts) when the ceiling blocks a send —
 *  lets sendWithRetry fail fast instead of burning retry attempts against a policy block. */
export const OUTBOUND_CEILING_ERROR = "outbound_ceiling_exceeded";

/** Visible counters for admin/observability wiring (not wired to a route by this agent —
 *  see the wa-operability-hardening report for the suggested admin endpoint). */
export function getOutboundCeilingStatus(): {
  sent: number;
  blocked: number;
  lastBlockedAt: number | null;
  perMinCapacity: number;
  perHourCapacity: number;
} {
  return {
    sent,
    blocked,
    lastBlockedAt,
    perMinCapacity: config.outboundCeilingPerMinCapacity,
    perHourCapacity: config.outboundCeilingPerHourCapacity,
  };
}

/** Test-only: reset counters (bucket state itself is cleared via rate-limit's resetRateLimiter). */
export function resetOutboundCeilingCounters(): void {
  sent = 0;
  blocked = 0;
  lastBlockedAt = null;
}
