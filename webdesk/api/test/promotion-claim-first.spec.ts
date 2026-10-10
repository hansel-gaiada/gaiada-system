// M3 T5b — content.promote and content.rollback (HIGH) claim their WS4 approval BEFORE any side
// effect, on the durable idempotency store.
//
// Promotion is a saga (run row -> snapshot -> import -> status updates), not one transaction: the
// snapshot MUST commit in its own transaction before the import begins (WSK-25 snapshot-first). So the
// claim is the FIRST transaction: the audit row that claims the approval, the promotion_runs insert,
// and the idempotency record (a run REFERENCE). A concurrent reuse of the approval fails at that
// first statement, before any snapshot or import. See promotion-command.service.ts's header.
//
// Real Postgres (webdesk_app, NOBYPASSRLS), the real ControlModule + PromotionModule, the
// NODE_ENV=test control-channel and policy stubs. The stub PDP has no "approval already used"
// pre-check, so a concurrent reuse reaches the service exactly as two racing requests would with the
// real PDP, which is what claim-first is about.
//
// "The effect ran" is counted three ways: the rows (promotion_runs, promotion_snapshots), the calls to
// ContentBundleService.applyBundle (the import), and a statement recorder on the app's pool.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK25_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55495/webdesk";
process.env.API_KEY_PEPPER = "wsk25-t5b-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import type { LightMyRequestResponse } from "fastify";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { PromotionModule } from "../src/promotion/promotion.module";
import { DbService } from "../src/db/db.service";
import { TenantLookupService } from "../src/tenants/tenant-lookup.service";
import { ContentBundleService } from "../src/promotion/content-bundle.service";
import { PromotionSnapshotService } from "../src/promotion/promotion-snapshot.service";

const MIGRATOR_URL =
  process.env.WSK25_MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55495/webdesk";
const PROBLEM = "https://webdesk.gaiada.online/errors/";
const PRINCIPAL = "wsk-t5b-promotion-test";

type Res = LightMyRequestResponse;

// ------------------------------------------------------------------------------------------------
// Harness
// ------------------------------------------------------------------------------------------------
async function boot(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule, PromotionModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
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
    if (typeof args[0] === "function") return connect(...args);
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

function hdr(o: { scopes: string[]; ws4?: string; idem?: string; automation?: boolean }): Record<string, string> {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": PRINCIPAL,
    "x-webdesk-control-scopes": o.scopes.join(","),
  };
  if (o.ws4) h["x-webdesk-ws4-approval-id"] = o.ws4;
  if (o.idem) h["idempotency-key"] = o.idem;
  if (o.automation) h["x-webdesk-control-automation"] = "true";
  return h;
}
const operate = () => hdr({ scopes: ["webdesk:operate"], idem: randomUUID() });
const promoteH = (ws4: string, idem: string) => hdr({ scopes: ["webdesk:promote"], ws4, idem });

const post = (app: NestFastifyApplication, url: string, headers: Record<string, string>, payload?: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers, payload });

