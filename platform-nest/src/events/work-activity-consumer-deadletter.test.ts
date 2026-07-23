// WSUX-15 — dead-letter path for the work-activity consumer's OWN group, isolated in its own file
// (mirrors consumer.service.test.ts's dead-letter coverage for the module-dispatch group). Real
// Redis/outbox/relay; `ingestWorkActivity` is mocked to always throw so the failure is deterministic
// without relying on a specific DB constraint violation (mapPmTask itself never throws on
// well-formed input — the mapping layer is deliberately NULL-tolerant — so a persistent WRITE
// failure, e.g. a DB outage, is the realistic fault this proves recovery for).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Redis from "ioredis";

const ingestWorkActivity = vi.fn(async (_tenantId: string, _input: unknown) => {
  throw new Error("simulated persistent write failure");
});
vi.mock("../core/work-activity-ingest.service", () => ({ ingestWorkActivity: (a: string, b: unknown) => ingestWorkActivity(a, b) }));

import { withTenants } from "../db";
import { emitEvent } from "./outbox.service";
import { relayBatch } from "./relay";
import { consumeWorkActivityOnce } from "./work-activity-consumer";
import { setRedis, closeRedis } from "./redis";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { newId } from "../db";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("work-activity outbox consumer — dead-letter (WSUX-15)", () => {
  let co: string;
  let redis: Redis;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Work Activity Dead-Letter Co");
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
  });
  afterAll(async () => {
    await closeRedis();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await redis.del("events:pm_task");
    await redis.del("events:pm_task:work-activity-dead-letter");
    try {
      await redis.xgroup("DESTROY", "events:pm_task", "work-activity");
    } catch {
      // group may not exist yet, ignore
    }
    ingestWorkActivity.mockClear();
  });

  it("does not ack while under the retry threshold, leaving the entry pending for redelivery", async () => {
    const taskId = newId();
    await withTenants([co], (c) => emitEvent(c, co, "pm_task", taskId, "pm.task.created", { title: "t" }));
    await relayBatch(100);

    const handled = await consumeWorkActivityOnce("pm_task");
    expect(handled).toBe(0);

    const summary = (await redis.xpending("events:pm_task", "work-activity")) as [
      number, string | null, string | null, [string, string][] | null,
    ];
    expect(summary[0]).toBeGreaterThanOrEqual(1);
  });

  it("moves an entry to the work-activity dead-letter stream after DEAD_LETTER_MAX_RETRIES failures", async () => {
    const taskId = newId();
    await withTenants([co], (c) => emitEvent(c, co, "pm_task", taskId, "pm.task.created", { title: "t" }));
    await relayBatch(100);

    for (let i = 0; i < 6; i++) await consumeWorkActivityOnce("pm_task");

    const dead = await redis.xrange("events:pm_task:work-activity-dead-letter", "-", "+");
    expect(dead.length).toBeGreaterThanOrEqual(1);
    expect(ingestWorkActivity).toHaveBeenCalled();
  });
});
