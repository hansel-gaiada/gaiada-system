// Live-Redis smoke of the bridge LOOP (xreadgroup/ack/forward), separate from the pure-logic
// unit test. Runs only when REDIS_URL_TEST is set (ephemeral Redis in CI/dev).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Redis from "ioredis";
import { config } from "../config";
import { setRedis, closeRedis } from "./redis";
import { bridgeOnce } from "./n8n-bridge";

const REDIS = process.env.REDIS_URL_TEST;

describe.skipIf(!REDIS)("event→n8n bridge loop (live Redis)", () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(REDIS as string);
    setRedis(redis);
    config.n8nBridge = {
      webhookBaseUrl: "http://n8n:5678",
      secret: "s",
      events: ["org_structure.updated"],
      entityTypes: ["org_structure"],
      timeoutMs: 1000,
    };
  });
  afterAll(async () => {
    await redis.flushall();
    await closeRedis();
  });

  it("forwards an allow-listed event and acks it; skips + acks a non-listed one", async () => {
    const posted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        posted.push(JSON.parse(init.body).id);
        return { ok: true, status: 200 } as Response;
      }) as unknown as typeof fetch,
    );
    const stream = "events:org_structure";
    await redis.del(stream);
    await redis.xadd(stream, "*", "outboxId", "e-keep", "tenantId", "co-1", "entityId", "co-1", "eventType", "org_structure.updated", "payload", "{}", "originSite", "main", "schemaVersion", "1", "createdAt", "2026-07-15T00:00:00Z");
    await redis.xadd(stream, "*", "outboxId", "e-skip", "tenantId", "co-1", "entityId", "co-1", "eventType", "org_structure.deleted", "payload", "{}", "originSite", "main", "schemaVersion", "1", "createdAt", "2026-07-15T00:00:00Z");

    const forwarded = await bridgeOnce("org_structure");
    expect(forwarded).toBe(1); // only the allow-listed one counted as delivered
    expect(posted).toEqual(["e-keep"]); // the skipped event never hit fetch

    vi.restoreAllMocks();
    // Both entries were acked (delivered + skipped) -> nothing pending for this group.
    const pending = (await redis.xpending(stream, "n8n-bridge")) as unknown[];
    expect(Number(pending[0])).toBe(0);
  });
});
