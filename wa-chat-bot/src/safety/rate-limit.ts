// Per-key token-bucket rate limiter. In-memory (per process) — sufficient for a
// single bot instance; a Redis-backed variant can replace the map when horizontal
// scaling arrives. `now` is injectable so tests are deterministic.
interface Bucket {
  tokens: number;
  lastMs: number;
}

const buckets = new Map<string, Bucket>();

export function resetRateLimiter(): void {
  buckets.clear();
}

export function checkRate(
  key: string,
  opts: { capacity: number; refillPerSec: number; now?: number },
): { allowed: boolean; retryAfterMs: number } {
  const now = opts.now ?? Date.now();
  const b = buckets.get(key) ?? { tokens: opts.capacity, lastMs: now };
  const elapsedSec = Math.max(0, (now - b.lastMs) / 1000);
  b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
  b.lastMs = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    buckets.set(key, b);
    return { allowed: true, retryAfterMs: 0 };
  }
  buckets.set(key, b);
  const deficit = 1 - b.tokens;
  const retryAfterMs = opts.refillPerSec > 0 ? Math.ceil((deficit / opts.refillPerSec) * 1000) : 60000;
  return { allowed: false, retryAfterMs };
}
