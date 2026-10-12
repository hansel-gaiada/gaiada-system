// M5-V5-c — the experiments service against LIVE Postgres + the real HTTP layer (needs DATABASE_URL_TEST and the Cerbos env, see
// platform-nest/CLAUDE.md; skipped without it — NOT run on the dev laptop, runs on the Linux gate).
// Covers: the migration's guards (pre-registration lock, status machine, running cap, append-only results, RLS), the register /
// sync / results / stop / abort / decide flow over HTTP with Umami and WebDesk faked at the seams (`experimentIo`), the acceptance
// list of design §8 row V5-c (no estimate before the horizon, 409 on a pre-registration edit after start, a 57-day projection is 422,
// the 11th live test is refused, Umami outage = `unavailable` not zeros) and denial with VALID bodies plus a positive control.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { experimentIo, type WebdeskItemFacts } from "./experiments.service";

const calls: Array<{ kind: string; action: string; tenantId?: string }> = [];
let denyAll = false;
let useRealCerbos = false;
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (p: never, resource: { kind: string; tenantId?: string }, action: string, ...rest: unknown[]) => {
      if (useRealCerbos) return (actual.check as (...a: unknown[]) => Promise<unknown>)(p, resource, action, ...rest) as never;
      calls.push({ kind: resource.kind, action, tenantId: resource.tenantId });
      return denyAll ? { allow: false as const, reason: "test-forced-deny" } : { allow: true as const };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const S = { modules: ["search"] };
const SITE_UMAMI = "11111111-2222-4333-8444-555555555555";
const WD_SITE = "22222222-3333-4444-8555-666666666666";
const DAY = 86_400_000;
const T0 = Date.now();

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────
interface UmamiFake {
  sectionViews: number;   // section_view{section_id=home.hero} over the 28-day window
  goalEvents: number;     // lead_form_start{form_id=contact} over the window
  exposure: Array<{ value: string; total: number }>;
  convert: Array<{ value: string; total: number }>;
  fail: boolean;
  requested: string[];    // eventName of every event-data/values read
}
const umami: UmamiFake = { sectionViews: 8400, goalEvents: 252, exposure: [], convert: [], fail: false, requested: [] };
const fakeFetch = (async (input: unknown) => {
  const u = new URL(String(input));
  if (umami.fail) throw new Error("connection refused");
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (!u.pathname.includes(SITE_UMAMI)) return new Response("{}", { status: 404 });
  if (u.pathname.endsWith("/event-data/values")) {
    const ev = u.searchParams.get("eventName")!;
    umami.requested.push(ev);
    if (ev === "section_view") return json([{ value: "home.hero", total: umami.sectionViews }]);
    if (ev === "lead_form_start") return json([{ value: "contact", total: umami.goalEvents }]);
    if (ev === "exp_exposure") return json(umami.exposure);
    if (ev === "exp_convert") return json(umami.convert);
    return json([]);
  }
  if (u.pathname.endsWith("/metrics")) return json([{ x: "generate_lead", y: 40 }]);
  return json({});
}) as unknown as typeof fetch;

const wd: { items: Map<string, WebdeskItemFacts>; clock: number } = { items: new Map(), clock: T0 };
const facts = (over: Partial<WebdeskItemFacts> = {}): WebdeskItemFacts => ({
  exists: true, deleted: false, collectionKey: "home", locale: "en", publishState: "draft", publishedVersion: null, pendingChanges: true,
  updatedAt: new Date(T0).toISOString(), liveBlocks: null, ...over,
});
const blockFor = (key: string, arms = [{ key: "a", weight: 50 }, { key: "b", weight: 50, override: { heading: "x" } }]) => ({
  type: "experiment",
  props: { key, target: "fields", enrolment: "consented", goal: { event: "lead_form_start", match: { form_id: "contact" } }, arms },
});
const goLive = (itemId: string, key: string, over: Partial<WebdeskItemFacts> = {}) =>
  wd.items.set(itemId, facts({ publishState: "published", publishedVersion: 2, pendingChanges: false, liveBlocks: [{ type: "fields", props: {} }, blockFor(key)], ...over }));

describe.skipIf(!TEST_URL)("M5-V5-c · experiments", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let prop: string;       // the main property, bound to the fake Umami site
  let propUnbound: string;
  let n = 0;

  const mkProp = async (domain: string, umamiId: string | null): Promise<string> => {
    const id = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,now())`, [id, A, clientA, domain, `https://${domain}`, umamiId], ), S);
    return id;
  };
  const base = (p: string = prop, tenant: string = A): string => `/api/${tenant}/modules/search/properties/${p}/experiments`;
  const body = (over: Record<string, unknown> = {}) => {
    const itemId = newId();
    n++;
    wd.items.set(itemId, facts());
    return {
      key: `test-${n}-${itemId.slice(0, 4)}`,
      hypothesis: "A shorter headline will get more people to start the contact form.",
      webdesk: { tenantSlug: "gaiada", siteId: WD_SITE, itemId },
      sectionId: "home.hero", target: "fields",
      goal: { event: "lead_form_start", match: { form_id: "contact" } },
      arms: [{ key: "a", weight: 50 }, { key: "b", weight: 50 }],
      baselineRate: 0.03, relativeMde: 0.5, ...over,
    } as Record<string, unknown> & { key: string; webdesk: { itemId: string } };
  };
  const post = (url: string, payload?: unknown, user = uA) => app.inject({ method: "POST", url, headers: asUser(user), ...(payload !== undefined ? { payload: payload as object } : {}) });
  const register = async (over: Record<string, unknown> = {}, p: string = prop) => {
    const b = body(over);
    const r = await post(base(p), b);
    expect(r.statusCode, r.body).toBe(201);
    return { b, exp: (r.json() as { experiment: { id: string; key: string; status: string; preRegistration: Record<string, unknown> } }).experiment };
  };
  const row = async (id: string) =>
    (await withTenants([A], (c) => c.query(`SELECT * FROM search_experiments WHERE id = $1`, [id]), S)).rows[0] as Record<string, unknown>;
  const startIt = async (b: { key: string; webdesk: { itemId: string } }, id: string) => {
    goLive(b.webdesk.itemId, b.key, { updatedAt: new Date(wd.clock).toISOString() });
    const r = await post(`${base()}/${id}/sync`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ state: "started" });
  };
  /** Every object key anywhere in a value. */
  const keysOf = (v: unknown, acc: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, acc));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.push(k); keysOf(x, acc); }
    return acc;
  };
  const OUTCOME_KEY = /rate|diff|interval|^ci|pvalue|praw|padjusted|conversion|winner|lift|significan|chisquare|analysis/i;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("M5V5c Co A", ["search"]);
    C = await createCompany("M5V5c Co C", ["search"]);
    uA = await createUser("m5v5c-a@a.test");
    uC = await createUser("m5v5c-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "M5V5c Client");
    app = await buildApp();
    prop = await mkProp("exp.example.com", SITE_UMAMI);
    propUnbound = await mkProp("unbound.example.com", null);
    experimentIo.umami = { settings: { baseUrl: "http://umami.test", apiKey: "k", timeoutMs: 1000 }, fetchImpl: fakeFetch };
    experimentIo.webdesk = { readItem: async (_t, ref) => wd.items.get(ref.itemId) ?? { ...facts(), exists: false } };
    experimentIo.now = () => new Date(wd.clock);
    experimentIo.allowAllEnrolment = () => false;
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => {
    calls.length = 0; denyAll = false; useRealCerbos = false;
    umami.sectionViews = 8400; umami.goalEvents = 252; umami.exposure = []; umami.convert = []; umami.fail = false; umami.requested = [];
    wd.clock = T0;
  });

  // ── register ────────────────────────────────────────────────────────────────────────────────
  describe("register (pre-registration)", () => {
    it("records the plan: n per arm 2,518 and 17 projected days at 300 section views a day; gated by search_property update", async () => {
      const { exp } = await register();
      expect(exp.status).toBe("draft");
      expect(exp.preRegistration).toMatchObject({ nPerArm: 2518, projectedDays: 17, baselineRate: 0.03, baselineSource: "supplied", alpha: 0.05, power: 0.8, locked: false });
      expect(calls).toContainEqual({ kind: "resource_search_property", action: "update", tenantId: A });
      const r = await row(exp.id);
      expect(r).toMatchObject({ collection_key: "home", locale: "en", n_per_arm: 2518, projected_days: 17, status: "draft", started_at: null });
    });

    it("a missing baselineRate is suggested from the last 28 days of Umami (goal events / section views)", async () => {
      const { exp } = await register({ baselineRate: undefined });
      expect(exp.preRegistration).toMatchObject({ baselineSource: "umami_28d", nPerArm: 2518 });
      expect(exp.preRegistration.baselineRate as number).toBeCloseTo(0.03, 6);
    });

    it("a 57-day projection is 422 `underpowered`, carries the projection, and writes nothing", async () => {
      umami.sectionViews = 2478; // 88.5 a day: 2518 per arm at 50 % each = 56.9 -> 57 days
      const b = body();
      const r = await post(base(), b);
      expect(r.statusCode).toBe(422);
      const j = r.json() as { error: string; reason: string; existing: { projectedDays: number; maxDays: number; nPerArm: number } };
      expect(j.reason).toBe("underpowered");
      expect(j.error.startsWith("underpowered")).toBe(true);
      expect(j.existing).toMatchObject({ projectedDays: 57, maxDays: 56, nPerArm: 2518 });
      const rows = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_experiments WHERE key = $1`, [b.key]), S);
      expect(rows.rows).toHaveLength(0);
      umami.sectionViews = 2520; // 90 a day = 55.96 -> 56: allowed
      expect((await post(base(), body())).statusCode).toBe(201);
    });

    it("typed refusals: bad body 400, duplicate key 409, same item 409, item missing 404, item already running a test 409, enrolment all 400", async () => {
      const bad = await post(base(), body({ arms: [{ key: "a", weight: 60 }, { key: "b", weight: 60 }] }));
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ reason: "arms_invalid" });
      const { b } = await register();
      const dupKey = await post(base(), body({ key: b.key }));
      expect(dupKey.statusCode).toBe(409);
      expect(dupKey.json()).toMatchObject({ reason: "key_taken" });
      const dupItem = await post(base(), { ...body(), webdesk: b.webdesk });
      expect(dupItem.statusCode).toBe(409);
      expect(dupItem.json()).toMatchObject({ reason: "item_already_registered" });
      const missing = body();
      wd.items.delete(missing.webdesk.itemId);
      expect((await post(base(), missing)).json()).toMatchObject({ reason: "item_not_found" });
      const live = body();
      goLive(live.webdesk.itemId, "someone-elses-test");
      const lr = await post(base(), live);
      expect(lr.statusCode).toBe(409);
      expect(lr.json()).toMatchObject({ reason: "item_already_has_experiment" });
      const all = await post(base(), body({ enrolment: "all" }));
      expect(all.statusCode).toBe(400);
      expect(all.json()).toMatchObject({ reason: "enrolment_all_not_enabled" });
    });

    it("an unbound property cannot be projected: 409 analytics_not_bound; Umami down: 503 analytics_unreachable", async () => {
      const r = await post(base(propUnbound), body());
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "analytics_not_bound" });
      umami.fail = true;
      const d = await post(base(), body());
      expect(d.statusCode).toBe(503);
      expect(d.json()).toMatchObject({ reason: "analytics_unreachable" });
    });

    it("the 11th live test on a property is refused with a typed 409, over HTTP and in the database", async () => {
      const p = await mkProp("cap.example.com", SITE_UMAMI);
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push((await register({}, p)).exp.id);
      const r = await post(base(p), body());
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "too_many_running" });
      // the trigger is the backstop: ten running, an eleventh cannot start even by raw SQL
      for (const id of ids) {
        await withTenants([A], (c) => c.query(`UPDATE search_experiments SET status = 'running', started_at = now() WHERE id = $1`, [id]), S);
      }
      const extra = newId();
      const insertRunning = withTenants([A], (c) => c.query(
        `INSERT INTO search_experiments (id, tenant_id, property_id, key, webdesk_tenant_slug, webdesk_site_id, collection_key, item_id, locale, section_id,
           target, goal, arms, hypothesis, baseline_rate, baseline_source, relative_mde, n_per_arm, daily_units, projected_days, status, started_at)
         VALUES ($1,$2,$3,'raw-eleventh','gaiada',$4,'home',$5,'en','home.hero','"fields"','{"event":"cta_click"}','[{"key":"a","weight":50},{"key":"b","weight":50}]',
           'h',0.03,'supplied',0.5,2518,300,17,'running',now())`, [extra, A, p, WD_SITE, newId()]), S);
      await expect(insertRunning).rejects.toMatchObject({ constraint: "search_experiments_running_cap" });
      // aborting one frees a slot
      expect((await post(`${base(p)}/${ids[0]}/abort`)).statusCode).toBe(200);
      expect((await post(base(p), body())).statusCode).toBe(201);
    });
  });

  // ── lifecycle ───────────────────────────────────────────────────────────────────────────────
  describe("sync, the lock and the status machine", () => {
    it("not_live until the live version carries the block; plan_mismatch when it differs; started when it matches, started_at = the publish", async () => {
      const { b, exp } = await register();
      expect((await post(`${base()}/${exp.id}/sync`)).json()).toMatchObject({ state: "not_live" });
      // a different weight split went live: not started, with the differing member
      wd.items.set(b.webdesk.itemId, facts({ publishState: "published", publishedVersion: 2, pendingChanges: false,
        liveBlocks: [blockFor(b.key, [{ key: "a", weight: 70 }, { key: "b", weight: 30 }] as never)] }));
      const mm = await post(`${base()}/${exp.id}/sync`);
      expect(mm.json()).toMatchObject({ state: "plan_mismatch", differences: ["arms"], experiment: { status: "draft" } });
      const published = new Date(Date.now() + 60_000).toISOString(); // after the row's created_at, so it is not clamped
      wd.clock = Date.now() + 120_000;
      goLive(b.webdesk.itemId, b.key, { updatedAt: published });
      const ok = await post(`${base()}/${exp.id}/sync`);
      expect(ok.json()).toMatchObject({ state: "started", experiment: { status: "running", startedAt: published } });
      expect((await post(`${base()}/${exp.id}/sync`)).json()).toMatchObject({ state: "already_running" });
    });

    it("a draft can be edited (plan recomputed); after start the pre-registration edit is 409 and the database refuses it too", async () => {
      const { b, exp } = await register();
      const edit = await app.inject({ method: "PATCH", url: `${base()}/${exp.id}`, headers: asUser(uA), payload: { relativeMde: 0.4, hypothesis: "Changed my mind." } });
      expect(edit.statusCode, edit.body).toBe(200);
      expect((edit.json() as { experiment: { preRegistration: { nPerArm: number }; hypothesis: string } }).experiment).toMatchObject({ hypothesis: "Changed my mind." });
      expect((edit.json() as { experiment: { preRegistration: { nPerArm: number } } }).experiment.preRegistration.nPerArm).toBeGreaterThan(2518);
      const key = await app.inject({ method: "PATCH", url: `${base()}/${exp.id}`, headers: asUser(uA), payload: { key: "another-key" } });
      expect(key.statusCode).toBe(400);
      expect(key.json()).toMatchObject({ reason: "field_not_editable" });

      await startIt(b, exp.id);
      const locked = await app.inject({ method: "PATCH", url: `${base()}/${exp.id}`, headers: asUser(uA), payload: { relativeMde: 0.9 } });
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ reason: "pre_registration_locked" });
      expect((await row(exp.id)).relative_mde).toBe(0.4);
      // the trigger, bypassing the service
      for (const set of ["hypothesis = 'x'", "relative_mde = 0.9", "n_per_arm = 10", "arms = '[{\"key\":\"a\",\"weight\":20},{\"key\":\"b\",\"weight\":80}]'::jsonb", "goal = '{\"event\":\"cta_click\"}'::jsonb", "baseline_rate = 0.5", "started_at = now() + interval '1 day'"]) {
        await expect(withTenants([A], (c) => c.query(`UPDATE search_experiments SET ${set} WHERE id = $1`, [exp.id]), S), set)
          .rejects.toMatchObject({ constraint: "search_experiments_prereg_locked" });
      }
      // lifecycle columns still move
      await expect(withTenants([A], (c) => c.query(`UPDATE search_experiments SET updated_at = now() WHERE id = $1`, [exp.id]), S)).resolves.toBeTruthy();
    });

    it("the status machine: decided and aborted are final; draft cannot jump to decided", async () => {
      const { exp } = await register();
      await expect(withTenants([A], (c) => c.query(`UPDATE search_experiments SET status = 'decided' WHERE id = $1`, [exp.id]), S))
        .rejects.toThrow();
      expect((await post(`${base()}/${exp.id}/abort`)).statusCode).toBe(200);
      await expect(withTenants([A], (c) => c.query(`UPDATE search_experiments SET status = 'draft', stopped_at = NULL WHERE id = $1`, [exp.id]), S))
        .rejects.toMatchObject({ constraint: "search_experiments_status_machine" });
    });
  });

  // ── results ─────────────────────────────────────────────────────────────────────────────────
  describe("results: no estimate before the horizon", () => {
    it("before the horizon the body carries progress and the SRM verdict only: no rate, difference, interval, p or conversion, for the caller", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      wd.clock = T0 + 20 * DAY; // past the 14 days, but the exposures are short of n
      umami.exposure = [{ value: `${b.key}:a:c`, total: 1000 }, { value: `${b.key}:b:c`, total: 1010 }];
      umami.convert = [{ value: `${b.key}:a:c`, total: 40 }, { value: `${b.key}:b:c`, total: 90 }];
      const r = await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) });
      expect(r.statusCode).toBe(200);
      const j = r.json() as Record<string, unknown>;
      expect(j).toMatchObject({ state: "ok", phase: "collecting", horizonReached: false });
      expect((j.progress as { perArm: unknown[] }).perArm).toEqual([
        { key: "a", exposures: 1000, target: 2518, fraction: 0.397 },
        { key: "b", exposures: 1010, target: 2518, fraction: 0.401 },
      ]);
      expect(keysOf(j).filter((k) => OUTCOME_KEY.test(k))).toEqual([]);
      expect(r.body).not.toMatch(/"(analysis|conversions|pValue|difference|ciLower|ciUpper|rate)"/);
      // the conversions were never even requested from Umami
      expect(umami.requested).not.toContain("exp_convert");
      expect(umami.requested).toContain("exp_exposure");
      expect(calls).toContainEqual({ kind: "resource_search_property", action: "read", tenantId: A });
    });

    it("the horizon needs the days too: every arm at n but only 3 days in is still progress only", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      wd.clock = T0 + 3 * DAY;
      umami.exposure = [{ value: `${b.key}:a:c`, total: 3000 }, { value: `${b.key}:b:c`, total: 3000 }];
      const j = (await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json() as Record<string, unknown>;
      expect(j).toMatchObject({ phase: "collecting", horizonReached: false, progress: { exposuresReached: true, minDaysReached: false } });
      expect(keysOf(j).filter((k) => OUTCOME_KEY.test(k))).toEqual([]);
      expect(umami.requested).not.toContain("exp_convert");
    });

    it("a lopsided split raises the SRM alarm (a data-quality verdict, not an outcome)", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      wd.clock = T0 + 2 * DAY;
      umami.exposure = [{ value: `${b.key}:a:c`, total: 700 }, { value: `${b.key}:b:c`, total: 300 }];
      const j = (await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json() as { srm: { mismatch: boolean } };
      expect(j.srm.mismatch).toBe(true);
    });

    it("an Umami outage is state `unavailable` with a reason: no progress, no zeros", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      umami.fail = true;
      const j = (await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json() as Record<string, unknown>;
      expect(j).toMatchObject({ state: "unavailable", reason: "unreachable" });
      expect(j.progress).toBeUndefined();
      expect(r2(j)).not.toMatch(/"exposures"/);
    });

    it("a full 100-row page of values is `unavailable: truncated`, never a partial count", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      umami.exposure = Array.from({ length: 100 }, (_, i) => ({ value: `${b.key}:a:c${i}`, total: 1 }));
      const j = (await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json();
      expect(j).toMatchObject({ state: "unavailable", reason: "truncated" });
    });

    it("a draft has `not_started`, an unknown id is 404, a bad id is 400", async () => {
      const { exp } = await register();
      expect((await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json()).toMatchObject({ state: "not_started" });
      expect((await app.inject({ method: "GET", url: `${base()}/${newId()}/results`, headers: asUser(uA) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `${base()}/nope/results`, headers: asUser(uA) })).statusCode).toBe(400);
    });
  });
  const r2 = (j: unknown): string => JSON.stringify(j);

  // ── stop / decide / abort ───────────────────────────────────────────────────────────────────
  describe("stop, decide, abort", () => {
    it("stopping before the horizon is 409 horizon_not_reached; abort is the way out and shows no outcome", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      umami.exposure = [{ value: `${b.key}:a:c`, total: 10 }, { value: `${b.key}:b:c`, total: 10 }];
      const stop = await post(`${base()}/${exp.id}/stop`);
      expect(stop.statusCode).toBe(409);
      expect(stop.json()).toMatchObject({ reason: "horizon_not_reached" });
      expect((await row(exp.id)).status).toBe("running");
      const ab = await post(`${base()}/${exp.id}/abort`);
      expect(ab.statusCode).toBe(200);
      expect(ab.json()).toMatchObject({ experiment: { status: "aborted" }, replayed: false });
      expect((await post(`${base()}/${exp.id}/abort`)).json()).toMatchObject({ replayed: true });
      const res = (await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json() as Record<string, unknown>;
      expect(res).toMatchObject({ state: "aborted" });
      expect(keysOf(res).filter((k) => OUTCOME_KEY.test(k))).toEqual([]);
      const snap = await withTenants([A], (c) => c.query(`SELECT outcome, decision, counts FROM search_experiment_results WHERE experiment_id = $1`, [exp.id]), S);
      expect(snap.rows).toEqual([{ outcome: "aborted", decision: null, counts: null }]);
      // an aborted test can be neither stopped nor decided
      expect((await post(`${base()}/${exp.id}/stop`)).statusCode).toBe(409);
      expect((await post(`${base()}/${exp.id}/decide`, {})).statusCode).toBe(409);
    });

    it("at the horizon the analysis appears; stop, then decide only once the block is gone; the snapshot is append-only and decide is idempotent", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      wd.clock = T0 + 20 * DAY;
      umami.exposure = [{ value: `${b.key}:a:c`, total: 2600 }, { value: `${b.key}:b:c`, total: 2600 }];
      umami.convert = [{ value: `${b.key}:a:c`, total: 78 }, { value: `${b.key}:b:c`, total: 156 }];
      const res = (await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json() as {
        phase: string; analysis: { decision: unknown; comparisons: Array<{ key: string; rate: number; pAdjusted: number; significantWinner: boolean }> };
      };
      expect(res.phase).toBe("horizon");
      expect(res.analysis.decision).toEqual({ action: "ship", arm: "b" });
      expect(res.analysis.comparisons[0]).toMatchObject({ key: "b", rate: 0.06, significantWinner: true });

      const early = await post(`${base()}/${exp.id}/decide`, {});
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ reason: "not_stopped" });
      const stop = await post(`${base()}/${exp.id}/stop`);
      expect(stop.statusCode, stop.body).toBe(200);
      expect(stop.json()).toMatchObject({ experiment: { status: "stopped" }, replayed: false });
      expect((await post(`${base()}/${exp.id}/stop`)).json()).toMatchObject({ replayed: true });

      // the block is still live: the human has not published its removal yet
      const still = await post(`${base()}/${exp.id}/decide`, { note: "ship b" });
      expect(still.statusCode).toBe(409);
      expect(still.json()).toMatchObject({ reason: "experiment_still_live" });

      wd.items.set(b.webdesk.itemId, facts({ publishState: "published", publishedVersion: 3, pendingChanges: false, liveBlocks: [{ type: "fields", props: {} }] }));
      const dec = await post(`${base()}/${exp.id}/decide`, { note: "ship b" });
      expect(dec.statusCode, dec.body).toBe(200);
      expect(dec.json()).toMatchObject({ experiment: { status: "decided" }, replayed: false, results: { phase: "horizon", decided: { decision: { action: "ship", arm: "b" }, note: "ship b" } } });
      const snap = await withTenants([A], (c) => c.query(`SELECT outcome, decision, counts, decided_by FROM search_experiment_results WHERE experiment_id = $1`, [exp.id]), S);
      expect(snap.rows).toHaveLength(1);
      expect(snap.rows[0]).toMatchObject({ outcome: "decided", decision: { action: "ship", arm: "b" }, decided_by: uA });
      expect(snap.rows[0].counts).toEqual([{ key: "a", units: 2600, conversions: 78 }, { key: "b", units: 2600, conversions: 156 }]);
      // idempotent, and a later look reads the snapshot (Umami may change; the decision does not)
      umami.fail = true;
      expect((await post(`${base()}/${exp.id}/decide`, {})).json()).toMatchObject({ replayed: true });
      expect((await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json()).toMatchObject({ state: "ok", phase: "horizon", decided: { decision: { action: "ship", arm: "b" } } });
      // append-only
      await expect(withTenants([A], (c) => c.query(`UPDATE search_experiment_results SET note = 'x' WHERE experiment_id = $1`, [exp.id]), S))
        .rejects.toMatchObject({ constraint: "search_experiment_results_append_only" });
      await expect(withTenants([A], (c) => c.query(`DELETE FROM search_experiment_results WHERE experiment_id = $1`, [exp.id]), S))
        .rejects.toMatchObject({ constraint: "search_experiment_results_append_only" });
      expect((await post(`${base()}/${exp.id}/abort`)).statusCode).toBe(409);
    });

    it("56 days without the horizon: inconclusive, keep the control, stop allowed, still no outcome numbers", async () => {
      const { b, exp } = await register();
      await startIt(b, exp.id);
      wd.clock = T0 + 58 * DAY;
      umami.exposure = [{ value: `${b.key}:a:c`, total: 300 }, { value: `${b.key}:b:c`, total: 300 }];
      const res = (await app.inject({ method: "GET", url: `${base()}/${exp.id}/results`, headers: asUser(uA) })).json() as Record<string, unknown>;
      expect(res).toMatchObject({ phase: "inconclusive", horizonReached: false, decision: { action: "keep_control", reason: "inconclusive_at_max_duration" } });
      expect(keysOf(res).filter((k) => OUTCOME_KEY.test(k))).toEqual([]);
      expect((await post(`${base()}/${exp.id}/stop`)).statusCode).toBe(200);
      wd.items.set(b.webdesk.itemId, facts({ publishState: "published", publishedVersion: 3, pendingChanges: false, liveBlocks: [] }));
      const dec = await post(`${base()}/${exp.id}/decide`, {});
      expect(dec.statusCode, dec.body).toBe(200);
      const snap = await withTenants([A], (c) => c.query(`SELECT decision, analysis FROM search_experiment_results WHERE experiment_id = $1`, [exp.id]), S);
      expect(snap.rows[0]).toEqual({ decision: { action: "keep_control", reason: "inconclusive_at_max_duration" }, analysis: null });
    });
  });

  // ── authorization, tenancy, RLS ─────────────────────────────────────────────────────────────
  describe("authorization and tenancy", () => {
    it("a Cerbos denial is 403 on every route with VALID ids and VALID bodies, and nothing changes; the allowed call is the positive control", async () => {
      const { b, exp } = await register();
      denyAll = true;
      const valid = body();
      const routes: Array<[string, string, unknown?]> = [
        ["GET", base()], ["POST", base(), valid], ["GET", `${base()}/${exp.id}`], ["PATCH", `${base()}/${exp.id}`, { relativeMde: 0.4 }],
        ["POST", `${base()}/${exp.id}/sync`], ["GET", `${base()}/${exp.id}/results`], ["POST", `${base()}/${exp.id}/stop`],
        ["POST", `${base()}/${exp.id}/abort`], ["POST", `${base()}/${exp.id}/decide`, { note: "n" }],
      ];
      for (const [method, url, payload] of routes) {
        const r = await app.inject({ method: method as "GET", url, headers: asUser(uA), ...(payload ? { payload: payload as object } : {}) });
        expect(r.statusCode, `${method} ${url}`).toBe(403);
      }
      denyAll = false;
      const after = await row(exp.id);
      expect(after).toMatchObject({ status: "draft", relative_mde: 0.5 });
      const count = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_experiments WHERE key = $1`, [valid.key]), S);
      expect(count.rows).toHaveLength(0);
      expect((await app.inject({ method: "GET", url: `${base()}/${exp.id}`, headers: asUser(uA) })).statusCode).toBe(200);
      expect((await post(base(), valid)).statusCode).toBe(201);
      expect(b.key).toBeTruthy();
    });

    it("cross-company: C's user is refused by the real policy; another company's tenant path is 404 (RLS), with valid ids", async () => {
      const { exp } = await register();
      useRealCerbos = true;
      expect((await app.inject({ method: "GET", url: base(), headers: asUser(uC) })).statusCode).toBe(403);
      expect((await post(`${base()}/${exp.id}/abort`, undefined, uC)).statusCode).toBe(403);
      useRealCerbos = false;
      for (const [method, url] of [
        ["GET", base(prop, C)], ["GET", `${base(prop, C)}/${exp.id}`], ["GET", `${base(prop, C)}/${exp.id}/results`],
        ["POST", `${base(prop, C)}/${exp.id}/abort`], ["POST", `${base(prop, C)}/${exp.id}/sync`],
      ] as const) {
        expect((await app.inject({ method, url, headers: asUser(uC) })).statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await row(exp.id)).status).toBe("draft");
    });

    it("RLS: an unset scope, a missing module scope and another company read zero rows, and a cross-tenant write is refused", async () => {
      expect((await withGlobal((c) => c.query(`SELECT 1 FROM search_experiments`))).rows).toHaveLength(0);
      expect((await withTenants([A], (c) => c.query(`SELECT 1 FROM search_experiments`))).rows).toHaveLength(0);
      expect((await withTenants([C], (c) => c.query(`SELECT 1 FROM search_experiments`), S)).rows).toHaveLength(0);
      expect((await withTenants([A], (c) => c.query(`SELECT 1 FROM search_experiments`), S)).rows.length).toBeGreaterThan(0);
      expect((await withTenants([C], (c) => c.query(`SELECT 1 FROM search_experiment_results`), S)).rows).toHaveLength(0);
      await expect(withTenants([C], (c) => c.query(
        `INSERT INTO search_experiments (id, tenant_id, property_id, key, webdesk_tenant_slug, webdesk_site_id, collection_key, item_id, locale, section_id,
           target, goal, arms, hypothesis, baseline_rate, baseline_source, relative_mde, n_per_arm, daily_units, projected_days)
         VALUES ($1,$2,$3,'cross-tenant','gaiada',$4,'home',$5,'en','home.hero','"fields"','{"event":"cta_click"}','[{"key":"a","weight":50},{"key":"b","weight":50}]',
           'h',0.03,'supplied',0.5,2518,300,17)`, [newId(), A, prop, WD_SITE, newId()]), S)).rejects.toThrow();
    });

    it("list: filters by status, 400 on a bad status, 404 on an unknown property", async () => {
      await register();
      const all = (await app.inject({ method: "GET", url: `${base()}?status=draft`, headers: asUser(uA) })).json() as { experiments: Array<{ status: string }> };
      expect(all.experiments.length).toBeGreaterThan(0);
      expect(all.experiments.every((e) => e.status === "draft")).toBe(true);
      expect((await app.inject({ method: "GET", url: `${base()}?status=bogus`, headers: asUser(uA) })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: base(newId()), headers: asUser(uA) })).statusCode).toBe(404);
    });
  });
});
