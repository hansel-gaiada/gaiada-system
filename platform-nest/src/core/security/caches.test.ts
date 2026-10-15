import { describe, it, expect } from "vitest";
import { TtlLoader, WriteThrottle } from "./caches";

// DW-7h (BFF §52.3 to §52.5): the cache and the throttle under the request hook, on a hand-moved clock.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("TtlLoader", () => {
  it("serves the cached value inside the TTL and reloads at the TTL, not after it", async () => {
    const c = clock();
    const cache = new TtlLoader<string, number>(10_000, 10, c.now);
    let loads = 0;
    const load = async () => ++loads;
    expect(await cache.get("k", load)).toBe(1);
    c.advance(9_999);
    expect(await cache.get("k", load)).toBe(1);
    c.advance(1);
    expect(await cache.get("k", load)).toBe(2);
  });

  it("shares one load between concurrent callers", async () => {
    const cache = new TtlLoader<string, number>(10_000, 10);
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const load = async () => { loads += 1; await gate; return 7; };
    const all = Promise.all([cache.get("k", load), cache.get("k", load), cache.get("k", load)]);
    release();
    expect(await all).toEqual([7, 7, 7]);
    expect(loads).toBe(1);
  });

  it("counts freshness from when the load started, so a slow query cannot stretch the window", async () => {
    const c = clock();
    const cache = new TtlLoader<string, number>(10_000, 10, c.now);
    let n = 0;
    await cache.get("k", async () => { c.advance(4_000); return ++n; });
    c.advance(6_000); // 10 s after the load started, 6 s after it finished
    expect(await cache.get("k", async () => ++n)).toBe(2);
  });

  it("does not cache a failed load: the next call tries again", async () => {
    const cache = new TtlLoader<string, number>(10_000, 10);
    await expect(cache.get("k", async () => { throw new Error("db down"); })).rejects.toThrow("db down");
    expect(await cache.get("k", async () => 3)).toBe(3);
  });

  it("keeps at most maxEntries keys, dropping the oldest", async () => {
    const cache = new TtlLoader<string, number>(10_000, 2);
    let n = 0;
    const load = async () => ++n;
    await cache.get("a", load);
    await cache.get("b", load);
    await cache.get("c", load);
    expect(cache.size).toBe(2);
    expect(await cache.get("b", load)).toBe(2); // still cached
    expect(await cache.get("a", load)).toBe(4); // evicted, so loaded again
  });
});

describe("WriteThrottle", () => {
  it("lets one write per key through per interval and carries the held-back count into the next", () => {
    const c = clock();
    const t = new WriteThrottle<string>(60_000, 100, c.now);
    expect(t.take("k")).toBe(1);
    expect(t.take("k")).toBe(0);
    expect(t.take("k")).toBe(0);
    c.advance(59_999);
    expect(t.take("k")).toBe(0);
    c.advance(1);
    expect(t.take("k")).toBe(4); // three held back + this one
    expect(t.take("other")).toBe(1); // keys are independent
  });

  it("is bounded: past maxEntries the least recently written key is forgotten", () => {
    const c = clock();
    const t = new WriteThrottle<string>(60_000, 2, c.now);
    t.take("a");
    t.take("b");
    t.take("c");
    expect(t.size).toBe(2);
    expect(t.take("a")).toBe(1); // forgotten, so it writes again at once
    expect(t.take("c")).toBe(0); // still throttled
  });
});