async function inTenant<T>(tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: MIGRATOR_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
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
const rows = <R = Record<string, unknown>>(tenantId: string, sql: string, params: unknown[] = []) =>
  inTenant(tenantId, async (c) => (await c.query(sql, params)).rows as R[]);

interface Fx {
  slug: string;
  tenantId: string;
  siteId: string;
  envId: string;
}

/** A tenant with one site, one environment and one seeded item, provisioned through the control plane. */
async function fixture(app: NestFastifyApplication): Promise<Fx> {
  const slug = `t5b-${randomUUID().slice(0, 8)}`;
  const t = await post(app, "/control/v1/tenants", operate(), { slug, companyRef: randomUUID() });
  expect(t.statusCode).toBe(201);
  const tenantId = t.json().tenant.id as string;
  const s = await post(app, `/control/v1/tenants/${slug}/sites`, operate(), { kind: "astro", name: "t5b-site" });
  const siteId = s.json().site.id as string;
  const e = await post(app, `/control/v1/tenants/${slug}/sites/${siteId}/environments`, operate(), { name: "production" });
  expect(e.statusCode).toBe(201);
  const envId = e.json().environment.id as string;
  await inTenant(tenantId, async (c) => {
    const col = await c.query(
      `INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES (gen_random_uuid(), $1, $2, 'page', '{}'::jsonb) RETURNING id`,
      [tenantId, siteId],
    );
    await c.query(
      `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'en-US', 'home', '[]'::jsonb, '{"title":"Original"}'::jsonb, 'published')`,
      [tenantId, siteId, col.rows[0].id],
    );
  });
  return { slug, tenantId, siteId, envId };
}

/** A stable uuid per label: the same label is the same bundle (the request hash covers the bundle). */
const stableUuid = (label: string) => {
  const h = createHash("sha1").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/**
 * A bundle that changes the seeded item and adds one: the import appends real content_versions.
 * Deterministic per `title` except `exportedAt`, which is informational and deliberately differs per
 * call (a replay must match even so).
 */
function bundleFor(title: string) {
  return {
    siteId: "informational-only",
    exportedAt: new Date().toISOString(),
    collections: [{ key: "page", schema: {} }],
    contentItems: [
      {
        collectionKey: "page",
        locale: "en-US",
        slug: `added-${title}`,
        localizationGroupId: stableUuid(title),
        blocks: [],
        seo: { title },
        publishState: "published",
        publishAt: null,
        unpublishAt: null,
        previewToken: null,
        searchText: null,
      },
    ],
    mediaAssets: [],
  };
}

const promoteUrl = (fx: Fx) => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/environments/${fx.envId}/content-promote`;
const rollbackUrl = (fx: Fx) => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/environments/${fx.envId}/content-rollback`;

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

function expectOneWinner(results: Res[], winStatus: number) {
  expect(results.map((r) => r.statusCode).sort()).toEqual([...Array(results.length - 1).fill(403), winStatus].sort());
  const won = results.filter((r) => r.statusCode === winStatus);
  for (const r of results.filter((x) => x.statusCode !== winStatus)) {
    expect(r.json().type).toBe(`${PROBLEM}ws4-approval-already-used`);
  }
  return won[0];
}

/** The body minus the `replayed` flag, as TEXT: a replay must be the original's bytes. */
const bodyText = (r: Res) => r.body.replace(/,"replayed":(true|false)\}$/, "}");

const approvalActions = (tenantId: string, approval: string) =>
  rows<{ action: string }>(tenantId, `SELECT action FROM audit_entries WHERE ws4_approval_id = $1 ORDER BY action`, [approval]).then((r) => r.map((x) => x.action));

const runCount = (fx: Fx, kind: "promote" | "rollback") =>
  rows<{ n: number }>(fx.tenantId, `SELECT count(*)::int AS n FROM promotion_runs WHERE target_env_id = $1 AND kind = $2`, [fx.envId, kind]).then((r) => r[0].n);
const snapshotCount = (fx: Fx) =>
  rows<{ n: number }>(fx.tenantId, `SELECT count(*)::int AS n FROM promotion_snapshots WHERE env_id = $1`, [fx.envId]).then((r) => r[0].n);
const liveSlugs = (fx: Fx) =>
  rows<{ slug: string }>(fx.tenantId, `SELECT slug FROM content_items WHERE site_id = $1 AND deleted_at IS NULL ORDER BY slug`, [fx.siteId]).then((r) => r.map((x) => x.slug));
const idemRows = (fx: Fx, command: string) =>
  rows<{ status: string; response: Record<string, unknown> }>(
    fx.tenantId,
    `SELECT status, response FROM control_idempotency_keys WHERE tenant_id = $1 AND command = $2`,
    [fx.tenantId, command],
  );

describe("M3 T5b — content.promote / content.rollback claim the WS4 approval first", () => {
  let app: NestFastifyApplication;
  let rec: ReturnType<typeof recordStatements>;

  beforeAll(async () => {
    app = await boot();
    rec = recordStatements(app);
  });
  afterAll(async () => {
    await app?.close();
  });
  // A test that times out never reaches its own `finally`: put the world back so one red test cannot
  // park every later one (the in-progress test parks a saga on purpose).
  const parked: Array<() => void> = [];
  afterEach(() => {
    for (const release of parked.splice(0)) release();
    vi.restoreAllMocks();
  });

  // ==============================================================================================
  // Concurrency: ONE approval, ten racers
  // ==============================================================================================
  describe("concurrent reuse of one WS4 approval runs the whole saga once", () => {
    it("content.promote: 10 parallel requests, one approval, different idempotency keys -> 1 run, 1 snapshot, 1 import, 9 x 403 ws4-approval-already-used", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const applySpy = vi.spyOn(app.get(ContentBundleService), "applyBundle");
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(
          Array.from({ length: 10 }, (_, i) => post(app, promoteUrl(fx), promoteH(approval, randomUUID()), { version: `race-${i}`, bundle: bundleFor(`race-${i}`) })),
        );
      } finally {
        hold.mockRestore();
      }
      const calls = applySpy.mock.calls.length;
      applySpy.mockRestore();
      expectOneWinner(results, 201);
      expect(calls).toBe(1); // exactly one import
      expect(rec.count(/INSERT INTO promotion_snapshots/)).toBe(1); // the losers never snapshotted
      expect(rec.count(/INSERT INTO promotion_runs/)).toBe(1);
      expect(await runCount(fx, "promote")).toBe(1);
      expect(await snapshotCount(fx)).toBe(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.content.promote"]);
      expect((await idemRows(fx, "content.promote")).map((r) => r.status)).toEqual(["completed"]); // the nine losing claims were released
      expect(await liveSlugs(fx)).toHaveLength(2); // the seeded item and exactly one added item
    });

    it("content.rollback: 10 parallel requests, one approval -> 1 run, 1 restore import, no new snapshot, 9 x 403", async () => {
      const fx = await fixture(app);
      const first = await post(app, promoteUrl(fx), promoteH(randomUUID(), randomUUID()), { version: "before-rollback", bundle: bundleFor("added") });
      expect(first.statusCode).toBe(201);
      expect(await liveSlugs(fx)).toEqual(["added-added", "home"]);

      const approval = randomUUID();
      const applySpy = vi.spyOn(app.get(ContentBundleService), "applyBundle");
      const hold = holdLookups(app, 10);
      rec.reset();
      let results: Res[];
      try {
        results = await Promise.all(Array.from({ length: 10 }, () => post(app, rollbackUrl(fx), promoteH(approval, randomUUID()), {})));
      } finally {
        hold.mockRestore();
      }
      const calls = applySpy.mock.calls.length;
      applySpy.mockRestore();
      const winner = expectOneWinner(results, 201);
      expect(winner.json()).toMatchObject({ status: "rolled_back", replayed: false });
      expect(calls).toBe(1);
      expect(rec.count(/INSERT INTO promotion_runs/)).toBe(1);
      expect(rec.count(/INSERT INTO promotion_snapshots/)).toBe(0);
      expect(await runCount(fx, "rollback")).toBe(1);
      expect(await snapshotCount(fx)).toBe(1); // the one the first promote took
      expect(await liveSlugs(fx)).toEqual(["home"]);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.content.rollback"]);
    });
  });

  // ==============================================================================================
  // Replay
  // ==============================================================================================
  describe("replay: same key + same request -> the original's body, replayed:true, no second effect", () => {
    it("content.promote: the replay body is BYTE-IDENTICAL to the original (modulo the replayed flag); one run, one snapshot, one import, one .replay audit row", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const applySpy = vi.spyOn(app.get(ContentBundleService), "applyBundle");
      rec.reset();
      // No `version` in the request: the default (promote-<now>) is generated per request, and the
      // replay must still match its own first request.
      const first = await post(app, promoteUrl(fx), promoteH(approval, idem), { bundle: bundleFor("replay") });
      const second = await post(app, promoteUrl(fx), promoteH(approval, idem), { bundle: bundleFor("replay") });
      const calls = applySpy.mock.calls.length;
      applySpy.mockRestore();
      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      expect(first.json().replayed).toBe(false);
      expect(second.json().replayed).toBe(true);
      expect(second.json().promotionRunId).toBe(first.json().promotionRunId);
      expect(bodyText(second)).toBe(bodyText(first));
      expect(first.json()).toMatchObject({ status: "content_promoted_frontend_pending", applyResult: { itemsWritten: 1 } });
      expect(calls).toBe(1);
      expect(rec.count(/INSERT INTO promotion_snapshots/)).toBe(1);
      expect(await runCount(fx, "promote")).toBe(1);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.content.promote", "control.content.promote.replay"]);
    });

    it("content.rollback: the replay body is byte-identical; one run, one restore import", async () => {
      const fx = await fixture(app);
      expect((await post(app, promoteUrl(fx), promoteH(randomUUID(), randomUUID()), { version: "p", bundle: bundleFor("x") })).statusCode).toBe(201);
      const approval = randomUUID();
      const idem = randomUUID();
      const applySpy = vi.spyOn(app.get(ContentBundleService), "applyBundle");
      const first = await post(app, rollbackUrl(fx), promoteH(approval, idem), {});
      // A newer promote moves the latest snapshot; the rollback replay must still answer from its own run.
      expect((await post(app, promoteUrl(fx), promoteH(randomUUID(), randomUUID()), { version: "p2", bundle: bundleFor("y") })).statusCode).toBe(201);
      applySpy.mockClear();
      const second = await post(app, rollbackUrl(fx), promoteH(approval, idem), {});
      const calls = applySpy.mock.calls.length;
      applySpy.mockRestore();
      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      expect(second.json().replayed).toBe(true);
      expect(bodyText(second)).toBe(bodyText(first));
      expect(calls).toBe(0);
      expect(await runCount(fx, "rollback")).toBe(1);
    });

    it("the same key with a DIFFERENT request is 409 idempotency-key-reused", async () => {
      const fx = await fixture(app);
      const idem = randomUUID();
      expect((await post(app, promoteUrl(fx), promoteH(randomUUID(), idem), { version: "one", bundle: bundleFor("one") })).statusCode).toBe(201);
      const other = await post(app, promoteUrl(fx), promoteH(randomUUID(), idem), { version: "two", bundle: bundleFor("one") });
      expect(other.statusCode).toBe(409);
      expect(other.json().type).toBe(`${PROBLEM}idempotency-key-reused`);
      expect(await runCount(fx, "promote")).toBe(1);
    });

    it("the same key with a DIFFERENT bundle is 409 idempotency-key-reused, and nothing runs (promote)", async () => {
      const fx = await fixture(app);
      const idem = randomUUID();
      const first = await post(app, promoteUrl(fx), promoteH(randomUUID(), idem), { version: "same", bundle: bundleFor("first") });
      expect(first.statusCode).toBe(201);
      const applySpy = vi.spyOn(app.get(ContentBundleService), "applyBundle");
      rec.reset();
      const other = await post(app, promoteUrl(fx), promoteH(randomUUID(), idem), { version: "same", bundle: bundleFor("second") });
      const calls = applySpy.mock.calls.length;
      applySpy.mockRestore();
      expect(other.statusCode).toBe(409);
      expect(other.json().type).toBe(`${PROBLEM}idempotency-key-reused`);
      expect(calls).toBe(0);
      expect(rec.count(/INSERT INTO (audit_entries|promotion_runs|promotion_snapshots)/)).toBe(0);
      expect(await runCount(fx, "promote")).toBe(1);
      expect(await snapshotCount(fx)).toBe(1);
      // ... while the SAME bundle (its informational exportedAt differs per call) still replays.
      const same = await post(app, promoteUrl(fx), promoteH(randomUUID(), idem), { version: "same", bundle: bundleFor("first") });
      expect(same.statusCode).toBe(201);
      expect(same.json().replayed).toBe(true);
      expect(bodyText(same)).toBe(bodyText(first));
    });

    it("a replay that arrives while the run is still IN PROGRESS is 409 promotion-in-progress, starts nothing, and the finished run then replays its body", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const snapshots = app.get(PromotionSnapshotService);
      const realTake = snapshots.takeSnapshot.bind(snapshots);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      parked.push(() => release());
      let entered!: () => void;
      const inSnapshot = new Promise<void>((r) => (entered = r));
      const spy = vi.spyOn(snapshots, "takeSnapshot").mockImplementation(async (input) => {
        entered();
        await gate; // the saga is parked between the claim and the snapshot
        return realTake(input);
      });
      let original: Promise<Res>;
      try {
        original = post(app, promoteUrl(fx), promoteH(approval, idem), { version: "slow", bundle: bundleFor("slow") });
        await inSnapshot;
        const mid = await post(app, promoteUrl(fx), promoteH(approval, idem), { version: "slow", bundle: bundleFor("slow") });
        expect(mid.statusCode).toBe(409);
        expect(mid.json().type).toBe(`${PROBLEM}promotion-in-progress`);
        expect(await runCount(fx, "promote")).toBe(1);
        expect(await snapshotCount(fx)).toBe(0); // still parked before the snapshot
        release();
      } finally {
        release();
        spy.mockRestore();
      }
      const done = await original;
      expect(done.statusCode).toBe(201);
      const after = await post(app, promoteUrl(fx), promoteH(approval, idem), { version: "slow", bundle: bundleFor("slow") });
      expect(after.statusCode).toBe(201);
      expect(after.json().replayed).toBe(true);
      expect(bodyText(after)).toBe(bodyText(done));
      expect(await runCount(fx, "promote")).toBe(1);
      expect(await snapshotCount(fx)).toBe(1);
    });
  });

  // ==============================================================================================
  // Durability: the replay record is in the database, not in process memory
  // ==============================================================================================
  it("a replay still works after the app is stopped and a fresh app is started on the same database", async () => {
    const appA = await boot();
    const fx = await fixture(appA);
    const promoteApproval = randomUUID();
    const promoteIdem = randomUUID();
    const p1 = await post(appA, promoteUrl(fx), promoteH(promoteApproval, promoteIdem), { version: "durable", bundle: bundleFor("durable") });
    expect(p1.statusCode).toBe(201);
    const rollbackApproval = randomUUID();
    const rollbackIdem = randomUUID();
    const r1 = await post(appA, rollbackUrl(fx), promoteH(rollbackApproval, rollbackIdem), {});
    expect(r1.statusCode).toBe(201);
    await appA.close(); // the first process is gone

    const appB = await boot();
    try {
      const applySpy = vi.spyOn(appB.get(ContentBundleService), "applyBundle");
      const recB = recordStatements(appB);
      const p2 = await post(appB, promoteUrl(fx), promoteH(promoteApproval, promoteIdem), { version: "durable", bundle: bundleFor("durable") });
      const r2 = await post(appB, rollbackUrl(fx), promoteH(rollbackApproval, rollbackIdem), {});
      expect([p2.statusCode, r2.statusCode]).toEqual([201, 201]);
      expect(p2.json().replayed).toBe(true);
      expect(r2.json().replayed).toBe(true);
      expect(bodyText(p2)).toBe(bodyText(p1));
      expect(bodyText(r2)).toBe(bodyText(r1));
      expect(applySpy.mock.calls).toHaveLength(0);
      expect(recB.count(/INSERT INTO promotion_(runs|snapshots)/)).toBe(0);
      expect(await runCount(fx, "promote")).toBe(1);
      expect(await runCount(fx, "rollback")).toBe(1);
      expect(await snapshotCount(fx)).toBe(1);
    } finally {
      await appB.close();
    }
  });

  // ==============================================================================================
  // Failure after the claim committed: the run fails as today, the approval stays consumed
  // ==============================================================================================
  describe("a failure in the import AFTER the claim committed", () => {
    it("content.promote: run marked failed, snapshot kept, content untouched, approval CONSUMED (a second try is 403), the key reports the failed run", async () => {
      const fx = await fixture(app);
      const approval = randomUUID();
      const idem = randomUUID();
      const before = await liveSlugs(fx);
      const failing = vi.spyOn(app.get(ContentBundleService), "applyBundle").mockRejectedValueOnce(new Error("injected import failure"));
      let bad: Res;
      try {
        bad = await post(app, promoteUrl(fx), promoteH(approval, idem), { version: "doomed", bundle: bundleFor("doomed") });
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      const [run] = await rows<{ status: string; current_step: string; snapshot_id: string | null; error_detail: { step: string; message: string } }>(
        fx.tenantId,
        `SELECT status, current_step, snapshot_id, error_detail FROM promotion_runs WHERE target_env_id = $1 AND version = 'doomed'`,
        [fx.envId],
      );
      expect(run).toMatchObject({ status: "failed", current_step: "migrate_import" });
      expect(run.snapshot_id).toBeTruthy();
      expect(run.error_detail).toMatchObject({ step: "migrate_import", message: "injected import failure" });
      expect(await snapshotCount(fx)).toBe(1);
      expect(await liveSlugs(fx)).toEqual(before); // nothing half-applied
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.content.promote"]); // the claim committed with the run row

      // The approval is spent: a retry with it, under a NEW key, is refused before anything runs.
      rec.reset();
      const again = await post(app, promoteUrl(fx), promoteH(approval, randomUUID()), { version: "doomed-2", bundle: bundleFor("doomed") });
      expect(again.statusCode).toBe(403);
      expect(again.json().type).toBe(`${PROBLEM}ws4-approval-already-used`);
      expect(rec.count(/INSERT INTO promotion_snapshots/)).toBe(0);
      expect(await runCount(fx, "promote")).toBe(1);

      // The same key reports the failed run; it does not start a second one.
      const sameKey = await post(app, promoteUrl(fx), promoteH(randomUUID(), idem), { version: "doomed", bundle: bundleFor("doomed") });
      expect(sameKey.statusCode).toBe(409);
      expect(sameKey.json().type).toBe(`${PROBLEM}promotion-run-failed`);
      expect(await runCount(fx, "promote")).toBe(1);
    });

    it("content.rollback: same (the restore import is made to throw)", async () => {
      const fx = await fixture(app);
      expect((await post(app, promoteUrl(fx), promoteH(randomUUID(), randomUUID()), { version: "p", bundle: bundleFor("kept") })).statusCode).toBe(201);
      const before = await liveSlugs(fx);
      const approval = randomUUID();
      const failing = vi.spyOn(app.get(ContentBundleService), "applyBundle").mockRejectedValueOnce(new Error("injected restore failure"));
      let bad: Res;
      try {
        bad = await post(app, rollbackUrl(fx), promoteH(approval, randomUUID()), {});
      } finally {
        failing.mockRestore();
      }
      expect(bad.statusCode).toBe(500);
      const [run] = await rows<{ status: string; error_detail: { step: string } }>(
        fx.tenantId,
        `SELECT status, error_detail FROM promotion_runs WHERE target_env_id = $1 AND kind = 'rollback'`,
        [fx.envId],
      );
      expect(run).toMatchObject({ status: "failed", error_detail: { step: "restore" } });
      expect(await liveSlugs(fx)).toEqual(before);
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.content.rollback"]);
      const again = await post(app, rollbackUrl(fx), promoteH(approval, randomUUID()), {});
      expect(again.statusCode).toBe(403);
      expect(again.json().type).toBe(`${PROBLEM}ws4-approval-already-used`);
      expect(await runCount(fx, "rollback")).toBe(1);
    });

    it("a REAL Postgres failure in the import (a bundle that violates content_items' CHECK) rolls the import back whole and fails the run", async () => {
      const fx = await fixture(app);
      const before = await liveSlugs(fx);
      const poisoned = bundleFor("poisoned");
      Object.assign(poisoned.contentItems[0], { publishState: "scheduled", publishAt: "2030-01-02T00:00:00.000Z", unpublishAt: "2030-01-01T00:00:00.000Z" });
      const approval = randomUUID();
      const bad = await post(app, promoteUrl(fx), promoteH(approval, randomUUID()), { version: "v-poisoned", bundle: poisoned });
      expect(bad.statusCode).toBe(500);
      expect(await liveSlugs(fx)).toEqual(before);
      expect((await rows<{ status: string }>(fx.tenantId, `SELECT status FROM promotion_runs WHERE version = 'v-poisoned'`))[0].status).toBe("failed");
      expect(await approvalActions(fx.tenantId, approval)).toEqual(["control.content.promote"]);
    });
  });

  // ==============================================================================================
  // What the idempotency record holds
  // ==============================================================================================
  it("the claim stores a run REFERENCE; the finished run's record holds the final body", async () => {
    const fx = await fixture(app);
    const res = await post(app, promoteUrl(fx), promoteH(randomUUID(), randomUUID()), { version: "stored", bundle: bundleFor("stored") });
    expect(res.statusCode).toBe(201);
    const stored = await idemRows(fx, "content.promote");
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("completed");
    expect(Object.keys(stored[0].response).sort()).toEqual(["finalBody", "promotionRunId"]);
    expect(stored[0].response.promotionRunId).toBe(res.json().promotionRunId);
    expect(typeof stored[0].response.finalBody).toBe("string");
  });

  // ==============================================================================================
  // Refusals before the claim write no audit row and claim no idempotency key
  // ==============================================================================================
  it("pre-envelope refusals (validation, unknown tenant/site/environment, no snapshot, no WS4) write no audit row and claim no idempotency key", async () => {
    const fx = await fixture(app);
    const ghost = `t5b-ghost-${randomUUID().slice(0, 6)}`;
    const cases: { name: string; status: number; send: () => Promise<Res> }[] = [
      { name: "promote unknown tenant", status: 404, send: () => post(app, promoteUrl({ ...fx, slug: ghost }), promoteH(randomUUID(), randomUUID()), { version: "v" }) },
      { name: "promote unknown environment", status: 404, send: () => post(app, promoteUrl({ ...fx, envId: randomUUID() }), promoteH(randomUUID(), randomUUID()), { version: "v" }) },
      { name: "promote unknown site", status: 404, send: () => post(app, promoteUrl({ ...fx, siteId: randomUUID() }), promoteH(randomUUID(), randomUUID()), { version: "v" }) },
      { name: "promote bad bundle", status: 400, send: () => post(app, promoteUrl(fx), promoteH(randomUUID(), randomUUID()), { bundle: { nope: true } }) },
      { name: "promote no Idempotency-Key", status: 400, send: () => post(app, promoteUrl(fx), hdr({ scopes: ["webdesk:promote"], ws4: randomUUID() }), { version: "v" }) },
      { name: "promote no WS4 approval", status: 403, send: () => post(app, promoteUrl(fx), hdr({ scopes: ["webdesk:promote"], idem: randomUUID() }), { version: "v" }) },
      { name: "rollback no snapshot", status: 409, send: () => post(app, rollbackUrl(fx), promoteH(randomUUID(), randomUUID()), {}) },
      { name: "rollback unknown tenant", status: 404, send: () => post(app, rollbackUrl({ ...fx, slug: ghost }), promoteH(randomUUID(), randomUUID()), {}) },
      { name: "rollback no WS4 approval", status: 403, send: () => post(app, rollbackUrl(fx), hdr({ scopes: ["webdesk:promote"], idem: randomUUID() }), {}) },
    ];
    for (const c of cases) {
      rec.reset();
      const res = await c.send();
      expect(res.statusCode, c.name).toBe(c.status);
      expect(rec.count(/INSERT INTO audit_entries/), `${c.name}: audit rows`).toBe(0);
      expect(rec.count(/INSERT INTO control_idempotency_keys/), `${c.name}: idempotency claims`).toBe(0);
      expect(rec.count(/INSERT INTO promotion_runs/), `${c.name}: runs`).toBe(0);
    }
  });

  // ==============================================================================================
  // The public contract: today's body, exactly
  // ==============================================================================================
  it("response bodies keep their exact shape", async () => {
    const fx = await fixture(app);
    const p = await post(app, promoteUrl(fx), promoteH(randomUUID(), randomUUID()), { version: "shape", bundle: bundleFor("shape") });
    expect(p.statusCode).toBe(201);
    expect(Object.keys(p.json())).toEqual(["promotionRunId", "status", "snapshot", "applyResult", "frontendDeploy", "replayed"]);
    expect(Object.keys(p.json().snapshot)).toEqual(["id", "checksum", "itemCount"]);
    expect(Object.keys(p.json().frontendDeploy)).toEqual(["ok", "reason"]);
    const r = await post(app, rollbackUrl(fx), promoteH(randomUUID(), randomUUID()), {});
    expect(r.statusCode).toBe(201);
    expect(Object.keys(r.json())).toEqual(["promotionRunId", "status", "restoredFromSnapshotId", "applyResult", "replayed"]);
  });
});
