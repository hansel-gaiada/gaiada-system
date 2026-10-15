// DW-7h (FRONTEND-BFF-CONTRACT §52.3 to §52.5) — the two small in-process structures the request hook runs on. Both are
// per process and bounded, and both take a clock so a unit test can move time instead of waiting for it.
//
//   * TtlLoader: "read this at most once per TTL", with one load in flight per key. The hot path asks it on EVERY
//     authenticated request, so without the in-flight sharing a page render's fan-out of BFF calls would each start
//     their own query the moment the entry goes stale.
//   * WriteThrottle: "write this key at most once per interval", counting what it held back so the next write carries
//     it. That keeps `request_count` and `hit_count` honest counts of requests, not of writes.

/** Drop the oldest entries (Map iteration order is insertion order) until the map fits. */
function evictOldest<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export class TtlLoader<K, V> {
  private readonly fresh = new Map<K, { at: number; value: V }>();
  private readonly inflight = new Map<K, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached value while younger than the TTL, else the result of `load` (shared by every concurrent caller).
   *  A failed load is not cached: it rejects for its callers and the next call tries again. */
  get(key: K, load: () => Promise<V>): Promise<V> {
    const hit = this.fresh.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return Promise.resolve(hit.value);
    const running = this.inflight.get(key);
    if (running) return running;
    // Freshness counts from when the query STARTED, so a slow query can never stretch the window past the TTL.
    const startedAt = this.now();
    const p = (async () => {
      try {
        const value = await load();
        this.fresh.delete(key);
        this.fresh.set(key, { at: startedAt, value });
        evictOldest(this.fresh, this.maxEntries);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  get size(): number {
    return this.fresh.size;
  }
}

export class WriteThrottle<K> {
  private readonly last = new Map<K, { at: number; held: number }>();

  constructor(
    private readonly intervalMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one event for `key`. Returns how many events the caller should write NOW (this one plus any held back since
   *  the last write), or 0 when the key was written within the interval. An evicted key forgets what it held; that
   *  only undercounts, and only for a key nobody has touched in a while. */
  take(key: K): number {
    const t = this.now();
    const prev = this.last.get(key);
    if (prev && t - prev.at < this.intervalMs) {
      prev.held += 1;
      return 0;
    }
    // Re-inserted so the map's order is "least recently written first", which is what eviction drops.
    this.last.delete(key);
    this.last.set(key, { at: t, held: 0 });
    evictOldest(this.last, this.maxEntries);
    return (prev?.held ?? 0) + 1;
  }

  get size(): number {
    return this.last.size;
  }
}
