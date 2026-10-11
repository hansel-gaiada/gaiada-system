// M3 T5a — the WSK-21 commands (keys, lifecycle, schema.apply, releases) on the WSK-41 command
// envelope: a HIGH command claims its WS4 approval in the SAME transaction as its effect (audit row
// first), and every command uses the durable idempotency store.
//
// Real Postgres (webdesk_app, NOBYPASSRLS), the real ControlModule, the NODE_ENV=test control-channel
// and policy stubs (the same harness as control-commands.spec.ts). The stub PDP has no "approval
// already used" pre-check, so a concurrent reuse of one approval reaches the service exactly as two
// racing requests would with the real PDP, which is what the claim-first guarantee is about.
//
// "The effect ran" is counted two ways: the rows the effect creates, and a statement recorder on the
// app's pool. The recorder matters for the losers of a race: on the old code each loser RAN the effect
// and only then failed on the audit insert; claim-first means it never issues the effect statement.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK21_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55490/webdesk";
process.env.API_KEY_PEPPER = "wsk21-test-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { LightMyRequestResponse } from "fastify";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { DbService } from "../src/db/db.service";
import { ApiKeysService } from "../src/api-keys/api-keys.service";
import { TenantLookupService } from "../src/tenants/tenant-lookup.service";
import { JobsService } from "../src/control/jobs/jobs.service";
import { PgIdempotencyStore } from "../src/control/idempotency/pg-idempotency-store";
import {
  RELEASE_TRANSPORT,
  type ReleaseTransportAdapter,
  type ReleaseTransportInput,
  type ReleaseTransportResult,
} from "../src/control/release/release-transport";

const MIGRATOR_URL =
  process.env.WSK21_MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk";
const PROBLEM = "https://webdesk.gaiada.online/errors/";
const COMPOSITION = { fields: [{ name: "title", primitive: "text" }] };

class FakeTransport implements ReleaseTransportAdapter {
  readonly calls: ReleaseTransportInput[] = [];
  async execute(input: ReleaseTransportInput): Promise<ReleaseTransportResult> {
    this.calls.push(input);
    return { ok: true, detail: `fake ${input.kind} ok` };
  }
}

// ------------------------------------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------------------------------------
async function boot(transport: ReleaseTransportAdapter): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule] })
    .overrideProvider(RELEASE_TRANSPORT)
    .useValue(transport)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  await app.init();
  return app;
}

/** Records the text of every statement issued on a client checked out of the app's pool. */
function recordStatements(app: NestFastifyApplication) {
  const seen: string[] = [];
  const wrapped = new WeakSet<object>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = app.get(DbService).pool as any;
  const connect = pool.connect.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool.connect = async (...args: any[]) => {
    if (typeof args[0] === "function") return connect(...args); // pg-pool's own callback form (pool.query)
    const client = await connect();
    if (!wrapped.has(client)) {
      wrapped.add(client);
      const query = client.query.bind(client);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.query = (...qa: any[]) => {
        const text = typeof qa[0] === "string" ? qa[0] : qa[0]?.text;
        if (text) seen.push(text);
        return query(...qa);
      };
    }
    return client;
  };
  return {
    reset: () => void (seen.length = 0),
    count: (re: RegExp) => seen.filter((t) => re.test(t)).length,
  };
}

function hdr(o: { scopes: string[]; ws4?: string; idem?: string }): Record<string, string> {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": "wsk-t5a-test",
    "x-webdesk-control-scopes": o.scopes.join(","),
  };
  if (o.ws4) h["x-webdesk-ws4-approval-id"] = o.ws4;
  if (o.idem) h["idempotency-key"] = o.idem;
  return h;
}

const post = (app: NestFastifyApplication, url: string, headers: Record<string, string>, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers, payload });

async function inDb<T>(setup: (c: Client) => Promise<void>, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: MIGRATOR_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await setup(c);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}
const inTenant = <T>(tenantId: string, fn: (c: Client) => Promise<T>) =>
  inDb(async (c) => void (await c.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId])), fn);
const inPlatform = <T>(fn: (c: Client) => Promise<T>) =>
  inDb(async (c) => void (await c.query("SET LOCAL webdesk.platform_ctx = 'true'")), fn);

interface Fx {
  slug: string;
  tenantId: string;
  siteId: string;
  envId: string;
}

