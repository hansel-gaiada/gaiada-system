// WSK-61 — the scheduler's wiring and configuration: the BullMQ job schedulers, the worker, boot and
// shutdown, and the env contract. Real Redis, real Postgres, the real AppModule as shipped (the same
// graph production builds). The behaviour of what the jobs DO is in scheduler-content-tick.spec.ts.
//
// Every app built here gets its own queue name (WEBDESK_SCHEDULER_QUEUE_NAME), so its job schedulers
// cannot collide with another spec's or a previous run's, and is closed before the next test.
import "./content-test-kit"; // env bootstrap (NODE_ENV=test, database urls, pepper) before AppModule loads
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Queue, QueueEvents } from "bullmq";
import { AppModule } from "../src/app.module";
import { createFastifyAdapter } from "../src/app";
import { redisConnectionOptions } from "../src/queue/redis-connection";
import { SchedulerService } from "../src/scheduler/scheduler.service";
import {
  HOURLY_SECONDS,
  JOB_CONTENT_TICK,
  JOB_FORMS_PURGE,
  JOB_IDEMPOTENCY_SWEEP,
  JOB_MEDIA_PURGE,
  SCHEDULER_JOB_IDS,
  SchedulerConfigError,
  TICK_SECONDS,
  resolveSchedulerSettings,
} from "../src/scheduler/scheduler.config";

const ENV_KEYS = [
  "WEBDESK_SCHEDULER_ENABLED",
  "WEBDESK_SCHEDULER_TICK_SECONDS",
  "WEBDESK_SCHEDULER_HOURLY_SECONDS",
  "WEBDESK_SCHEDULER_QUEUE_NAME",
] as const;

describe("WSK-61 scheduler config (pure)", () => {
  const env = (over: Record<string, string | undefined>) => ({ NODE_ENV: "production", ...over }) as NodeJS.ProcessEnv;

  it("defaults: enabled in production (and in dev), off under NODE_ENV=test; 60 s tick, hourly 3600 s, queue webdesk-scheduler", () => {
    expect(resolveSchedulerSettings(env({}))).toEqual({ enabled: true, tickSeconds: 60, hourlySeconds: 3600, queueName: "webdesk-scheduler" });
    expect(resolveSchedulerSettings(env({ NODE_ENV: "development" })).enabled).toBe(true);
    expect(resolveSchedulerSettings(env({ NODE_ENV: undefined })).enabled).toBe(true);
    expect(resolveSchedulerSettings(env({ NODE_ENV: "test" })).enabled).toBe(false);
    expect(TICK_SECONDS).toEqual({ default: 60, min: 15, max: 300 });
    expect(HOURLY_SECONDS).toEqual({ default: 3600, min: 300, max: 86_400 });
  });

  it("an EMPTY variable (or only whitespace) means the default, never 0", () => {
    const s = resolveSchedulerSettings(
      env({ WEBDESK_SCHEDULER_ENABLED: "", WEBDESK_SCHEDULER_TICK_SECONDS: "", WEBDESK_SCHEDULER_HOURLY_SECONDS: "  ", WEBDESK_SCHEDULER_QUEUE_NAME: "" }),
    );
    expect(s).toEqual({ enabled: true, tickSeconds: 60, hourlySeconds: 3600, queueName: "webdesk-scheduler" });
    expect(resolveSchedulerSettings({ NODE_ENV: "test", WEBDESK_SCHEDULER_ENABLED: "" } as NodeJS.ProcessEnv).enabled).toBe(false);
  });

  it("values inside the range are taken, boundaries included", () => {
    expect(resolveSchedulerSettings(env({ WEBDESK_SCHEDULER_TICK_SECONDS: "15", WEBDESK_SCHEDULER_HOURLY_SECONDS: "300" }))).toMatchObject({ tickSeconds: 15, hourlySeconds: 300 });
    expect(resolveSchedulerSettings(env({ WEBDESK_SCHEDULER_TICK_SECONDS: "300", WEBDESK_SCHEDULER_HOURLY_SECONDS: "86400" }))).toMatchObject({ tickSeconds: 300, hourlySeconds: 86_400 });
    expect(resolveSchedulerSettings(env({ WEBDESK_SCHEDULER_TICK_SECONDS: " 120 " })).tickSeconds).toBe(120);
  });

  it.each([
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "0"],
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "14"],
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "301"],
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "-60"],
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "60.5"],
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "1e2"],
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "abc"],
    ["WEBDESK_SCHEDULER_HOURLY_SECONDS", "299"],
    ["WEBDESK_SCHEDULER_HOURLY_SECONDS", "86401"],
    ["WEBDESK_SCHEDULER_HOURLY_SECONDS", "0"],
    ["WEBDESK_SCHEDULER_ENABLED", "maybe"],
  ])("%s=%s is refused with a message naming the variable", (name, value) => {
    let err: unknown;
    try {
      resolveSchedulerSettings(env({ [name]: value }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SchedulerConfigError);
    expect((err as Error).message).toContain(name);
    expect((err as Error).message).toContain(JSON.stringify(value));
    expect((err as Error).message).toContain("Refusing to boot");
  });

  it("true/false spellings", () => {
    for (const v of ["true", "TRUE", "1", "yes"]) expect(resolveSchedulerSettings({ NODE_ENV: "test", WEBDESK_SCHEDULER_ENABLED: v } as NodeJS.ProcessEnv).enabled).toBe(true);
    for (const v of ["false", "False", "0", "no"]) expect(resolveSchedulerSettings(env({ WEBDESK_SCHEDULER_ENABLED: v })).enabled).toBe(false);
  });
});

