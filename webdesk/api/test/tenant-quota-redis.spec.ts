// M3 T6 -- the per-tenant /v1 read quota is counted in Redis, so it holds with more than one api
// replica. Two TenantQuotaService instances stand in for two replicas; they share the real Redis the
// gate provides (REDIS_URL) and nothing else. No app boot, no Postgres.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { QUOTA_KEY_PREFIX, QUOTA_TTL_MARGIN_MS, TenantQuotaService } from "../src/rate-limit/tenant-quota.service";

const WINDOW = 60_000;

function replica(limit: number, windowMs = WINDOW): TenantQuotaService {
  const svc = new TenantQuotaService();
  svc.withLimits(limit, windowMs);
  return svc;
}

describe("M3 T6 Redis-backed per-tenant read quota", () => {
  const replicas: TenantQuotaService[] = [];
  let probe: Redis;

  const track = (svc: TenantQuotaService) => {
    replicas.push(svc);
    return svc;
  };

  beforeAll(() => {
    const u = new URL(process.env.REDIS_URL || "redis://localhost:6379");
    probe = new Redis({ host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all(replicas.map((r) => r.onModuleDestroy()));
    await probe.quit().catch(() => probe.disconnect());
  });

  it("two replicas sharing Redis: limit 5, ten interleaved calls -> exactly 5 allowed in total", async () => {
    const a = track(replica(5));
    const b = track(replica(5));
    const tenant = `t6-two-replicas-${randomUUID()}`;
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await (i % 2 === 0 ? a : b).consume(tenant));

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.map((r) => r.remaining)).toEqual([4, 3, 2, 1, 0, 0, 0, 0, 0, 0]);
    // The reset instant is the END of the aligned window, the same for both replicas.
    expect(new Set(results.map((r) => r.resetAt)).size).toBe(1);
    expect(results[0].resetAt % WINDOW).toBe(0);
  });

  it("rolls over into the next aligned window, and the key carries a TTL no longer than window + margin", async () => {
    const svc = track(replica(2));
    const tenant = `t6-rollover-${randomUUID()}`;
    const w0 = Math.floor(Date.now() / WINDOW) * WINDOW;

    const first = [await svc.consume(tenant, w0 + 10), await svc.consume(tenant, w0 + 20), await svc.consume(tenant, w0 + 30)];
    expect(first.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(first[0].resetAt).toBe(w0 + WINDOW);

    const ttl = await probe.pttl(`${QUOTA_KEY_PREFIX}${tenant}:${w0}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(WINDOW + QUOTA_TTL_MARGIN_MS);

    // An over-limit hit must not re-extend the TTL.
    await svc.consume(tenant, w0 + 40);
    expect(await probe.pttl(`${QUOTA_KEY_PREFIX}${tenant}:${w0}`)).toBeLessThanOrEqual(ttl);

    const next = await svc.consume(tenant, w0 + WINDOW + 5);
    expect(next).toMatchObject({ allowed: true, remaining: 1, resetAt: w0 + 2 * WINDOW });
    expect(await probe.pttl(`${QUOTA_KEY_PREFIX}${tenant}:${w0 + WINDOW}`)).toBeGreaterThan(0);
  });

  it("tenant A exhausting its quota never affects tenant B", async () => {
    const a = track(replica(3));
    const b = track(replica(3));
    const tenantA = `t6-iso-a-${randomUUID()}`;
    const tenantB = `t6-iso-b-${randomUUID()}`;
    for (let i = 0; i < 6; i++) await (i % 2 === 0 ? a : b).consume(tenantA);
    expect((await a.consume(tenantA)).allowed).toBe(false);

    const fresh = await b.consume(tenantB);
    expect(fresh).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("reset() deletes the current window's key", async () => {
    const svc = track(replica(1));
    const tenant = `t6-reset-${randomUUID()}`;
    expect((await svc.consume(tenant)).allowed).toBe(true);
    expect((await svc.consume(tenant)).allowed).toBe(false);
    await svc.reset(tenant);
    expect((await svc.consume(tenant)).allowed).toBe(true);
  });

  it("Redis unreachable: reads still succeed under the per-process fallback, one warning, no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const svc = track(replica(3));
      svc.useRedisUrl("redis://127.0.0.1:1"); // nothing listens on port 1
      const tenant = `t6-down-${randomUUID()}`;
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await svc.consume(tenant));

      // Never throws; the per-process window still bounds this replica.
      expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
      expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("Redis unavailable");

      await new Promise((r) => setTimeout(r, 400)); // let any stray rejection surface
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
