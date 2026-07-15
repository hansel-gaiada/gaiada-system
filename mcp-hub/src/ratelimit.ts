// Per-principal + per-service-token rate limiting (WS2 §8). A token bucket per key: `ratePerMin`
// sustained with a `burst` ceiling. In-memory (single instance) — a Redis-backed store is the
// multi-instance target-state; the call sites here don't change when that lands.
export interface Bucket {
  tokens: number;
  last: number;
}

const buckets = new Map<string, Bucket>();

/** Consume one token for `key`. Returns true if allowed, false if the bucket is empty.
 *  `now` is injectable for tests. A non-positive rate disables limiting (always allow). */
export function take(key: string, ratePerMin: number, burst: number, now: number = Date.now()): boolean {
  if (ratePerMin <= 0 || burst <= 0) return true;
  const refillPerMs = ratePerMin / 60_000;
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: burst, last: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(burst, b.tokens + (now - b.last) * refillPerMs);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

export function resetBuckets(): void {
  buckets.clear();
}