describe("WSK-61 scheduler wiring (real Redis, the real AppModule)", () => {
  const apps: NestFastifyApplication[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => {
    unhandled.push(e);
  };
  const saved: Record<string, string | undefined> = {};
  let queueName = "";

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.on("unhandledRejection", onUnhandled);
    process.on("uncaughtException", onUnhandled);
  });

  afterAll(() => {
    process.off("unhandledRejection", onUnhandled);
    process.off("uncaughtException", onUnhandled);
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  afterEach(async () => {
    while (apps.length) await apps.pop()?.close();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  function useEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
    queueName = `wsk61-wiring-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.WEBDESK_SCHEDULER_QUEUE_NAME = queueName;
    for (const [k, v] of Object.entries(over)) process.env[k] = v;
  }

  async function boot(): Promise<NestFastifyApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: ["error"] });
    apps.push(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }

  const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

  it("disabled (the NODE_ENV=test default): no queue, no worker, nothing registered", async () => {
    useEnv({});
    const app = await boot();
    const svc = app.get(SchedulerService);
    expect(svc.settings).toMatchObject({ enabled: false });
    await svc.registered;
    expect(await svc.listJobSchedulers()).toEqual([]);
    const probe = new Queue(queueName, { connection: redisConnectionOptions() as never });
    try {
      expect(await probe.getJobSchedulers()).toEqual([]);
    } finally {
      await probe.close();
    }
  });

  it("enabled: queue.getJobSchedulers() lists exactly the four ids with the configured intervals; a second app instance leaves it at four; shutdown leaves no unhandled error", async () => {
    useEnv({ WEBDESK_SCHEDULER_ENABLED: "true", WEBDESK_SCHEDULER_TICK_SECONDS: "20", WEBDESK_SCHEDULER_HOURLY_SECONDS: "600" });
    const first = await boot();
    const svc1 = first.get(SchedulerService);
    await svc1.registered;
    const expected = [
      { id: JOB_CONTENT_TICK, everyMs: 20_000 },
      { id: JOB_FORMS_PURGE, everyMs: 600_000 },
      { id: JOB_IDEMPOTENCY_SWEEP, everyMs: 600_000 },
      { id: JOB_MEDIA_PURGE, everyMs: 600_000 },
    ];
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...(await svc1.listJobSchedulers())].sort(byId)).toEqual([...expected].sort(byId));
    expect([...SCHEDULER_JOB_IDS].sort()).toEqual(expected.map((e) => e.id).sort());

    // A second replica boots against the same queue: upsert is idempotent, still exactly four.
    const second = await boot();
    const svc2 = second.get(SchedulerService);
    await svc2.registered;
    expect([...(await svc2.listJobSchedulers())].sort(byId)).toEqual([...expected].sort(byId));
    expect([...(await svc1.listJobSchedulers())].sort(byId)).toEqual([...expected].sort(byId));

    // The same, seen from outside the apps.
    const probe = new Queue(queueName, { connection: redisConnectionOptions() as never });
    try {
      const list = await probe.getJobSchedulers();
      expect(list.map((j) => j.key).sort()).toEqual([...SCHEDULER_JOB_IDS].sort());
      expect(await probe.getJobSchedulersCount()).toBe(4);
    } finally {
      await probe.close();
    }

    // Shutdown, one replica at a time: the other keeps its registration, nothing is left to reject.
    const before = unhandled.length;
    await first.close();
    apps.splice(apps.indexOf(first), 1);
    await settle();
    expect([...(await svc2.listJobSchedulers())].sort(byId)).toEqual([...expected].sort(byId));
    await second.close();
    apps.splice(apps.indexOf(second), 1);
    await settle();
    expect(unhandled.slice(before)).toEqual([]);
  }, 60_000);

  it("three replicas booting at the same instant still register exactly four job schedulers", async () => {
    useEnv({ WEBDESK_SCHEDULER_ENABLED: "true", WEBDESK_SCHEDULER_TICK_SECONDS: "30", WEBDESK_SCHEDULER_HOURLY_SECONDS: "900" });
    const replicas = await Promise.all([boot(), boot(), boot()]);
    await Promise.all(replicas.map((a) => a.get(SchedulerService).registered));
    const probe = new Queue(queueName, { connection: redisConnectionOptions() as never });
    try {
      const list = await probe.getJobSchedulers();
      expect(list.map((j) => j.key).sort()).toEqual([...SCHEDULER_JOB_IDS].sort());
      expect(Object.fromEntries(list.map((j) => [j.key, Number(j.every)]))).toEqual({
        [JOB_CONTENT_TICK]: 30_000,
        [JOB_FORMS_PURGE]: 900_000,
        [JOB_IDEMPOTENCY_SWEEP]: 900_000,
        [JOB_MEDIA_PURGE]: 900_000,
      });
    } finally {
      await probe.close();
    }
  }, 60_000);

  it("an EMPTY env gives the defaults (60 s tick, hourly 3600 s), never 0", async () => {
    useEnv({ WEBDESK_SCHEDULER_ENABLED: "true", WEBDESK_SCHEDULER_TICK_SECONDS: "", WEBDESK_SCHEDULER_HOURLY_SECONDS: "" });
    const app = await boot();
    const svc = app.get(SchedulerService);
    await svc.registered;
    expect(svc.settings).toMatchObject({ enabled: true, tickSeconds: 60, hourlySeconds: 3600 });
    const got = Object.fromEntries((await svc.listJobSchedulers()).map((j) => [j.id, j.everyMs]));
    expect(got).toEqual({ [JOB_CONTENT_TICK]: 60_000, [JOB_FORMS_PURGE]: 3_600_000, [JOB_IDEMPOTENCY_SWEEP]: 3_600_000, [JOB_MEDIA_PURGE]: 3_600_000 });
  }, 30_000);

  it.each([
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "5"],
    ["WEBDESK_SCHEDULER_TICK_SECONDS", "0"],
    ["WEBDESK_SCHEDULER_HOURLY_SECONDS", "86401"],
  ] as const)("%s=%s refuses to boot, with a clear message, and leaves nothing behind", async (name, value) => {
    useEnv({ WEBDESK_SCHEDULER_ENABLED: "true", [name]: value });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: false });
    apps.push(app);
    const before = unhandled.length;
    await expect(app.init()).rejects.toThrow(new RegExp(`${name}=.*not allowed.*Refusing to boot`));
    await app.close(); // what a failed boot owes its collaborators: their own shutdown hooks still run
    apps.pop();
    await settle();
    expect(unhandled.slice(before)).toEqual([]);
    const probe = new Queue(queueName, { connection: redisConnectionOptions() as never });
    try {
      expect(await probe.getJobSchedulers()).toEqual([]); // nothing was registered
    } finally {
      await probe.close();
    }
  }, 30_000);

  it("the worker dispatches by job name: the maintenance jobs, the media purge and the content tick complete, an unknown name fails (and nothing crashes)", async () => {
    // Long intervals: the schedulers themselves will not fire during this test; jobs are added by hand.
    useEnv({ WEBDESK_SCHEDULER_ENABLED: "true", WEBDESK_SCHEDULER_TICK_SECONDS: "300", WEBDESK_SCHEDULER_HOURLY_SECONDS: "86400" });
    const app = await boot();
    await app.get(SchedulerService).registered;
    const queue = new Queue(queueName, { connection: redisConnectionOptions() as never });
    const events = new QueueEvents(queueName, { connection: redisConnectionOptions() as never });
    try {
      await events.waitUntilReady();
      const sweep = await queue.add(JOB_IDEMPOTENCY_SWEEP, {});
      const sweepOut = (await sweep.waitUntilFinished(events, 20_000)) as { tenantsSwept: number };
      expect(sweepOut.tenantsSwept).toBeGreaterThanOrEqual(0);
      expect(typeof sweepOut.tenantsSwept).toBe("number");

      const purge = await queue.add(JOB_FORMS_PURGE, {});
      const purgeOut = (await purge.waitUntilFinished(events, 20_000)) as { tenants: number; purged: number };
      expect(purgeOut).toEqual({ tenants: expect.any(Number), purged: expect.any(Number) });

      const content = await queue.add(JOB_CONTENT_TICK, {});
      const contentOut = (await content.waitUntilFinished(events, 60_000)) as { published: number; errors: number };
      expect(contentOut.errors).toBe(0);

      // WSK-43a: the media purge is dispatched by name and answers its counts (nothing is due here).
      const mediaPurge = await queue.add(JOB_MEDIA_PURGE, {});
      const mediaOut = (await mediaPurge.waitUntilFinished(events, 60_000)) as { tenants: number; purged: number; versionsDeleted: number; failed: number };
      expect(mediaOut).toEqual({ tenants: expect.any(Number), purged: expect.any(Number), versionsDeleted: expect.any(Number), failed: 0 });

      const bogus = await queue.add("not-a-job", {}, { attempts: 1 });
      await expect(bogus.waitUntilFinished(events, 20_000)).rejects.toThrow(/unknown scheduler job: not-a-job/);
    } finally {
      await events.close();
      await queue.close();
    }
  }, 120_000);
});
