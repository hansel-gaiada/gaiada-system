// M6-P4r-b -- the live contract-codegen rail against REAL services: Postgres (webdesk_app, NOBYPASSRLS),
// Redis (a real BullMQ queue + worker) and RustFS (the real artifacts bucket, written with the api's own key).
// SERVICE-BACKED: needs the Linux gate's three containers and `npm run build` first (the worker loads
// dist/codegen/generator.mjs). The service-free logic is in contract-codegen-{queue,processor,triggers}.spec.ts.
//
// Env (same names and defaults as codegen-contract-controller.spec.ts): APP_DATABASE_URL,
// MIGRATE_DATABASE_URL, REDIS_URL, STORAGE_ENDPOINT / STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY.
// Every app here gets a queue name of its own, and every tenant a random slug, so nothing collides with
// another spec or a previous run.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55500/webdesk";
process.env.MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55500/webdesk";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "contract-codegen-live-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";
process.env.STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT || "http://localhost:55501";
process.env.STORAGE_ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_api";
process.env.STORAGE_SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_api_secret_key";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { DbService } from "../src/db/db.service";
import { ContractCodegenQueue } from "../src/codegen/contract-codegen.queue";
import { PgContractCodegenLock } from "../src/codegen/contract-codegen.lock";
import { resolveBundlePath } from "../src/codegen/contract-codegen.runner";
import { CONTRACT_CODEGEN_RUNNER, ContractCodegenLockBusyError, type ContractCodegenRunner, type ContractCodegenRunResult } from "../src/codegen/contract-codegen.types";
import { latestPointerKey } from "../src/codegen/artifact-keys";
import type { LatestContractPointer } from "../src/codegen/contract-manifest.types";
import { S3StorageAdapter } from "../src/storage/s3-storage.adapter";
import { storageConfig } from "../src/storage/storage.config";

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL!;
const TITLE = { name: "title", primitive: "text" };
const BODY = { name: "body", primitive: "text" };
const SUMMARY = { name: "summary", primitive: "text" };

const storage = new S3StorageAdapter({
  endpoint: storageConfig.endpoint,
  region: storageConfig.region,
  forcePathStyle: storageConfig.forcePathStyle,
  accessKeyId: storageConfig.accessKeyId,
  secretAccessKey: storageConfig.secretAccessKey,
});

async function readPointer(slug: string): Promise<LatestContractPointer | null> {
  const bucket = storageConfig.bucketName("artifacts");
  try {
    if (!(await storage.headObject(bucket, latestPointerKey(slug)))) return null;
    const obj = await storage.getObject(bucket, latestPointerKey(slug));
    return JSON.parse(obj.body.toString("utf8")) as LatestContractPointer;
  } catch {
    return null;
  }
}

