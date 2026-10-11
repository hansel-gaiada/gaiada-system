// M3 T8 — deterministic shutdown: closing a Redis-backed component while it is still connecting, or
// while one of its commands is in flight, must leave no unhandled rejection behind.
//
// WHY THIS FILE EXISTS. editorial-assertion-matrix / -jwks and zz-real-boot ended with "Connection is
// closed." unhandled rejections (the api suite exited 1 with 0 failed tests), but only when a change to
// the module graph moved the module destroy order. The rejection is real in every order; the graph change
// only decided whether a close landed while a client was still connecting. These rows pin it directly,
// with no dependence on the destroy order:
//
//   1. the BullMQ clients (mail queue + worker, tenant webhook queue + worker, scheduler queue + worker),
//      closed right after construction: the actual source of the rejections (bullmq closes an
//      initialising connection, removes its listeners, then re-emits init()'s failure as an 'error' with
//      no listener, which throws inside an unawaited handler). See src/queue/bullmq-shutdown.ts.
//   2. the editorial jti replay store, closed while a SET NX is in flight (the ticket's other suspect):
//      the command finishes, a command after close is refused without touching the client, and a dead
//      store's in-flight command fails into JtiReplayStoreUnavailableError (handled), not into the void.
//   3. the same through RealEditorialPrincipalResolver.onModuleDestroy, the production path.
//
// Every row watches `process.on('unhandledRejection')` itself (vitest also fails the run on one).
// Real Redis (REDIS_URL, as the gate provides); no Postgres, no app boot.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { MailSenderProcessor } from "../src/mail/mail-sender.processor";
import { MailService } from "../src/mail/mail.service";
import { TenantWebhookSenderProcessor } from "../src/tenant-webhooks/tenant-webhook-sender.processor";
import { TenantWebhookDispatcherService } from "../src/tenant-webhooks/tenant-webhook-dispatcher.service";
import { SchedulerService } from "../src/scheduler/scheduler.service";
import { JTI_KEY_PREFIX, JtiReplayStoreUnavailableError, RedisJtiReplayStore } from "../src/control/auth/jti-replay-store";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import type { ControlRequest } from "../src/control/auth/control-request";
import { freshKey, keySetOf, mintEditorial } from "./editorial-assertion-kit";

/** Collects unhandled rejections until stop(); settle() waits long enough for Node to report one. */
function watchUnhandled() {
  const seen: string[] = [];
  const onRejection = (reason: unknown) => void seen.push(reason instanceof Error ? reason.message : String(reason));
  process.on("unhandledRejection", onRejection);
  return {
    seen,
    settle: () => new Promise<void>((resolve) => setTimeout(resolve, 500)),
    stop: () => void process.off("unhandledRejection", onRejection),
  };
}

const redisUrl = () => new URL(process.env.REDIS_URL || "redis://localhost:6379");
const liveClient = () => {
  const u = redisUrl();
  return new Redis({ host: u.hostname, port: Number(u.port || 6379), password: u.password || undefined });
};

