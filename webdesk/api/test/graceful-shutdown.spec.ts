// M3 T8 — graceful shutdown: a SIGTERM lets the scheduler's running tick finish its item before the
// database pool ends.
//
// What is real: the AppModule as shipped, real Redis (BullMQ), real Postgres, and the signal handler
// Nest installs (`enableGracefulShutdown`, the function main.ts calls). What is not: the signal itself.
// Nest's handler ends by re-raising the signal on the process (`process.kill(process.pid, signal)`), which
// would kill the test runner, and delivering a real SIGTERM to a vitest worker is not something a spec
// can do safely. So the spec invokes the very listener Nest registered for SIGTERM (found by diffing
// process.listeners) with `process.kill` stubbed, and the shutdown sequence it runs (destroy hooks,
// before-shutdown, dispose, shutdown hooks) is the real one. An end-to-end SIGTERM of a child process is
// not feasible in this harness either: the api needs decorator metadata, which the vitest SWC transform
// provides and `node --import tsx` (esbuild) does not, and there is no compiled entry point in the gate.
//
// The tick is made slow, and its LAST step is a database query. If the pool ended while the tick still had
// that query to run, it would fail with "Cannot use a pool after calling end".
import "./content-test-kit"; // env bootstrap (NODE_ENV=test, database urls, pepper) before AppModule loads
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Queue } from "bullmq";
import { AppModule } from "../src/app.module";
import { SHUTDOWN_SIGNALS, createFastifyAdapter, enableGracefulShutdown } from "../src/app";
import { DbService } from "../src/db/db.service";
import { redisConnectionOptions } from "../src/queue/redis-connection";
import { SchedulerService } from "../src/scheduler/scheduler.service";
import { ContentTickService } from "../src/scheduler/content-tick.service";
import { JOB_CONTENT_TICK } from "../src/scheduler/scheduler.config";

const ENV_KEYS = ["WEBDESK_SCHEDULER_ENABLED", "WEBDESK_SCHEDULER_TICK_SECONDS", "WEBDESK_SCHEDULER_HOURLY_SECONDS", "WEBDESK_SCHEDULER_QUEUE_NAME"] as const;

describe("M3 T8 graceful shutdown (SIGTERM path, real app)", () => {
  const saved: Record<string, string | undefined> = {};
  let app: NestFastifyApplication | undefined;
  let queue: Queue | undefined;
  let queueName = "";

  beforeAll(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    queue = undefined;
    await app?.close().catch(() => undefined); // a no-op when the signal path already closed it
    app = undefined;
  });

  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("enableGracefulShutdown registers handlers for exactly SIGTERM and SIGINT, and nothing else", () => {
    expect([...SHUTDOWN_SIGNALS]).toEqual(["SIGTERM", "SIGINT"]);
    const calls: string[][] = [];
    enableGracefulShutdown({ enableShutdownHooks: (signals?: unknown) => void calls.push(signals as string[]) } as never);
    expect(calls).toEqual([["SIGTERM", "SIGINT"]]);
  });

  it("SIGTERM during a running content tick: the tick finishes (including its last DB query) BEFORE the pool ends, then the signal is re-raised", async () => {
    queueName = `t8-shutdown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    process.env.WEBDESK_SCHEDULER_ENABLED = "true";
    process.env.WEBDESK_SCHEDULER_TICK_SECONDS = "300"; // the schedulers never fire during the test; the job is added by hand
    process.env.WEBDESK_SCHEDULER_HOURLY_SECONDS = "86400";
    process.env.WEBDESK_SCHEDULER_QUEUE_NAME = queueName;

    // Stubs go in BEFORE init(): the scheduler registers on init and its first tick can run at once.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const events: string[] = [];
    let tickEntered!: () => void;
    const entered = new Promise<void>((resolve) => (tickEntered = resolve));
    let lastQueryOk: boolean | undefined;
    const db = moduleRef.get(DbService);
    vi.spyOn(moduleRef.get(ContentTickService), "runContentTick").mockImplementation(async () => {
      events.push("tick:start");
      tickEntered();
      await new Promise((resolve) => setTimeout(resolve, 1_500)); // the SIGTERM lands in here
      try {
        await db.query("SELECT 1"); // the item's last step needs the pool
        lastQueryOk = true;
      } catch {
        lastQueryOk = false;
      }
      events.push("tick:done");
      return { tenants: [], totals: { published: 0, swapped: 0, swapsCancelled: 0, swapsFailed: 0, tookDown: 0, errors: 0 } } as never;
    });
    const endPool = db.pool.end.bind(db.pool);
    vi.spyOn(db.pool, "end").mockImplementation((async () => {
      events.push("pool.end");
      return endPool();
    }) as never);
    let reraised!: (args: unknown[]) => void;
    const kill = new Promise<unknown[]>((resolve) => (reraised = resolve));
    vi.spyOn(process, "kill").mockImplementation(((...args: unknown[]) => {
      events.push("process.kill");
      reraised(args);
      return true;
    }) as never);

    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(), { logger: ["error"] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.get(SchedulerService).registered;

    // The listener Nest installs for SIGTERM (and nothing else of the runner's own).
    const before = new Set(process.listeners("SIGTERM"));
    enableGracefulShutdown(app);
    const installed = process.listeners("SIGTERM").filter((l) => !before.has(l));
    expect(installed).toHaveLength(1);

    queue = new Queue(queueName, { connection: redisConnectionOptions() as never });
    await queue.add(JOB_CONTENT_TICK, {}); // in case the scheduler's own first tick has not been created yet
    await entered; // the worker is inside a tick
    const job = (await queue.getActive())[0];
    expect(job?.name).toBe(JOB_CONTENT_TICK);

    void installed[0]("SIGTERM"); // what Node does when the process receives SIGTERM
    expect(await kill).toEqual([process.pid, "SIGTERM"]); // the whole shutdown ran, then the signal was re-raised

    expect(lastQueryOk).toBe(true);
    expect(events).toEqual(["tick:start", "tick:done", "pool.end", "process.kill"]);
    expect(await queue.getJobState(job.id as string)).toBe("completed"); // ended normally, not left active for a stall sweep
    expect(process.listeners("SIGTERM").filter((l) => !before.has(l))).toEqual([]); // Nest removed its handler
  }, 60_000);
});