async function until<T>(what: string, probe: () => Promise<T | null | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The queue is empty (nothing waiting, running or backing off) on two looks in a row. */
async function queueIdle(app: NestFastifyApplication): Promise<void> {
  const queue = app.get(ContractCodegenQueue, { strict: false });
  let calm = 0;
  await until("the contract-codegen queue to drain", async () => {
    const c = await queue.counts();
    calm = c.waiting + c.active + c.delayed === 0 ? calm + 1 : 0;
    return calm >= 2;
  });
}

async function boot(opts: { runner?: ContractCodegenRunner; attempts?: number } = {}): Promise<NestFastifyApplication> {
  process.env.WEBDESK_CONTRACT_CODEGEN_ENABLED = "true";
  process.env.WEBDESK_CONTRACT_CODEGEN_QUEUE_NAME = `contract-codegen-live-${randomUUID().slice(0, 8)}`;
  process.env.WEBDESK_CONTRACT_CODEGEN_ATTEMPTS = String(opts.attempts ?? 2);
  process.env.WEBDESK_CONTRACT_CODEGEN_BACKOFF_SECONDS = "1";
  let builder = Test.createTestingModule({ imports: [ControlModule] });
  if (opts.runner) builder = builder.overrideProvider(CONTRACT_CODEGEN_RUNNER).useValue(opts.runner);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

const hdr = (idem?: string) => ({
  "x-webdesk-control-principal": "contract-codegen-live",
  "x-webdesk-control-scopes": "webdesk:operate,webdesk:read",
  ...(idem ? { "idempotency-key": idem } : {}),
});
const idem = () => `idem-${randomUUID()}`;

async function provision(app: NestFastifyApplication, slug: string, key = idem()) {
  return app.inject({ method: "POST", url: "/control/v1/tenants", headers: hdr(key), payload: { slug, companyRef: randomUUID() } });
}
async function addSite(app: NestFastifyApplication, slug: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/sites`, headers: hdr(idem()), payload: { kind: "astro", name: slug } });
  expect(res.statusCode).toBeLessThan(300);
  return res.json().site.id as string;
}
const apply = (app: NestFastifyApplication, slug: string, siteId: string, schema: unknown, key = idem()) =>
  app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites/${siteId}/collections/page/schema/apply`,
    headers: hdr(key),
    payload: { schema },
  });

/** A tenant that exists with a composition and has NEVER had a contract: what the backfill is for. */
async function seedLegacyTenant(slug: string): Promise<void> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.platform_ctx', 'true', true)`);
    const { rows } = await client.query(
      `INSERT INTO tenants (slug, company_ref, default_locale, locales) VALUES ($1, gen_random_uuid(), 'id-ID', ARRAY['id-ID']) RETURNING id`,
      [slug],
    );
    await client.query("COMMIT");
    await client.query("BEGIN");
    await client.query(`SELECT set_config('webdesk.tenant_ctx', $1, true)`, [rows[0].id]);
    const site = await client.query(`INSERT INTO sites (tenant_id, kind, name) VALUES ($1, 'astro', $2) RETURNING id`, [rows[0].id, slug]);
    await client.query(`INSERT INTO collections (tenant_id, site_id, key, schema) VALUES ($1, $2, 'article', $3)`, [
      rows[0].id,
      site.rows[0].id,
      JSON.stringify({ fields: [TITLE] }),
    ]);
    await client.query("COMMIT");
  } finally {
    await client.end();
  }
}

describe("contract codegen, live: the REAL compiled generator behind the REAL queue", { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;
  const slug = `p4rb-${randomUUID().slice(0, 8)}`;
  // ONE site and ONE collection key for the whole tenant: two sites with a `page` collection each would put two
  // compositions under the same key in the tenant's contract.
  let siteId = "";

  beforeAll(async () => {
    // The worker loads the compiled bundle; a missing one must fail HERE, loudly, not as a mysterious timeout.
    resolveBundlePath();
    app = await boot();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("tenant.provision queues a run after its commit: contracts/<slug>/latest.json appears at 1.0.0 without a manual step", async () => {
    const res = await provision(app, slug);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.json()).toMatchObject({ tenant: { slug }, replayed: false });
    const pointer = await until("latest.json after tenant.provision", () => readPointer(slug));
    expect(pointer.contractVersion).toBe("1.0.0");
    expect(pointer.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("a MINOR schema.apply (collection added) leads to a NEW contract version; a second MINOR bumps again", async () => {
    await queueIdle(app);
    const before = (await readPointer(slug))!;
    siteId = await addSite(app, slug);

    const first = await apply(app, slug, siteId, { fields: [TITLE] });
    expect(first.statusCode).toBeLessThan(300);
    expect(first.json()).toMatchObject({ bump: "minor", replayed: false });
    await queueIdle(app);
    const afterFirst = (await readPointer(slug))!;
    expect(afterFirst.contractVersion).toBe("1.1.0");
    expect(afterFirst.contentHash).not.toBe(before.contentHash);

    const second = await apply(app, slug, siteId, { fields: [TITLE, BODY] });
    expect(second.json()).toMatchObject({ bump: "minor" });
    await queueIdle(app);
    expect((await readPointer(slug))!.contractVersion).toBe("1.2.0");
  });

  it("a REPLAY of schema.apply (same Idempotency-Key) answers the stored result and queues nothing", async () => {
    await queueIdle(app);
    const key = idem();
    const first = await apply(app, slug, siteId, { fields: [TITLE, BODY, SUMMARY] }, key);
    expect(first.statusCode).toBeLessThan(300);
    await queueIdle(app);
    const version = (await readPointer(slug))!.contractVersion;
    expect(version).toBe("1.3.0");

    const queue = app.get(ContractCodegenQueue, { strict: false });
    const replay = await apply(app, slug, siteId, { fields: [TITLE, BODY, SUMMARY] }, key);
    expect(replay.json()).toMatchObject({ replayed: true });
    expect(await queue.counts()).toEqual({ waiting: 0, active: 0, delayed: 0 });
    expect((await readPointer(slug))!.contractVersion).toBe(version);
  });

  it("re-applying an IDENTICAL composition under a new key does not mint a new contract version (the run reports unchanged)", async () => {
    await queueIdle(app);
    const v1 = (await readPointer(slug))!;
    const res = await apply(app, slug, siteId, { fields: [TITLE, BODY, SUMMARY] }); // new Idempotency-Key, identical composition
    expect(res.statusCode).toBeLessThan(300);
    await queueIdle(app);
    const v2 = (await readPointer(slug))!;
    expect(v2.contractVersion).toBe(v1.contractVersion);
    expect(v2.contentHash).toBe(v1.contentHash);
    expect(v2.generatedAt).toBe(v1.generatedAt); // nothing was rewritten at all
  });

  it("a MAJOR change is refused 409 contract-major-change and nothing is queued; the pointer is untouched", async () => {
    await queueIdle(app);
    const before = (await readPointer(slug))!;
    const res = await apply(app, slug, siteId, { fields: [TITLE] }); // drops `body` and `summary`: MAJOR
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ type: expect.stringContaining("contract-major-change") });
    expect(await app.get(ContractCodegenQueue, { strict: false }).counts()).toEqual({ waiting: 0, active: 0, delayed: 0 });
    expect((await readPointer(slug))!.contractVersion).toBe(before.contractVersion);
  });
});

describe("contract codegen, live: the backfill creates a pointer for a tenant that had none", { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    resolveBundlePath();
    app = await boot();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("contract.regenerate for one tenant publishes its first contract; a second call (new key) changes nothing", async () => {
    const slug = `p4rb-legacy-${randomUUID().slice(0, 8)}`;
    await seedLegacyTenant(slug);
    expect(await readPointer(slug)).toBeNull();

    const res = await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/contract/regenerate`, headers: hdr(idem()) });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.json()).toMatchObject({ scope: "tenant", tenants: [slug], replayed: false, enqueue: { enqueued: 1, failed: 0 } });
    const pointer = await until("latest.json after the backfill", () => readPointer(slug));
    expect(pointer.contractVersion).toBe("1.0.0");

    await queueIdle(app);
    await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/contract/regenerate`, headers: hdr(idem()) });
    await queueIdle(app);
    const again = (await readPointer(slug))!;
    expect(again.contractVersion).toBe("1.0.0");
    expect(again.generatedAt).toBe(pointer.generatedAt);
  });

  it("an unknown tenant is a 404", async () => {
    const res = await app.inject({ method: "POST", url: `/control/v1/tenants/no-such-${randomUUID().slice(0, 8)}/contract/regenerate`, headers: hdr(idem()) });
    expect(res.statusCode).toBe(404);
  });
});