/** A tenant with one site and one environment, provisioned through the commands under test. */
async function fixture(app: NestFastifyApplication): Promise<Fx> {
  const slug = `t5a-${randomUUID().slice(0, 8)}`;
  const operate = () => hdr({ scopes: ["webdesk:operate"], idem: randomUUID() });
  const t = await post(app, "/control/v1/tenants", operate(), { slug, companyRef: randomUUID() });
  expect(t.statusCode).toBe(201);
  const s = await post(app, `/control/v1/tenants/${slug}/sites`, operate(), { kind: "astro", name: "t5a-site" });
  expect(s.statusCode).toBe(201);
  const siteId = s.json().site.id as string;
  const e = await post(app, `/control/v1/tenants/${slug}/sites/${siteId}/environments`, operate(), { name: "staging" });
  expect(e.statusCode).toBe(201);
  return { slug, tenantId: t.json().tenant.id as string, siteId, envId: e.json().environment.id as string };
}

/** Makes `n` concurrent callers all finish their pre-envelope tenant lookup before any of them goes on. */
function holdLookups(app: NestFastifyApplication, n: number) {
  const lookups = app.get(TenantLookupService);
  const real = lookups.bySlug.bind(lookups);
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  return vi.spyOn(lookups, "bySlug").mockImplementation(async (slug: string) => {
    const tenant = await real(slug);
    if (++arrived === n) open();
    if (arrived <= n) await gate;
    return tenant;
  });
}

