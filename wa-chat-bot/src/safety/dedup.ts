// Inbound idempotency: a webhook redelivery must never be processed twice. In-memory
// TTL set (per process); with Redis this becomes SET NX EX. Keyed by (surface,eventId).
const TTL_MS = 24 * 60 * 60 * 1000;
const seen = new Map<string, number>(); // key -> expiry ms

export function resetDedup(): void {
  seen.clear();
}

export function dedupKey(surface: string, eventId: string): string {
  return `${surface}:${eventId}`;
}

/** Returns true if this key was already seen within the TTL; records unseen keys. */
export function seenBefore(key: string, now: number = Date.now()): boolean {
  // opportunistic sweep so the map can't grow unbounded
  if (seen.size > 10000) {
    for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
  }
  const exp = seen.get(key);
  if (exp !== undefined && exp > now) return true;
  seen.set(key, now + TTL_MS);
  return false;
}
