import { describe, it, expect, vi } from "vitest";
import { createIpBlockGuard, ipKey, IP_BLOCK_CACHE_TTL_MS, IP_BLOCK_HIT_INTERVAL_MS, type ActiveBlocks } from "./ip-blocks";

// DW-7h (BFF §52.5): matching a request's address against a company's blocks. The DB half (RLS, `lifted_at`,
// `expires_at`, the hit count) is in request-guard.db.test.ts.
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";

describe("ipKey", () => {
  it("keeps IPv4 as it is", () => {
    expect(ipKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it("spells every form of one IPv6 host the same way", () => {
    const k = "2001:0db8:0000:0000:0000:0000:0000:0001";
    expect(ipKey("2001:db8::1")).toBe(k);
    expect(ipKey("2001:DB8::1")).toBe(k);
    expect(ipKey("2001:db8:0:0:0:0:0:1")).toBe(k);
    expect(ipKey("2001:db8::0:1")).toBe(k);
    expect(ipKey("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(ipKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000:0000:0000:0000:0001");
  });

  it("turns IPv4-mapped IPv6, dotted or hex, into the IPv4 address", () => {
    expect(ipKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipKey("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("refuses what is not an address", () => {
    expect(ipKey(null)).toBeNull();
    expect(ipKey("")).toBeNull();
    expect(ipKey("not-an-ip")).toBeNull();
    expect(ipKey("203.0.113.0/24")).toBeNull();
  });
});

describe("createIpBlockGuard", () => {
  const blocksOf = (entries: Record<string, ActiveBlocks>) => async (tenantId: string) => entries[tenantId] ?? new Map();

  it("finds the block of THIS company only", async () => {
    const guard = createIpBlockGuard({ load: blocksOf({ [T1]: new Map([[ipKey("2001:db8::7")!, "block-1"]]) }) });
    expect(await guard.blockFor(T1, "2001:DB8:0:0::7")).toBe("block-1");
    expect(await guard.blockFor(T2, "2001:db8::7")).toBeNull();
    expect(await guard.blockFor(T1, "2001:db8::8")).toBeNull();
  });

  it("never blocks an unknown address, and does not even look", async () => {
    const load = vi.fn(blocksOf({}));
    const guard = createIpBlockGuard({ load });
    expect(await guard.blockFor(T1, null)).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("reads each company's blocks at most once per 10 seconds", async () => {
    let t = 1_000_000;
    let blocks: ActiveBlocks = new Map();
    const load = vi.fn(async () => blocks);
    const guard = createIpBlockGuard({ load, now: () => t });
    expect(await guard.blockFor(T1, "198.51.100.1")).toBeNull();
    blocks = new Map([["198.51.100.1", "block-new"]]);
    t += IP_BLOCK_CACHE_TTL_MS - 1;
    expect(await guard.blockFor(T1, "198.51.100.1")).toBeNull();
    t += 1;
    expect(await guard.blockFor(T1, "198.51.100.1")).toBe("block-new");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("counts hits at most once per block per 60 seconds, carrying the held-back count, and swallows a failed write", async () => {
    let t = 1_000_000;
    const writes: Array<[string, string, number]> = [];
    let fail = true;
    const guard = createIpBlockGuard({
      load: blocksOf({}),
      now: () => t,
      writeHits: async (tenantId, blockId, hits) => {
        if (fail) { fail = false; throw new Error("db down"); }
        writes.push([tenantId, blockId, hits]);
      },
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    guard.countHit(T1, "b1"); // written (and fails, logged)
    guard.countHit(T1, "b1"); // held
    guard.countHit(T1, "b1"); // held
    t += IP_BLOCK_HIT_INTERVAL_MS;
    guard.countHit(T1, "b1"); // written: 2 held + 1
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toEqual([[T1, "b1", 3]]);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