async function jobDone(app: NestFastifyApplication, slug: string, jobId: string) {
  const jobs = app.get(JobsService);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = jobs.get(slug, jobId);
    if (job.status === "succeeded" || job.status === "failed") return job;
    if (Date.now() > deadline) throw new Error("job did not finish");
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Res = LightMyRequestResponse;

function expectOneWinner(results: Res[], winStatus: number) {
  const won = results.filter((r) => r.statusCode === winStatus);
  const lost = results.filter((r) => r.statusCode !== winStatus);
  expect(results.map((r) => r.statusCode).sort()).toEqual([...Array(results.length - 1).fill(403), winStatus].sort());
  expect(won).toHaveLength(1);
  for (const r of lost) {
    expect(r.statusCode).toBe(403);
    expect(r.json().type).toBe(`${PROBLEM}ws4-approval-already-used`);
  }
  return won[0];
}

const withoutReplayed = (r: Res) => {
  const { replayed: _replayed, ...rest } = r.json();
  return rest;
};

const approvalActions = (tenantId: string | null, approval: string) => {
  const q = async (c: Client) =>
    (await c.query(`SELECT action FROM audit_entries WHERE ws4_approval_id = $1 ORDER BY action`, [approval])).rows.map((r) => r.action as string);
  return tenantId === null ? inPlatform(q) : inTenant(tenantId, q);
};

const idemRows = (tenantId: string, command: string) =>
  inTenant(tenantId, async (c) =>
    (await c.query(`SELECT status FROM control_idempotency_keys WHERE tenant_id = $1 AND command = $2`, [tenantId, command])).rows.map((r) => r.status as string),
  );

const keyCount = (fx: Fx) =>
  inTenant(fx.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM api_keys WHERE env_id = $1`, [fx.envId])).rows[0].n as number);

const mintUrl = (fx: Fx) => `/control/v1/tenants/${fx.slug}/keys`;
const promoteUrl = (fx: Fx) => `/control/v1/tenants/${fx.slug}/environments/${fx.envId}/promote`;
const applyUrl = (fx: Fx, key: string) => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/collections/${key}/schema/apply`;
const keys = (ws4: string, idem: string) => hdr({ scopes: ["webdesk:keys"], ws4, idem });
const promote = (ws4: string, idem: string) => hdr({ scopes: ["webdesk:promote"], ws4, idem });
const operate = (idem: string) => hdr({ scopes: ["webdesk:operate"], idem });

describe("M3 T5a — the WSK-21 commands on the command envelope", () => {
  let app: NestFastifyApplication;
  let transport: FakeTransport;
  let rec: ReturnType<typeof recordStatements>;

  beforeAll(async () => {
    transport = new FakeTransport();
    app = await boot(transport);
    rec = recordStatements(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // Concurrency: ONE approval, ten racers
  // ==============================================================================================
  describe("concurrent reuse of one WS4 approval (HIGH) runs the effect once", () => {
    it("key.mint (tenant scope): 10 parallel requests, one approval, different idempotency keys -> 1 key minted, 9 x 403 ws4-approval-already-used", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, () => post(app, mintUrl(fx), keys(approval, randomUUID()), { envId: fx.envId, scope: "read" })),
        );
      } finally {
        hold.mockRestore();
      }
      expectOneWinner(results, 201);
      expect(rec.count(/INSERT INTO api_keys/)).toBe(1); // the losers never ran the effect
      expect(await keyCount(fx)).toBe(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.key.mint"]);
      expect(await idemRows(fx.tenantId, "key.mint")).toEqual(["completed"]); // the nine losing claims were released
    });

    it("tenant.archive (platform scope): 10 parallel requests, one approval -> 1 UPDATE, 9 x 403 ws4-approval-already-used", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, () => post(app, `/control/v1/tenants/${fx.slug}/archive`, promote(approval, randomUUID()))),
        );
      } finally {
        hold.mockRestore();
      }
      const winner = expectOneWinner(results, 201);
      expect(winner.json()).toMatchObject({ tenant: { slug: fx.slug, status: "archived" }, replayed: false });
      expect(rec.count(/UPDATE tenants SET status = 'archived'/)).toBe(1);
      expect(await approvalActions(null, approval)).toEqual(["control.tenant.archive"]);
    });

    it("environment.archive (tenant scope): 10 parallel requests, one approval -> 1 UPDATE, 9 x 403", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, () => post(app, `/control/v1/tenants/${fx.slug}/environments/${fx.envId}/archive`, promote(approval, randomUUID()))),
        );
      } finally {
        hold.mockRestore();
      }
      expectOneWinner(results, 201);
      expect(rec.count(/UPDATE environments SET status = 'archived'/)).toBe(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.environment.archive"]);
    });

    it("release.promote (HIGH, jobTracked): 10 parallel requests, one approval -> 1 job, 1 transport call, 1 releases row, 9 x 403", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const hold = holdLookups(app, 10);
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, () => post(app, promoteUrl(fx), promote(approval, randomUUID()), { version: "7.0.0" })),
        );
      } finally {
        hold.mockRestore();
      }
      const winner = expectOneWinner(results, 201);
      const job = await jobDone(app, fx.slug, winner.json().jobId);
      expect(job.status).toBe("succeeded");
      expect(app.get(JobsService).list(fx.slug)).toHaveLength(1);
      expect(transport.calls.filter((c) => c.envId === fx.envId)).toHaveLength(1);
      const releases = await inTenant(fx.tenantId, async (c) => (await c.query(`SELECT count(*)::int AS n FROM releases WHERE env_id = $1`, [fx.envId])).rows[0].n);
      expect(releases).toBe(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.release.promote"]);
    });

    it("key.rotate and key.revoke: 10 parallel requests each, one approval each -> one effect each", async () => {
      const fx = await fixture(app);
      const minted = await post(app, mintUrl(fx), keys(randomUUID(), randomUUID()), { envId: fx.envId, scope: "read" });
      const apiKeyId = minted.json().id as string;

      const rotateApproval = randomUUID();
      rec.reset();
      const rotated = await Promise.all(
        Array.from({ length: 10 }, () => post(app, `${mintUrl(fx)}/${apiKeyId}/rotate`, keys(rotateApproval, randomUUID()))),
      );
      expectOneWinner(rotated, 201);
      expect(rec.count(/UPDATE api_keys SET key_hash/)).toBe(1);
      expect(await approvalActions(fx.tenantId, rotateApproval)).toEqual(["control.key.rotate"]);

      const revokeApproval = randomUUID();
      rec.reset();
      const revoked = await Promise.all(
        Array.from({ length: 10 }, () => post(app, `${mintUrl(fx)}/${apiKeyId}/revoke`, keys(revokeApproval, randomUUID()))),
      );
      expectOneWinner(revoked, 201);
      expect(rec.count(/UPDATE api_keys SET revoked_at/)).toBe(1);
      expect(await approvalActions(fx.tenantId, revokeApproval)).toEqual(["control.key.revoke"]);
    });
  });

  describe("concurrent requests with one idempotency key (MEDIUM) run the effect once", () => {
    it("schema.apply: 10 parallel requests, one key, one body -> 1 upsert, 1 fresh response and 9 replays, same collection", async () => {
      const fx = await fixture(app);
      const idem = randomUUID();
      rec.reset();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => post(app, applyUrl(fx, "t5a-conc"), operate(idem), { schema: COMPOSITION })),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array(10).fill(201));
      expect(results.filter((r) => r.json().replayed === false)).toHaveLength(1);
      expect(results.filter((r) => r.json().replayed === true)).toHaveLength(9);
      expect(new Set(results.map((r) => r.json().collection.id)).size).toBe(1);
      expect(rec.count(/INSERT INTO collections/)).toBe(1);
      const actions = await inTenant(fx.tenantId, async (c) =>
        (await c.query(`SELECT action, count(*)::int AS n FROM audit_entries WHERE action LIKE 'control.schema.apply%' GROUP BY action`)).rows,
      );
      expect(Object.fromEntries(actions.map((r) => [r.action, r.n]))).toEqual({ "control.schema.apply": 1, "control.schema.apply.replay": 9 });
    });
  });

  // ==============================================================================================
  // Replay
  // ==============================================================================================
  describe("replay: same key + same body -> same body with replayed:true, no second effect, one .replay audit row (mint and rotate: 409 withheld instead)", () => {
    it("key.mint: the plaintext key is never stored, so a replay is 409 idempotency-response-withheld with no second key and no audit row", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      rec.reset();
      const first = await post(app, mintUrl(fx), keys(approval, idem), { envId: fx.envId, scope: "read" });
      const second = await post(app, mintUrl(fx), keys(approval, idem), { envId: fx.envId, scope: "read" });
      expect(first.statusCode).toBe(201);
      expect(first.json().replayed).toBe(false);
      expect(first.json().key).toMatch(/^wdsk_/);
      expect(second.statusCode).toBe(409);
      expect(second.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
      expect(JSON.stringify(second.json())).not.toContain(first.json().key);
      expect(rec.count(/INSERT INTO api_keys/)).toBe(1);
      expect(await keyCount(fx)).toBe(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.key.mint"]); // no .replay row
    });

    it("key.rotate (409 withheld) and key.revoke (a real replay)", async () => {
      const fx = await fixture(app);
      const minted = await post(app, mintUrl(fx), keys(randomUUID(), randomUUID()), { envId: fx.envId, scope: "read" });
      const apiKeyId = minted.json().id as string;

      const rotateApproval = randomUUID();
      const rotateIdem = randomUUID();
      rec.reset();
      const r1 = await post(app, `${mintUrl(fx)}/${apiKeyId}/rotate`, keys(rotateApproval, rotateIdem));
      const r2 = await post(app, `${mintUrl(fx)}/${apiKeyId}/rotate`, keys(rotateApproval, rotateIdem));
      expect(r1.statusCode).toBe(201);
      expect(r1.json().replayed).toBe(false);
      expect(r1.json().key).not.toBe(minted.json().key);
      expect(r2.statusCode).toBe(409);
      expect(r2.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
      expect(JSON.stringify(r2.json())).not.toContain(r1.json().key);
      expect(rec.count(/UPDATE api_keys SET key_hash/)).toBe(1);
      expect(await approvalActions(fx.tenantId, rotateApproval)).toEqual(["control.key.rotate"]);

      const revokeApproval = randomUUID();
      const revokeIdem = randomUUID();
      rec.reset();
      const v1 = await post(app, `${mintUrl(fx)}/${apiKeyId}/revoke`, keys(revokeApproval, revokeIdem));
      const v2 = await post(app, `${mintUrl(fx)}/${apiKeyId}/revoke`, keys(revokeApproval, revokeIdem));
      expect([v1.statusCode, v2.statusCode]).toEqual([201, 201]);
      expect(withoutReplayed(v2)).toEqual(withoutReplayed(v1));
      expect(v2.json().replayed).toBe(true);
      expect(rec.count(/UPDATE api_keys SET revoked_at/)).toBe(1);
      expect(await approvalActions(fx.tenantId, revokeApproval)).toEqual(["control.key.revoke", "control.key.revoke.replay"]);
    });

    it("release.promote (the replay returns the same jobId and starts no second job)", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const first = await post(app, promoteUrl(fx), promote(approval, idem), { version: "8.0.0" });
      const second = await post(app, promoteUrl(fx), promote(approval, idem), { version: "8.0.0" });
      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      expect(second.json()).toEqual({ jobId: first.json().jobId, replayed: true });
      await jobDone(app, fx.slug, first.json().jobId);
      expect(app.get(JobsService).list(fx.slug)).toHaveLength(1);
      expect(transport.calls.filter((c) => c.envId === fx.envId)).toHaveLength(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.release.promote", "control.release.promote.replay"]);
    });

    it("schema.apply and tenant.provision (platform scope)", async () => {
      const fx = await fixture(app);
      const idem = randomUUID();
      rec.reset();
      const a1 = await post(app, applyUrl(fx, "t5a-replay"), operate(idem), { schema: COMPOSITION });
      const a2 = await post(app, applyUrl(fx, "t5a-replay"), operate(idem), { schema: COMPOSITION });
      expect([a1.json().replayed, a2.json().replayed]).toEqual([false, true]);
      expect(withoutReplayed(a2)).toEqual(withoutReplayed(a1));
      expect(rec.count(/INSERT INTO collections/)).toBe(1);
      const applyActions = await inTenant(fx.tenantId, async (c) =>
        (await c.query(`SELECT action FROM audit_entries WHERE action LIKE 'control.schema.apply%' ORDER BY action`)).rows.map((r) => r.action),
      );
      expect(applyActions).toEqual(["control.schema.apply", "control.schema.apply.replay"]);

      const slug = `t5a-${randomUUID().slice(0, 8)}`;
      const body = { slug, companyRef: randomUUID() };
      const provisionIdem = randomUUID();
      rec.reset();
      const p1 = await post(app, "/control/v1/tenants", operate(provisionIdem), body);
      const p2 = await post(app, "/control/v1/tenants", operate(provisionIdem), body);
      expect([p1.json().replayed, p2.json().replayed]).toEqual([false, true]);
      expect(withoutReplayed(p2)).toEqual(withoutReplayed(p1));
      expect(rec.count(/INSERT INTO tenants/)).toBe(1);
    });

    // M3 T8 — the archives used to resolve an ACTIVE tenant before the envelope, so once the tenant was
    // archived, a retry of the same archive (same key, response lost) got 404 instead of the stored answer.
    it("tenant.archive: a retry of the SAME key after the archive replays the stored body; a FRESH key on the archived tenant is still 404", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      rec.reset();
      const first = await post(app, `/control/v1/tenants/${fx.slug}/archive`, promote(approval, idem));
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ tenant: { slug: fx.slug, status: "archived" }, replayed: false });

      const replay = await post(app, `/control/v1/tenants/${fx.slug}/archive`, promote(approval, idem));
      expect(replay.statusCode).toBe(201); // the status the command answers with on a replay too (key.revoke, release.promote)
      expect(replay.json().replayed).toBe(true);
      expect(withoutReplayed(replay)).toEqual(withoutReplayed(first));
      expect(rec.count(/UPDATE tenants SET status = 'archived'/)).toBe(1); // no second effect
      expect(await approvalActions(null, approval)).toEqual(["control.tenant.archive", "control.tenant.archive.replay"]);

      // A new key (and a new approval) on the now-archived tenant is a fresh run: refused exactly as before.
      const approval2 = randomUUID();
      const idem2 = randomUUID();
      rec.reset();
      const fresh = await post(app, `/control/v1/tenants/${fx.slug}/archive`, promote(approval2, idem2));
      expect(fresh.statusCode).toBe(404);
      expect(fresh.json().message).toBe("tenant not found");
      expect(await approvalActions(null, approval2)).toEqual([]); // rolled back: the approval is still free
      const scopeKey = `platform:tenant.archive:${idem2}`;
      expect(await inPlatform(async (c) => (await c.query(`SELECT 1 FROM control_idempotency_keys WHERE scope_key = $1`, [scopeKey])).rows)).toEqual([]); // the refused key is released
    });

    it("environment.archive: a retry of the same key replays even after the TENANT was archived; a fresh key on the archived tenant is 404", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const url = `/control/v1/tenants/${fx.slug}/environments/${fx.envId}/archive`;
      const first = await post(app, url, promote(approval, idem));
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ environment: { id: fx.envId, status: "archived" }, replayed: false });

      const archived = await post(app, `/control/v1/tenants/${fx.slug}/archive`, promote(randomUUID(), randomUUID()));
      expect(archived.statusCode).toBe(201);

      rec.reset();
      const replay = await post(app, url, promote(approval, idem));
      expect(replay.statusCode).toBe(201);
      expect(replay.json().replayed).toBe(true);
      expect(withoutReplayed(replay)).toEqual(withoutReplayed(first));
      expect(rec.count(/UPDATE environments SET status = 'archived'/)).toBe(0);

      const approval2 = randomUUID();
      const fresh = await post(app, url, promote(approval2, randomUUID()));
      expect(fresh.statusCode).toBe(404);
      expect(await approvalActions(fx.tenantId, approval2)).toEqual([]);
    });
  });

  // ==============================================================================================
  // Durability: the replay record is in the database, not in process memory
  // ==============================================================================================
  it("a replay still works after the app is stopped and a fresh app is started on the same database", async () => {
    const appA = await boot(transport);
    const fx = await fixture(appA);
    const mintApproval = randomUUID();
    const mintIdem = randomUUID();
    const promoteApproval = randomUUID();
    const promoteIdem = randomUUID();
    const applyIdem = randomUUID();
    const provisionIdem = randomUUID();
    const newSlug = `t5a-${randomUUID().slice(0, 8)}`;
    const provisionBody = { slug: newSlug, companyRef: randomUUID() };

    const mint1 = await post(appA, mintUrl(fx), keys(mintApproval, mintIdem), { envId: fx.envId, scope: "read" });
    const promote1 = await post(appA, promoteUrl(fx), promote(promoteApproval, promoteIdem), { version: "9.0.0" });
    const apply1 = await post(appA, applyUrl(fx, "t5a-durable"), operate(applyIdem), { schema: COMPOSITION });
    const provision1 = await post(appA, "/control/v1/tenants", operate(provisionIdem), provisionBody);
    for (const r of [mint1, promote1, apply1, provision1]) expect(r.statusCode).toBe(201);
    await jobDone(appA, fx.slug, promote1.json().jobId);
    await appA.close(); // the first process is gone

    const appB = await boot(transport);
    try {
      const recB = recordStatements(appB);
      const mint2 = await post(appB, mintUrl(fx), keys(mintApproval, mintIdem), { envId: fx.envId, scope: "read" });
      const promote2 = await post(appB, promoteUrl(fx), promote(promoteApproval, promoteIdem), { version: "9.0.0" });
      const apply2 = await post(appB, applyUrl(fx, "t5a-durable"), operate(applyIdem), { schema: COMPOSITION });
      const provision2 = await post(appB, "/control/v1/tenants", operate(provisionIdem), provisionBody);
      expect(mint2.statusCode).toBe(409); // the key was never stored: nothing to replay, in any process
      expect(mint2.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
      for (const [again, first] of [
        [promote2, promote1],
        [apply2, apply1],
        [provision2, provision1],
      ] as const) {
        expect(again.statusCode).toBe(201);
        expect(again.json().replayed).toBe(true);
        expect(withoutReplayed(again)).toEqual(withoutReplayed(first));
      }
      expect(recB.count(/INSERT INTO api_keys/)).toBe(0);
      expect(recB.count(/INSERT INTO collections/)).toBe(0);
      expect(recB.count(/INSERT INTO tenants/)).toBe(0);
      expect(appB.get(JobsService).list(fx.slug)).toHaveLength(0); // no second job in the new process
      expect(await keyCount(fx)).toBe(1);
    } finally {
      await appB.close();
    }
  });

  // ==============================================================================================
  // Failure after the audit insert: nothing commits, the claim is released, a retry succeeds
  // ==============================================================================================
  describe("a failure after the audit row rolls everything back and frees the key and the approval", () => {
    it("key.mint: the effect throws -> no audit row, no key, no idempotency row; the retry with the same approval and key succeeds", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const failing = vi.spyOn(app.get(ApiKeysService), "mintInTx").mockRejectedValueOnce(new Error("injected failure after the audit row"));
      rec.reset();
      let bad: Res;
      try {
        bad = await post(app, mintUrl(fx), keys(approval, idem), { envId: fx.envId, scope: "read" });
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      expect(rec.count(/INSERT INTO audit_entries/)).toBe(1); // the audit row WAS written first ...
      expect(await approvalActions(fx.tenantId, approval)).toEqual([]); // ... and rolled back
      expect(await keyCount(fx)).toBe(0);
      expect(await idemRows(fx.tenantId, "key.mint")).toEqual([]);

      const retry = await post(app, mintUrl(fx), keys(approval, idem), { envId: fx.envId, scope: "read" });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().replayed).toBe(false);
      expect(await keyCount(fx)).toBe(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.key.mint"]);
    });

    it("key.mint: the effect REFUSES (unknown environment) -> same, and the approval is not burned", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const bad = await post(app, mintUrl(fx), keys(approval, idem), { envId: randomUUID(), scope: "read" });
      expect(bad.statusCode).toBe(404);
      expect(await approvalActions(fx.tenantId, approval)).toEqual([]);
      expect(await idemRows(fx.tenantId, "key.mint")).toEqual([]);
      const good = await post(app, mintUrl(fx), keys(approval, idem), { envId: fx.envId, scope: "read" });
      expect(good.statusCode).toBe(201);
    });

    it("tenant.archive (platform scope): the idempotency write fails -> the tenant is still active, the approval is free", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const failing = vi.spyOn(app.get(PgIdempotencyStore), "complete").mockRejectedValueOnce(new Error("injected failure after the effect"));
      let bad: Res;
      try {
        bad = await post(app, `/control/v1/tenants/${fx.slug}/archive`, promote(approval, idem));
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      expect(await approvalActions(null, approval)).toEqual([]);
      const status = () => inPlatform(async (c) => (await c.query(`SELECT status FROM tenants WHERE id = $1`, [fx.tenantId])).rows[0].status as string);
      expect(await status()).toBe("active");
      const scopeKey = `platform:tenant.archive:${idem}`;
      expect(await inPlatform(async (c) => (await c.query(`SELECT 1 FROM control_idempotency_keys WHERE scope_key = $1`, [scopeKey])).rows)).toEqual([]);

      const retry = await post(app, `/control/v1/tenants/${fx.slug}/archive`, promote(approval, idem));
      expect(retry.statusCode).toBe(201);
      expect(await status()).toBe("archived");
    });

    it("release.promote: the idempotency write fails -> no job is started, no transport call, the approval is free", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const failing = vi.spyOn(app.get(PgIdempotencyStore), "complete").mockRejectedValueOnce(new Error("injected failure after the audit row"));
      let bad: Res;
      try {
        bad = await post(app, promoteUrl(fx), promote(approval, idem), { version: "10.0.0" });
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      expect(await approvalActions(fx.tenantId, approval)).toEqual([]);
      expect(await idemRows(fx.tenantId, "release.promote")).toEqual([]);
      expect(app.get(JobsService).list(fx.slug)).toHaveLength(0);
      expect(transport.calls.filter((c) => c.envId === fx.envId)).toHaveLength(0);

      const retry = await post(app, promoteUrl(fx), promote(approval, idem), { version: "10.0.0" });
      expect(retry.statusCode).toBe(201);
      await jobDone(app, fx.slug, retry.json().jobId);
      expect(app.get(JobsService).list(fx.slug)).toHaveLength(1);
    });

    it("schema.apply (MEDIUM): the idempotency write fails -> no collection, no audit row, claim released; the retry with the same key succeeds", async () => {
      const fx = await fixture(app);
      const idem = randomUUID();
      const failing = vi.spyOn(app.get(PgIdempotencyStore), "complete").mockRejectedValueOnce(new Error("injected failure after the effect"));
      let bad: Res;
      try {
        bad = await post(app, applyUrl(fx, "t5a-fail"), operate(idem), { schema: COMPOSITION });
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      const state = () =>
        inTenant(fx.tenantId, async (c) => ({
          collections: (await c.query(`SELECT count(*)::int AS n FROM collections WHERE site_id = $1`, [fx.siteId])).rows[0].n as number,
          audits: (await c.query(`SELECT count(*)::int AS n FROM audit_entries WHERE action LIKE 'control.schema.apply%'`)).rows[0].n as number,
        }));
      expect(await state()).toEqual({ collections: 0, audits: 0 });
      expect(await idemRows(fx.tenantId, "schema.apply")).toEqual([]);

      const retry = await post(app, applyUrl(fx, "t5a-fail"), operate(idem), { schema: COMPOSITION });
      expect(retry.statusCode).toBe(201);
      expect(retry.json().replayed).toBe(false);
      expect(await state()).toEqual({ collections: 1, audits: 1 });
    });
  });

  // ==============================================================================================
  // Refusals before the envelope claim nothing and audit nothing
  // ==============================================================================================
  it("pre-envelope refusals (validation, unknown tenant or environment, reserved key, bad composition, no WS4) write no audit row and claim no idempotency key", async () => {
    const fx = await fixture(app);
    const ghost = `t5a-ghost-${randomUUID().slice(0, 6)}`;
    const cases: { name: string; status: number; send: () => Promise<Res> }[] = [
      { name: "key.mint unknown tenant", status: 404, send: () => post(app, `/control/v1/tenants/${ghost}/keys`, keys(randomUUID(), randomUUID()), { envId: fx.envId, scope: "read" }) },
      { name: "key.mint bad envId", status: 400, send: () => post(app, mintUrl(fx), keys(randomUUID(), randomUUID()), { envId: "nope", scope: "read" }) },
      { name: "key.mint no WS4 approval", status: 403, send: () => post(app, mintUrl(fx), hdr({ scopes: ["webdesk:keys"], idem: randomUUID() }), { envId: fx.envId, scope: "read" }) },
      { name: "key.revoke bad apiKeyId", status: 400, send: () => post(app, `${mintUrl(fx)}/nope/revoke`, keys(randomUUID(), randomUUID())) },
      { name: "tenant.provision bad slug", status: 400, send: () => post(app, "/control/v1/tenants", operate(randomUUID()), { slug: "Not A Slug", companyRef: randomUUID() }) },
      { name: "tenant.archive unknown tenant", status: 404, send: () => post(app, `/control/v1/tenants/${ghost}/archive`, promote(randomUUID(), randomUUID())) },
      { name: "site.provision unknown tenant", status: 404, send: () => post(app, `/control/v1/tenants/${ghost}/sites`, operate(randomUUID()), { kind: "astro", name: "x" }) },
      { name: "environment.provision bad name", status: 400, send: () => post(app, `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/environments`, operate(randomUUID()), { name: "qa" }) },
      { name: "environment.archive no WS4 approval", status: 403, send: () => post(app, `/control/v1/tenants/${fx.slug}/environments/${fx.envId}/archive`, hdr({ scopes: ["webdesk:promote"], idem: randomUUID() })) },
      { name: "schema.apply unknown tenant", status: 404, send: () => post(app, applyUrl({ ...fx, slug: ghost }, "t5a-x"), operate(randomUUID()), { schema: COMPOSITION }) },
      { name: "schema.apply reserved key", status: 422, send: () => post(app, applyUrl(fx, "media"), operate(randomUUID()), { schema: COMPOSITION }) },
      { name: "schema.apply invalid composition", status: 422, send: () => post(app, applyUrl(fx, "t5a-bad"), operate(randomUUID()), { schema: { fields: [{ name: "x", primitive: "no-such-primitive" }] } }) },
      { name: "release.promote unknown environment", status: 404, send: () => post(app, `/control/v1/tenants/${fx.slug}/environments/${randomUUID()}/promote`, promote(randomUUID(), randomUUID()), { version: "1" }) },
      { name: "release.deploy no Idempotency-Key", status: 400, send: () => post(app, `/control/v1/tenants/${fx.slug}/environments/${fx.envId}/deploy`, hdr({ scopes: ["webdesk:operate"] }), { version: "1" }) },
    ];
    for (const c of cases) {
      rec.reset();
      const res = await c.send();
      expect(res.statusCode, c.name).toBe(c.status);
      expect(rec.count(/INSERT INTO audit_entries/), `${c.name}: audit rows`).toBe(0);
      expect(rec.count(/INSERT INTO control_idempotency_keys/), `${c.name}: idempotency claims`).toBe(0);
    }
  });

  // ==============================================================================================
  // The public contract: response bodies are unchanged; the stored key is withheld
  // ==============================================================================================
  it("response bodies keep their exact shape (the ERP parses key.mint at approval time)", async () => {
    const fx = await fixture(app);
    const mint = await post(app, mintUrl(fx), keys(randomUUID(), randomUUID()), { envId: fx.envId, scope: "write" });
    expect(mint.statusCode).toBe(201);
    expect(Object.keys(mint.json())).toEqual(["id", "key", "scope", "envId", "tenantId", "createdAt", "replayed"]);
    expect(mint.json()).toMatchObject({ scope: "write", envId: fx.envId, tenantId: fx.tenantId, replayed: false });
    expect(mint.json().key).toMatch(/^wdsk_/);

    const apply = await post(app, applyUrl(fx, "t5a-shape"), operate(randomUUID()), { schema: COMPOSITION });
    expect(Object.keys(apply.json())).toEqual(["collection", "bump", "reasons", "replayed"]);
    expect(Object.keys(apply.json().collection)).toEqual(["id", "key", "schema", "updated_at"]);

    const rel = await post(app, `/control/v1/tenants/${fx.slug}/environments/${fx.envId}/deploy`, operate(randomUUID()), { version: "1" });
    expect(Object.keys(rel.json())).toEqual(["jobId", "replayed"]);

    const arch = await post(app, `/control/v1/tenants/${fx.slug}/environments/${fx.envId}/archive`, promote(randomUUID(), randomUUID()));
    expect(Object.keys(arch.json())).toEqual(["environment", "replayed"]);
    expect(Object.keys(arch.json().environment)).toEqual(["id", "name", "status"]);
  });

  it("the plaintext api key never reaches control_idempotency_keys: mint and rotate store a redacted record with the withheld marker", async () => {
    const fx = await fixture(app);
    const mint = await post(app, mintUrl(fx), keys(randomUUID(), randomUUID()), { envId: fx.envId, scope: "read" });
    const plaintext = mint.json().key as string;
    const rotate = await post(app, `${mintUrl(fx)}/${mint.json().id}/rotate`, keys(randomUUID(), randomUUID()));
    const rotated = rotate.json().key as string;

    const stored = await inTenant(fx.tenantId, async (c) =>
      (await c.query(`SELECT command, response::text AS body FROM control_idempotency_keys WHERE command IN ('key.mint', 'key.rotate') ORDER BY command`)).rows,
    );
    expect(stored.map((r) => r.command)).toEqual(["key.mint", "key.rotate"]);
    for (const { body } of stored) {
      expect(body).not.toContain(plaintext);
      expect(body).not.toContain(rotated);
      expect(body).not.toContain(plaintext.slice(5)); // not even the random part
      expect(body).not.toContain(rotated.slice(5));
      expect(Object.keys(JSON.parse(body)).sort()).toEqual(["createdAt", "envId", "id", "scope", "secretWithheld", "tenantId"]); // no `key`, no ciphertext (jsonb reorders keys)
      expect(JSON.parse(body).secretWithheld).toBe(true);
    }
  });
});