describe("M3 T8 shutdown: no unhandled rejection when Redis clients close while connecting or mid-command", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let probe: Redis;
  let watch: ReturnType<typeof watchUnhandled>;

  beforeAll(() => {
    // Queue names of their own: a worker built here must never pick up another spec's jobs.
    for (const [k, v] of Object.entries({
      MAIL_QUEUE_NAME: `t8-mail-${randomUUID().slice(0, 8)}`,
      TENANT_WEBHOOK_QUEUE_NAME: `t8-webhook-${randomUUID().slice(0, 8)}`,
      WEBDESK_SCHEDULER_ENABLED: "true",
      WEBDESK_SCHEDULER_QUEUE_NAME: `t8-scheduler-${randomUUID().slice(0, 8)}`,
    })) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    probe = liveClient();
  });

  afterAll(async () => {
    // The queues above are this file's own: leave nothing behind in the shared Redis.
    const queues = [process.env.MAIL_QUEUE_NAME, process.env.TENANT_WEBHOOK_QUEUE_NAME, process.env.WEBDESK_SCHEDULER_QUEUE_NAME];
    const stale = (await Promise.all(queues.map((q) => probe.keys(`bull:${q}:*`)))).flat();
    if (stale.length > 0) await probe.del(...stale);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await probe.quit().catch(() => probe.disconnect());
  });

  afterEach(() => {
    watch?.stop();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------------------------------------
  // 1. BullMQ: closed immediately after construction
  // ------------------------------------------------------------------------------------------------
  it("BullMQ queues and workers closed right after construction (still connecting) leave no unhandled rejection", async () => {
    watch = watchUnhandled();
    // A close at 0 ms lands before the socket connects; later ones land mid-handshake (INFO, CLIENT SETINFO
    // in flight), the window the suite's failures came from. Sweep both: which one a machine hits varies.
    for (const delayMs of [0, 1, 2, 3, 4, 5, 6, 8, 10, 14, 20]) {
      const webhookWorker = new TenantWebhookSenderProcessor({} as never);
      const mailWorker = new MailSenderProcessor({} as never, {} as never, {} as never);
      const mailQueue = new MailService({} as never, {} as never, {} as never, {} as never);
      const webhookQueue = new TenantWebhookDispatcherService({} as never, {} as never);
      // Stubs that do nothing: the scheduler's worker may become ready and pick up its tick before the close.
      const scheduler = new SchedulerService(
        { databaseNow: async () => new Date(), runContentTick: async () => ({ totals: { errors: 0 } }) } as never,
        { runFormsPurge: async () => ({}), runIdempotencySweep: async () => ({}) } as never,
        { onBeforeEnd: () => undefined } as never,
      );
      webhookWorker.onModuleInit();
      mailWorker.onModuleInit();
      scheduler.onModuleInit();
      // Every client is still initialising when the close starts.
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      await Promise.all([
        webhookWorker.onModuleDestroy(),
        mailWorker.onModuleDestroy(),
        mailQueue.onModuleDestroy(),
        webhookQueue.onModuleDestroy(),
        scheduler.onModuleDestroy(),
      ]);
    }
    await watch.settle();
    expect(watch.seen).toEqual([]);
  }, 60_000);

  // ------------------------------------------------------------------------------------------------
  // 2. The jti replay store
  // ------------------------------------------------------------------------------------------------
  it("jti store: close() while a SET NX is in flight (client still connecting) lets the command finish, then closes", async () => {
    watch = watchUnhandled();
    const store = new RedisJtiReplayStore(); // lazyConnect:false: the connection is being made right now
    const jti = `t8-${randomUUID()}`;
    const inFlight = store.consume(jti, 30_000);
    const closed = store.close(); // issued while the command is queued and the client is not ready
    await expect(inFlight).resolves.toBe(true); // finished, not cut off
    await closed;
    expect(await probe.exists(`${JTI_KEY_PREFIX}${jti}`)).toBe(1); // it really was consumed
    await watch.settle();
    expect(watch.seen).toEqual([]);
    await probe.del(`${JTI_KEY_PREFIX}${jti}`);
  });

  it("jti store: no command is issued after close() began (fail closed, the client is never touched)", async () => {
    watch = watchUnhandled();
    const client = liveClient();
    const set = vi.spyOn(client, "set");
    const store = new RedisJtiReplayStore(client);
    await expect(store.consume(`t8-${randomUUID()}`, 30_000)).resolves.toBe(true);
    expect(set).toHaveBeenCalledTimes(1);

    const closing = store.close();
    await expect(store.consume(`t8-${randomUUID()}`, 30_000)).rejects.toBeInstanceOf(JtiReplayStoreUnavailableError); // during close
    await closing;
    await expect(store.consume(`t8-${randomUUID()}`, 30_000)).rejects.toThrow(/closed/); // after close
    expect(set).toHaveBeenCalledTimes(1); // neither refused call reached the client
    await store.close(); // idempotent
    await vi.waitFor(() => expect(client.status).toBe("end")); // the quit's socket close lands a tick after the reply
    await watch.settle();
    expect(watch.seen).toEqual([]);
  });

  it("jti store: a command in flight on an UNREACHABLE store fails into JtiReplayStoreUnavailableError when the store closes, not into an unhandled rejection", async () => {
    watch = watchUnhandled();
    const dead = new Redis({ host: "127.0.0.1", port: 1, maxRetriesPerRequest: 1, commandTimeout: 1_500, connectTimeout: 1_000, lazyConnect: false });
    const store = new RedisJtiReplayStore(dead);
    const inFlight = store.consume(`t8-${randomUUID()}`, 30_000);
    const outcome = inFlight.then(
      () => "resolved",
      (err) => err,
    );
    await store.close(); // waits for the command (bounded), then disconnects
    expect(await outcome).toBeInstanceOf(JtiReplayStoreUnavailableError);
    expect(dead.status).not.toBe("ready");
    await watch.settle();
    expect(watch.seen).toEqual([]);
  }, 20_000);

  // ------------------------------------------------------------------------------------------------
  // 3. The production path: the resolver's onModuleDestroy while a jti command is in flight
  // ------------------------------------------------------------------------------------------------
  it("RealEditorialPrincipalResolver: the app closes (onModuleDestroy) while the jti command is in flight -> the request is answered, nothing is unhandled, a later resolve is a 503", async () => {
    watch = watchUnhandled();
    const key = freshKey("wde-t8");
    const now = Math.floor(Date.now() / 1000);
    const resolver = new RealEditorialPrincipalResolver({ keys: keySetOf(key), now: () => now });
    // The resolver owns a Redis store (REDIS_URL). Signal the moment its jti command is issued.
    const store = (resolver as unknown as { store: RedisJtiReplayStore }).store;
    let issued!: () => void;
    const commandIssued = new Promise<void>((resolve) => (issued = resolve));
    const consume = store.consume.bind(store);
    store.consume = (jti: string, ttlMs: number) => {
      const p = consume(jti, ttlMs);
      issued();
      return p;
    };

    const params = { tenantSlug: "t8-tenant", siteId: randomUUID() };
    const body = { collectionKey: "service", locale: "en", slug: "service.t8" };
    const assertion = (jti: string) =>
      mintEditorial(key, {
        sub: "erp-user-t8", pk: "human", ten: params.tenantSlug, site: params.siteId, cmd: "content.create",
        cmh: computeCommandHash("content.create", { ...params, ...body }), iat: now, exp: now + 60, jti,
      });
    const request = (jti: string) =>
      ({ params, headers: { "x-webdesk-editorial-assertion": assertion(jti) } }) as unknown as ControlRequest;

    const first = resolver.resolve(request(randomUUID()), "content.create", { ...params, ...body });
    const firstOutcome = first.then(
      (p) => ({ ok: true as const, sub: p.sub }),
      (err: { getStatus?: () => number }) => ({ ok: false as const, status: err.getStatus?.() }),
    );
    await commandIssued;
    await resolver.onModuleDestroy(); // closes the store with that command in flight

    // The in-flight request was answered (finished, as it was not cut off), never left dangling.
    expect(await firstOutcome).toEqual({ ok: true, sub: "erp-user-t8" });
    // After the close the store refuses, and the resolver turns that into the documented 503.
    const later = await resolver.resolve(request(randomUUID()), "content.create", { ...params, ...body }).then(
      () => ({ status: 0 }),
      (err: { getStatus?: () => number }) => ({ status: err.getStatus?.() }),
    );
    expect(later).toEqual({ status: 503 });
    await watch.settle();
    expect(watch.seen).toEqual([]);
  });
});
