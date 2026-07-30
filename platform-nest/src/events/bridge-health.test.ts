// Bridge health READ + dead-letter REPLAY. Redis is stubbed via setRedis (same seam the relay and
// consumer suites use) so the ordering guarantees are asserted rather than assumed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Redis from "ioredis";
import { config } from "../config";
import { setRedis } from "./redis";
import { getBridgeHealth, replayBridgeDeadLetters } from "./bridge-health";

// Records the call ORDER, which is the whole point of the replay guarantee: re-add before delete.
interface FakeRedis {
  calls: string[];
  xpending: (...a: unknown[]) => Promise<unknown>;
  xlen: (k: string) => Promise<number>;
  xrange: (...a: unknown[]) => Promise<[string, string[]][]>;
  xadd: (...a: unknown[]) => Promise<string>;
  xdel: (...a: unknown[]) => Promise<number>;
}

function fakeRedis(overrides: Partial<FakeRedis> = {}): FakeRedis {
  const calls: string[] = [];
  const base: FakeRedis = {
    calls,
    xpending: async () => [0, null, null, null],
    xlen: async () => 0,
    xrange: async () => [],
    xadd: async (...a: unknown[]) => {
      calls.push(`xadd:${String(a[0])}`);
      return "1-0";
    },
    xdel: async (...a: unknown[]) => {
      calls.push(`xdel:${String(a[0])}:${String(a[1])}`);
      return 1;
    },
  };
  return { ...base, ...overrides, calls };
}

const original = config.n8nBridge;

describe("bridge health (Automation console)", () => {
  beforeEach(() => {
    config.redisUrl = "redis://stub";
    config.n8nBridge = {
      webhookBaseUrl: "http://n8n:5678/",
      secret: "s",
      events: ["client.created"],
      entityTypes: ["client", "deliverable"],
      timeoutMs: 5000,
    };
  });
  afterEach(() => {
    config.n8nBridge = original;
    setRedis(null);
  });

  it("reports per-stream backlog, dead-letters and oldest-pending age", async () => {
    const now = Date.now();
    const r = fakeRedis({
      // XPENDING summary: [count, minId, maxId, consumers]. minId encodes the entry's ms timestamp.
      xpending: async () => [3, `${now - 120_000}-0`, `${now}-0`, null],
      xlen: async () => 2,
    });
    setRedis(r as unknown as Redis);

    const h = await getBridgeHealth();
    expect(h.enabled).toBe(true);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[0]).toMatchObject({ entityType: "client", stream: "events:client", backlog: 3, deadLetter: 2 });
    // ~120s old, allowing for clock jitter during the test.
    expect(h.streams[0].oldestPendingMs).toBeGreaterThan(100_000);
  });

  // A group that has never been created (the bridge never ran) is "no backlog", not an error worth
  // showing an operator.
  it("treats a missing consumer group as no backlog rather than an error", async () => {
    const r = fakeRedis({
      xpending: async () => {
        throw new Error("NOGROUP No such consumer group");
      },
    });
    setRedis(r as unknown as Redis);
    const h = await getBridgeHealth();
    expect(h.streams[0].error).toBeUndefined();
    expect(h.streams[0].backlog).toBe(0);
  });

  it("surfaces a real Redis failure per stream instead of throwing", async () => {
    const r = fakeRedis({
      xpending: async () => {
        throw new Error("READONLY replica");
      },
    });
    setRedis(r as unknown as Redis);
    const h = await getBridgeHealth();
    expect(h.streams[0].error).toContain("READONLY");
  });

  it("reports honestly when Redis isn't configured at all (never throws)", async () => {
    config.redisUrl = "";
    setRedis(null);
    const h = await getBridgeHealth();
    expect(h.error).toContain("REDIS_URL");
    expect(h.streams).toEqual([]);
  });

  it("reports disabled + no streams when the bridge isn't configured", async () => {
    config.n8nBridge = { ...config.n8nBridge, entityTypes: [], webhookBaseUrl: "" };
    const h = await getBridgeHealth();
    expect(h.enabled).toBe(false);
    expect(h.streams).toEqual([]);
  });

  describe("dead-letter replay", () => {
    it("re-adds to the source stream BEFORE deleting from the dead-letter stream", async () => {
      const r = fakeRedis({
        xrange: async () => [
          ["1-0", ["outboxId", "e1", "eventType", "client.created"]],
          ["2-0", ["outboxId", "e2", "eventType", "client.created"]],
        ],
        xlen: async () => 0,
      });
      setRedis(r as unknown as Redis);

      const out = await replayBridgeDeadLetters("client", 100);
      expect(out).toEqual({ entityType: "client", replayed: 2, remaining: 0 });
      // Order matters: a crash between the two must duplicate (the bridge is at-least-once and n8n
      // dedupes on envelope id), never drop.
      expect(r.calls).toEqual([
        "xadd:events:client",
        "xdel:events:client:n8n-dead-letter:1-0",
        "xadd:events:client",
        "xdel:events:client:n8n-dead-letter:2-0",
      ]);
    });

    it("replays nothing (and reports it) when the dead-letter stream is empty", async () => {
      setRedis(fakeRedis() as unknown as Redis);
      expect(await replayBridgeDeadLetters("client")).toEqual({ entityType: "client", replayed: 0, remaining: 0 });
    });

    it("reports what is still parked when the limit truncates the batch", async () => {
      const r = fakeRedis({
        xrange: async () => [["1-0", ["outboxId", "e1"]]],
        xlen: async () => 4,
      });
      setRedis(r as unknown as Redis);
      const out = await replayBridgeDeadLetters("client", 1);
      // A silent partial replay would read as "all clear"; the remainder is reported instead.
      expect(out).toEqual({ entityType: "client", replayed: 1, remaining: 4 });
    });

    // Unlike the health read, a replay MUST throw: silently doing nothing would leave the operator
    // believing the events were requeued.
    it("throws when Redis fails mid-replay", async () => {
      const r = fakeRedis({
        xrange: async () => [["1-0", ["outboxId", "e1"]]],
        xadd: async () => {
          throw new Error("connection lost");
        },
      });
      setRedis(r as unknown as Redis);
      await expect(replayBridgeDeadLetters("client")).rejects.toThrow("connection lost");
    });
  });
});
