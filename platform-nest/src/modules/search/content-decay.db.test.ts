// M5-V4 — content-decay against LIVE Postgres + the real HTTP layer (needs DATABASE_URL_TEST and the Cerbos
// env, see platform-nest/CLAUDE.md; skipped without it — NOT run on the dev laptop, runs on the Linux gate).
// Covers: the sweep (idempotency, scope, verified/real-data filters, Umami via a fake fetch, flag-off = no
// calls), RLS (unset scope reads 0 rows), the bell, and the routes (authz kind/action captured, a denial
// with VALID ids, cross-company with the REAL policy, a positive control).
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
import { runContentDecaySweep, startContentDecayLoop } from "./content-decay-job";

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
const NOW = new Date("2026-10-12T05:00:00Z"); // recent 2026-09-12..2026-10-09, baseline 2026-08-15..2026-09-11
const SITE = "11111111-2222-4333-8444-555555555555";
const S = { modules: ["search"] };
const NO_UMAMI = { umami: { settings: null } } as const;

describe.skipIf(!TEST_URL)("M5-V4 · content decay", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let ownerA: string;
  let clientA: string;
  let propGsc: string;
  let propUnverified: string;
  let propSim: string;
  let propUmami: string;

  const mkProp = async (domain: string, o: { verified?: boolean; umami?: string | null } = {}): Promise<string> => {
    const id = newId();
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, A, clientA, domain, `https://${domain}`, o.umami ?? null, o.verified === false ? null : new Date("2026-01-01T00:00:00Z")],
    ), S);
    return id;
  };

  /** One GSC row per day per page across both windows: baseline days get `base` clicks, recent days `rec`. */
  const seedGsc = async (propertyId: string, page: string, base: number, rec: number, simulated = false): Promise<void> => {
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_gsc_performance (id, tenant_id, property_id, date, query, page, device, clicks, impressions, position, row_hash, simulated)
       SELECT gen_random_uuid(), $1, $2, d::date, 'q', $3, 'DESKTOP',
              CASE WHEN d::date >= DATE '2026-09-12' THEN $5::int ELSE $4::int END,
              CASE WHEN d::date >= DATE '2026-09-12' THEN $5::int * 20 ELSE $4::int * 20 END,
              8, md5($2::text || $3 || d::text), $6
         FROM generate_series(DATE '2026-08-15', DATE '2026-10-09', interval '1 day') AS d`,
      [A, propertyId, page, base, rec, simulated],
    ), S);
  };

  const findings = async (propertyId: string, tenant = A) => {
    const r = await withTenants([tenant], (c) => c.query<{ id: string; page_path: string; status: string; reason: string; brief_id: string | null }>(
      `SELECT id, page_path, status, reason, brief_id FROM search_decay_findings WHERE property_id = $1 ORDER BY page_path`, [propertyId]), S);
    return r.rows;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("M5V4 Co A", ["search"]);
    C = await createCompany("M5V4 Co C", ["search"]);
    uA = await createUser("m5v4-a@a.test");
    uC = await createUser("m5v4-c@c.test");
    ownerA = await createUser("m5v4-owner@a.test");
    await addMembership(A, uA);
    await addMembership(A, ownerA);
    await addMembership(C, uC);
    clientA = await createClient(A, "M5V4 Client");
    app = await buildApp();

    propGsc = await mkProp("gsc.example.com");
    propUnverified = await mkProp("unverified.example.com", { verified: false });
    propSim = await mkProp("sim.example.com");
    propUmami = await mkProp("umami.example.com", { umami: SITE });

    // 28 days at 20 clicks/day = 560 baseline; recent 5/day = 140: a real drop. /flat stays level. /tiny is below the floors.
    await seedGsc(propGsc, "https://gsc.example.com/drop/", 20, 5);
    await seedGsc(propGsc, "https://gsc.example.com/flat/", 20, 20);
    await seedGsc(propGsc, "https://gsc.example.com/tiny/", 1, 0);
    await seedGsc(propUnverified, "https://unverified.example.com/drop/", 20, 5);
    await seedGsc(propSim, "https://sim.example.com/drop/", 20, 5, true); // simulated demo rows never alert

    // the property's owner gets the bell
    await withTenants([A], (c) => c.query(
      `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, status, owner_id)
       VALUES ($1,$2,$3,$4,'M5V4 engagement','active',$5)`, [newId(), A, clientA, propGsc, ownerA]), S);
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => { calls.length = 0; denyAll = false; useRealCerbos = false; });

  it("the sweep writes findings for verified, real-data properties only, and is idempotent", async () => {
    const r1 = await runContentDecaySweep(NOW, NO_UMAMI);
    expect(r1.errors).toBe(0);
    const got = await findings(propGsc);
    expect(got.map((f) => f.page_path)).toEqual(["/drop"]);
    expect(got[0]).toMatchObject({ status: "open" });
    expect(got[0]!.reason).toContain("Search clicks fell 75% (560 to 140)");
    expect(await findings(propUnverified)).toEqual([]);
    expect(await findings(propSim)).toEqual([]);

    const r2 = await runContentDecaySweep(NOW, NO_UMAMI);
    expect(r2.inserted).toBe(0);
    expect(await findings(propGsc)).toHaveLength(1);
    // a later day, same page still down: still one live finding, not a fresh row a day
    const r3 = await runContentDecaySweep(new Date(NOW.getTime() + 86400000), NO_UMAMI);
    expect(r3.inserted).toBe(0);
    expect(await findings(propGsc)).toHaveLength(1);
  });

  it("the property's owner got one bell with ids and path, no personal data", async () => {
    const { rows } = await withTenants([A], (c) => c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM notifications WHERE user_id = $1 AND type = 'search.decay.found'`, [ownerA]));
    expect(rows).toHaveLength(1);
    const p = rows[0]!.payload;
    expect(p.entityId).toBe(propGsc);
    expect(p.paths).toEqual(["/drop"]);
    expect(Array.isArray(p.findingIds)).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/@|https?:/);
  });

  it("Umami views: three GET reads for the bound property, a drop is found, an empty year-ago window is skipped", async () => {
    const base = Date.parse("2026-08-15T00:00:00.000Z");
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      const startAt = Number(new URL(u).searchParams.get("startAt"));
      const body = startAt === base ? [{ x: "/v/", y: 900 }, { x: "/ok/", y: 500 }]
        : startAt > base ? [{ x: "/v/", y: 300 }, { x: "/ok/", y: 505 }] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    const r = await runContentDecaySweep(NOW, {
      umami: { settings: { baseUrl: "http://umami.invalid", apiKey: "k", timeoutMs: 1000 }, fetchImpl: fetchImpl as never },
    });
    expect(r.errors).toBe(0);
    expect(urls).toHaveLength(3); // only the Umami-bound property calls out
    expect(urls.every((u) => u.startsWith(`http://umami.invalid/api/websites/${SITE}/metrics?`))).toBe(true);
    const got = await findings(propUmami);
    expect(got.map((f) => f.page_path)).toEqual(["/v"]);
    expect(got[0]!.reason).toContain("Page views fell 67% (900 to 300)");
  });

  it("an Umami outage is not zero: no findings, no error", async () => {
    const p = await mkProp("outage.example.com", { umami: SITE });
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const r = await runContentDecaySweep(NOW, {
      umami: { settings: { baseUrl: "http://umami.invalid", apiKey: "k", timeoutMs: 1000 }, fetchImpl: fetchImpl as never },
    });
    expect(r.errors).toBe(0);
    expect(await findings(p)).toEqual([]);
  });

  it("a recovered page is resolved by the next sweep", async () => {
    await withTenants([A], (c) => c.query(
      `UPDATE search_gsc_performance SET clicks = 20, impressions = 400
        WHERE property_id = $1 AND page LIKE '%/drop/' AND date >= DATE '2026-09-12'`, [propGsc]), S);
    const r = await runContentDecaySweep(NOW, NO_UMAMI);
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect((await findings(propGsc)).map((f) => f.status)).toEqual(["resolved"]);
  });

  it("flag off: startContentDecayLoop makes no network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(startContentDecayLoop({})).toBeNull();
    expect(startContentDecayLoop({ SEARCH_DECAY_ENABLED: "" })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("RLS: an unset tenant scope reads 0 rows, a missing module scope reads 0 rows, another company reads 0 rows", async () => {
    const total = await withGlobal((c) => c.query(`SELECT 1 FROM search_decay_findings`));
    expect(total.rows).toHaveLength(0);
    const noModule = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_decay_findings`));
    expect(noModule.rows).toHaveLength(0);
    const other = await withTenants([C], (c) => c.query(`SELECT 1 FROM search_decay_findings`), S);
    expect(other.rows).toHaveLength(0);
    const own = await withTenants([A], (c) => c.query(`SELECT 1 FROM search_decay_findings`), S);
    expect(own.rows.length).toBeGreaterThan(0);
    // a write into another tenant's scope is refused by WITH CHECK
    await expect(withTenants([C], (c) => c.query(
      `INSERT INTO search_decay_findings (id, tenant_id, property_id, page_path, window_from, window_to, window_days, reason)
       VALUES ($1,$2,$3,'/x','2026-09-12','2026-10-09',28,'r')`, [newId(), A, propGsc]), S)).rejects.toThrow();
  });

  describe("routes", () => {
    let fid: string; // an open finding on propGsc
    const base = (p: string): string => `/api/${A}/modules/search/properties/${p}/decay`;

    beforeAll(async () => {
      // the earlier sweep resolved /drop; make a fresh page drop and detect it
      await seedGsc(propGsc, "https://gsc.example.com/second/", 20, 5);
      await runContentDecaySweep(NOW, NO_UMAMI);
      fid = (await findings(propGsc)).find((f) => f.page_path === "/second")!.id;
    });

    it("lists live findings, gated by search_property read (positive control)", async () => {
      const r = await app.inject({ method: "GET", url: base(propGsc), headers: asUser(uA) });
      expect(r.statusCode).toBe(200);
      const j = r.json() as { findings: Array<{ pagePath: string; status: string; reason: string }> };
      expect(j.findings.map((f) => f.pagePath)).toEqual(["/second"]);
      expect(j.findings[0]!.reason).toContain("Search clicks fell");
      expect(calls).toContainEqual({ kind: "resource_search_property", action: "read", tenantId: A });
      const all = await app.inject({ method: "GET", url: `${base(propGsc)}?status=all`, headers: asUser(uA) });
      expect((all.json() as { findings: unknown[] }).findings).toHaveLength(2);
      expect((await app.inject({ method: "GET", url: `${base(propGsc)}?status=bogus`, headers: asUser(uA) })).statusCode).toBe(400);
    });

    it("a Cerbos denial is 403 on all three routes with VALID ids, and nothing changes", async () => {
      denyAll = true;
      expect((await app.inject({ method: "GET", url: base(propGsc), headers: asUser(uA) })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/acknowledge`, headers: asUser(uA) })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/refresh-brief`, headers: asUser(uA) })).statusCode).toBe(403);
      denyAll = false;
      expect((await findings(propGsc)).find((f) => f.id === fid)!.status).toBe("open");
    });

    it("cross-company: C's user cannot touch A's property or finding (valid ids), and A's own call works", async () => {
      useRealCerbos = true; // the tenant wall is the real policy decision
      const viaA = await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/acknowledge`, headers: asUser(uC) });
      expect(viaA.statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: base(propGsc), headers: asUser(uC) })).statusCode).toBe(403);
      useRealCerbos = false; // the 404s below are RLS, not the policy tier matrix
      for (const [method, url] of [
        ["GET", `/api/${C}/modules/search/properties/${propGsc}/decay`],
        ["POST", `/api/${C}/modules/search/properties/${propGsc}/decay/${fid}/acknowledge`],
        ["POST", `/api/${C}/modules/search/properties/${propGsc}/decay/${fid}/refresh-brief`],
      ] as const) {
        expect((await app.inject({ method, url, headers: asUser(uC) })).statusCode, `${method} ${url}`).toBe(404);
      }
      expect((await findings(propGsc)).find((f) => f.id === fid)!.status).toBe("open");
      // positive control: the same finding through its own tenant
      const ok = await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/acknowledge`, headers: asUser(uA) });
      expect(ok.statusCode).toBe(201);
    });

    it("acknowledge is gated by update and idempotent; bad and unknown ids are 400 and 404", async () => {
      const again = await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/acknowledge`, headers: asUser(uA) });
      expect(again.statusCode).toBe(201);
      expect(again.json().status).toBe("acknowledged");
      expect(calls).toContainEqual({ kind: "resource_search_property", action: "update", tenantId: A });
      expect((await app.inject({ method: "POST", url: `${base(propGsc)}/not-a-uuid/acknowledge`, headers: asUser(uA) })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `${base(propGsc)}/${newId()}/acknowledge`, headers: asUser(uA) })).statusCode).toBe(404);
    });

    it("file a refresh brief creates one draft brief row, links the finding, and is idempotent", async () => {
      const r = await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/refresh-brief`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      const j = r.json() as { created: boolean; briefId: string; finding: { status: string; briefId: string } };
      expect(j.created).toBe(true);
      expect(j.finding).toMatchObject({ status: "refresh_brief_filed", briefId: j.briefId });
      const brief = await withTenants([A], (c) => c.query<{ topic: string; status: string; drafted_via: string; property_id: string; grounding: { findingId: string } }>(
        `SELECT topic, status, drafted_via, property_id, grounding FROM search_content_briefs WHERE id = $1`, [j.briefId]), S);
      expect(brief.rows[0]).toMatchObject({ topic: "Refresh: /second", status: "draft", drafted_via: "fallback", property_id: propGsc });
      expect(brief.rows[0]!.grounding.findingId).toBe(fid);
      const again = await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/refresh-brief`, headers: asUser(uA) });
      expect(again.json()).toMatchObject({ created: false, briefId: j.briefId });
      const n = await withTenants([A], (c) => c.query(
        `SELECT 1 FROM search_content_briefs WHERE property_id = $1 AND topic = 'Refresh: /second'`, [propGsc]), S);
      expect(n.rows).toHaveLength(1);
      // a brief-filed finding can no longer be acknowledged
      expect((await app.inject({ method: "POST", url: `${base(propGsc)}/${fid}/acknowledge`, headers: asUser(uA) })).statusCode).toBe(409);
    });
  });
});