describe("contract codegen, live: a failing run never changes the command", { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;
  const calls: string[] = [];
  const failing: ContractCodegenRunner = {
    async run(slug): Promise<ContractCodegenRunResult> {
      calls.push(slug);
      throw new Error("forced codegen failure");
    },
  };
  beforeAll(async () => {
    app = await boot({ runner: failing, attempts: 2 });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("schema.apply answers and stores exactly what it does with a healthy runner; the job is retried, then dropped", async () => {
    const slug = `p4rb-fail-${randomUUID().slice(0, 8)}`;
    expect((await provision(app, slug)).statusCode).toBeLessThan(300);
    await queueIdle(app); // provision's own job fails too, after its attempts
    const siteId = await addSite(app, slug);
    calls.length = 0;

    const key = idem();
    const res = await apply(app, slug, siteId, { fields: [TITLE] }, key);
    expect(res.statusCode).toBeLessThan(300);
    expect(res.json()).toMatchObject({ bump: "minor", replayed: false, collection: { key: "page" } });

    await queueIdle(app);
    expect(calls.filter((c) => c === slug).length).toBe(2); // 2 attempts, then the job is removed (removeOnFail)
    expect(await readPointer(slug)).toBeNull(); // nothing was published

    const replay = await apply(app, slug, siteId, { fields: [TITLE] }, key);
    expect(replay.json()).toMatchObject({ bump: "minor", replayed: true }); // the stored record is intact
    expect(replay.statusCode).toBe(res.statusCode);
  });

  it("the failure is retryable by the backfill command: the job id is free again", async () => {
    const slug = `p4rb-retry-${randomUUID().slice(0, 8)}`;
    await seedLegacyTenant(slug);
    calls.length = 0;
    await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/contract/regenerate`, headers: hdr(idem()) });
    await queueIdle(app);
    const first = calls.filter((c) => c === slug).length;
    expect(first).toBe(2);
    await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/contract/regenerate`, headers: hdr(idem()) });
    await queueIdle(app);
    expect(calls.filter((c) => c === slug).length).toBe(4); // a failed job did not occupy its id
  });
});

