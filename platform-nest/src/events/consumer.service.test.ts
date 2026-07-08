import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { withTenants } from "../db";
import { emitEvent } from "./outbox.service";
import { relayBatch } from "./relay";
import { consumeOnce } from "./consumer.service";
import { setRedis, closeRedis } from "./redis";
import { registerModule, resetModules } from "../modules/registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import type { ModuleContract } from "../modules/contract";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("EventConsumerService", () => {
  let co: string;
  let redis: Redis;
  const received: unknown[] = [];

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Consumer Test Co");
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
  });
  afterAll(async () => {
    await closeRedis();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await redis.del("events:deliverable");
    try {
      await redis.xgroup("DESTROY", "events:deliverable", "in-process-platform");
    } catch {
      // group may not exist yet, ignore
    }
    received.length = 0;
    resetModules();
    // Reset enabled_modules to empty so tests don't leak state onto the shared company
    // (the "dispatches" test below appends 'agency'; without this reset the "does not
    // dispatch" test would spuriously see it as already-enabled).
    await withTenants([co], (c) =>
      c.query(`UPDATE companies SET enabled_modules = '{}' WHERE id = $1`, [co]),
    );
  });

  it("dispatches to the enabled module's handler for the matching event_type", async () => {
    const testModule: ModuleContract = {
      key: "agency",
      migrations: [],
      permissions: [],
      customFieldTargets: [],
      mcpTools: [],
      rollupProviders: [],
      uiManifest: [],
      eventHandlers: {
        "deliverable.approved": async (event) => {
          received.push(event);
        },
      },
    };
    registerModule(testModule);
    // Enable "agency" for this tenant so the dispatch isn't skipped.
    await withTenants([co], (c) =>
      c.query(`UPDATE companies SET enabled_modules = array_append(enabled_modules, 'agency') WHERE id = $1`, [co]),
    );

    const entityId = "00000000-0000-0000-0000-000000000020";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", { by: "u1" }));
    await relayBatch(100);

    const handled = await consumeOnce("deliverable");
    expect(handled).toBe(1);
    expect(received).toHaveLength(1);
    expect((received[0] as { entityId: string }).entityId).toBe(entityId);
  });

  it("does not dispatch if the module isn't enabled for the event's tenant", async () => {
    const testModule: ModuleContract = {
      key: "agency",
      migrations: [],
      permissions: [],
      customFieldTargets: [],
      mcpTools: [],
      rollupProviders: [],
      uiManifest: [],
      eventHandlers: { "deliverable.approved": async () => { received.push("should not run"); } },
    };
    registerModule(testModule);
    // Note: enabled_modules defaults empty for a fresh company — do NOT enable "agency" here.
    const entityId = "00000000-0000-0000-0000-000000000021";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", {}));
    await relayBatch(100);

    await consumeOnce("deliverable");
    expect(received).toHaveLength(0);
  });

  it("does not ack an entry when a handler throws, leaving it pending for redelivery", async () => {
    const testModule: ModuleContract = {
      key: "agency",
      migrations: [],
      permissions: [],
      customFieldTargets: [],
      mcpTools: [],
      rollupProviders: [],
      uiManifest: [],
      eventHandlers: {
        "deliverable.approved": async () => {
          throw new Error("boom");
        },
      },
    };
    registerModule(testModule);
    await withTenants([co], (c) =>
      c.query(`UPDATE companies SET enabled_modules = array_append(enabled_modules, 'agency') WHERE id = $1`, [co]),
    );

    const entityId = "00000000-0000-0000-0000-000000000022";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", { by: "u1" }));
    await relayBatch(100);

    const handled = await consumeOnce("deliverable");
    // The handler threw, so the entry must NOT be counted as handled/acked.
    expect(handled).toBe(0);

    // Verify via XPENDING summary that the entry is still pending (un-acked) in the group.
    const summary = (await redis.xpending("events:deliverable", "in-process-platform")) as [
      number,
      string | null,
      string | null,
      [string, string][] | null,
    ];
    const [pendingCount] = summary;
    expect(pendingCount).toBeGreaterThanOrEqual(1);
  });

  it("moves an event to the dead-letter stream after repeated handler failure", async () => {
    const failingModule: ModuleContract = {
      key: "agency",
      migrations: [],
      permissions: [],
      customFieldTargets: [],
      mcpTools: [],
      rollupProviders: [],
      uiManifest: [],
      eventHandlers: {
        "deliverable.approved": async () => {
          throw new Error("always fails");
        },
      },
    };
    registerModule(failingModule);
    await withTenants([co], (c) =>
      c.query(`UPDATE companies SET enabled_modules = array_append(enabled_modules, 'agency') WHERE id = $1`, [co]),
    );
    const entityId = "00000000-0000-0000-0000-000000000030";
    await withTenants([co], (c) => emitEvent(c, co, "deliverable", entityId, "deliverable.approved", {}));
    await relayBatch(100);

    // Retry past DEAD_LETTER_MAX_RETRIES.
    for (let i = 0; i < 6; i++) await consumeOnce("deliverable");

    const dead = await redis.xrange("events:deliverable:dead-letter", "-", "+");
    expect(dead.length).toBeGreaterThanOrEqual(1);
  });
});
