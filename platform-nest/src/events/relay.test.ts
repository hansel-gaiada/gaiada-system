import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { withTenants } from "../db";
import { emitEvent } from "./outbox.service";
import { relayBatch } from "./relay";
import { setRedis, closeRedis } from "./redis";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("relay worker", () => {
  let co: string;
  let redis: Redis;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Relay Test Co");
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
  });
  afterAll(async () => {
    await closeRedis();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await redis.del("events:deliverable");
  });

  it("moves unrelayed rows into the per-entity-type stream and marks them relayed", async () => {
    const entityId = "00000000-0000-0000-0000-000000000010";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", { x: 1 }));

    const count = await relayBatch(100);
    expect(count).toBe(1);

    const entries = await redis.xrange("events:deliverable", "-", "+");
    expect(entries).toHaveLength(1);
    const fields = entries[0][1];
    const asObj: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) asObj[fields[i]] = fields[i + 1];
    expect(asObj.entityId).toBe(entityId);
    expect(asObj.eventType).toBe("deliverable.approved");

    const again = await relayBatch(100);
    expect(again).toBe(0); // already relayed, not re-sent
  });
});