describe("contract codegen, live: real BullMQ coalescing and per-tenant serialization", { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;
  let release: () => void = () => undefined;
  const gate = () => new Promise<void>((r) => (release = r));
  const events: string[] = [];
  let first = true;
  const blocking: ContractCodegenRunner = {
    async run(slug) {
      events.push(`start:${slug}`);
      if (first) {
        first = false;
        await gate();
      }
      events.push(`end:${slug}`);
      return { outcome: "published", contractVersion: "1.0.0", contentHash: "sha256:fake" };
    },
  };
  beforeAll(async () => {
    app = await boot({ runner: blocking });
  });
  afterAll(async () => {
    release();
    await app?.close();
  });

  it("a burst of enqueues during a running job leaves ONE follow-up; the two runs never overlap", async () => {
    const queue = app.get(ContractCodegenQueue, { strict: false });
    const slug = `p4rb-burst-${randomUUID().slice(0, 8)}`;
    await queue.enqueue(slug);
    await until("the first run to start", async () => events.includes(`start:${slug}`));
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) outcomes.push(await queue.enqueue(slug));
    expect(outcomes).toEqual(["added", "coalesced", "coalesced", "coalesced", "coalesced", "coalesced"]);
    expect(await queue.counts()).toMatchObject({ waiting: 1, active: 1 });
    expect(events).toEqual([`start:${slug}`]); // the follow-up is waiting, not running alongside
    release();
    await queueIdle(app);
    expect(events).toEqual([`start:${slug}`, `end:${slug}`, `start:${slug}`, `end:${slug}`]);
  });
});

describe("contract codegen, live: the backfill for ALL tenants", { timeout: 120_000 }, () => {
  let app: NestFastifyApplication;
  const calls: string[] = [];
  const recording: ContractCodegenRunner = {
    async run(slug) {
      calls.push(slug);
      return { outcome: "published", contractVersion: "1.0.0", contentHash: "sha256:fake" };
    },
  };
  beforeAll(async () => {
    app = await boot({ runner: recording });
  });
  afterAll(async () => {
    await app?.close();
  });

  it("queues a run for every active tenant, including one that has never had a contract (fake runner: the shared database holds other specs' tenants)", async () => {
    const slug = `p4rb-all-${randomUUID().slice(0, 8)}`;
    await seedLegacyTenant(slug);
    calls.length = 0;
    const res = await app.inject({ method: "POST", url: "/control/v1/contract/regenerate", headers: hdr(idem()) });
    expect(res.statusCode).toBeLessThan(300);
    expect(res.json().tenants).toContain(slug);
    expect(res.json()).toMatchObject({ scope: "all", enqueue: { failed: 0 } });
    await queueIdle(app);
    expect(calls).toContain(slug);
    expect(new Set(calls).size).toBe(calls.length); // one run per tenant, none repeated
  });
});

describe("contract codegen, live: the per-tenant advisory lock on a real Postgres", () => {
  it("excludes a second holder for the SAME tenant, lets another tenant through, and frees on release", async () => {
    const db = new DbService(process.env.APP_DATABASE_URL!, 6);
    try {
      const lock = new PgContractCodegenLock(db);
      const slug = `p4rb-lock-${randomUUID().slice(0, 8)}`;
      const held = await lock.acquire(slug, 1000);
      await expect(lock.acquire(slug, 400)).rejects.toBeInstanceOf(ContractCodegenLockBusyError);
      const other = await lock.acquire(`${slug}-other`, 1000);
      await other.release();
      await held.release();
      const again = await lock.acquire(slug, 1000);
      await again.release();
    } finally {
      await db.onModuleDestroy();
    }
  });

  it("a waiter gets the lock as soon as the holder releases it", async () => {
    const db = new DbService(process.env.APP_DATABASE_URL!, 6);
    try {
      const lock = new PgContractCodegenLock(db);
      const slug = `p4rb-lock-wait-${randomUUID().slice(0, 8)}`;
      const held = await lock.acquire(slug, 1000);
      const waiter = lock.acquire(slug, 5000);
      setTimeout(() => void held.release(), 600);
      const got = await waiter;
      await got.release();
    } finally {
      await db.onModuleDestroy();
    }
  });
});
