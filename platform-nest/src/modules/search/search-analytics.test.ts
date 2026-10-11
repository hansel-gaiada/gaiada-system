// M5-A4 — the analytics BFF route against LIVE Postgres + the real HTTP layer (needs DATABASE_URL_TEST
// and Cerbos env, see platform-nest/CLAUDE.md; skipped without it). Cerbos `check` is mocked but its
// call arguments are captured, so this proves WHICH kind/action gates the route (resource_search_property ·
// read), and that a denial is a 403 with a VALID request (valid property id, valid dates) so validation
// can never pre-empt the authz check.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";

const calls: Array<{ kind: string; action: string; tenantId?: string }> = [];
let denyAll = false;
// The tenant wall IS the Cerbos policy (resource_search_property.yaml: variables.inTenant) plus RLS, so the
// cross-company case must consult the REAL decision; every other case keeps the allow-all stub.
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
const SITE = "11111111-2222-4333-8444-555555555555";
const Q = "from=2026-10-01&to=2026-10-10";

describe.skipIf(!TEST_URL)("M5-A4 · property analytics route", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let propBound: string;
  let propUnbound: string;
  const saved = { base: process.env.UMAMI_BASE_URL, key: process.env.UMAMI_API_KEY };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();
    A = await createCompany("M5A4 Co A", ["search"]);
    C = await createCompany("M5A4 Co C", ["search"]);
    uA = await createUser("m5a4-a@a.test");
    uC = await createUser("m5a4-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    const clientA = await createClient(A, "M5A4 Client");
    app = await buildApp();
    const mk = async (domain: string) => {
      const r = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
        payload: { clientId: clientA, domain, siteUrl: `https://${domain}` },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id as string;
    };
    propBound = await mk("bound.example.com");
    propUnbound = await mk("unbound.example.com");
    await withTenants([A], (c) => c.query(`UPDATE search_properties SET umami_site_id = $1 WHERE id = $2`, [SITE, propBound]), { modules: ["search"] });
  });
  afterAll(async () => {
    process.env.UMAMI_BASE_URL = saved.base;
    process.env.UMAMI_API_KEY = saved.key;
    if (saved.base === undefined) delete process.env.UMAMI_BASE_URL;
    if (saved.key === undefined) delete process.env.UMAMI_API_KEY;
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => { calls.length = 0; denyAll = false; useRealCerbos = false; delete process.env.UMAMI_BASE_URL; delete process.env.UMAMI_API_KEY; });

  it("reports not_configured (never an empty dashboard) when the env is unset, gated by search_property read", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propBound}/analytics/summary?${Q}`, headers: asUser(uA) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: "not_configured", kind: "summary" });
    expect(r.json().data).toBeUndefined();
    expect(calls).toContainEqual({ kind: "resource_search_property", action: "read", tenantId: A });
  });

  it("reports not_bound for a property with no umami_site_id (env set)", async () => {
    process.env.UMAMI_BASE_URL = "http://127.0.0.1:9";
    process.env.UMAMI_API_KEY = "k";
    const r = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propUnbound}/analytics/pages?${Q}`, headers: asUser(uA) });
    expect(r.json()).toMatchObject({ state: "not_bound" });
  });

  it("reports unreachable when Umami does not answer", async () => {
    process.env.UMAMI_BASE_URL = "http://127.0.0.1:9"; // discard port: connection refused
    process.env.UMAMI_API_KEY = "k";
    const r = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propBound}/analytics/summary/range/2026-10-01/2026-10-10`, headers: asUser(uA) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: "unreachable" });
  });

  it("the path-range route (MCP binding) enforces the same checks: unknown kind 404, bad range 400", async () => {
    const u = `/api/${A}/modules/search/properties/${propBound}/analytics`;
    expect((await app.inject({ method: "GET", url: `${u}/nope?${Q}`, headers: asUser(uA) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `${u}/summary?from=bad&to=2026-10-10`, headers: asUser(uA) })).statusCode).toBe(400);
  });

  it("a Cerbos denial is 403 with a VALID request", async () => {
    denyAll = true;
    const r = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propBound}/analytics/summary?${Q}`, headers: asUser(uA) });
    expect(r.statusCode).toBe(403);
  });

  it("cross-company: another company's user cannot read A's property analytics (valid ids and dates)", async () => {
    useRealCerbos = true; // real policy decision: inTenant must refuse C's user on A's path
    // uC is a member of C only: the tenant wall refuses the A-scoped call...
    const viaA = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propBound}/analytics/summary?${Q}`, headers: asUser(uC) });
    expect(viaA.statusCode).toBe(403);
    expect(viaA.json().state).toBeUndefined();
    useRealCerbos = false; // the 404 below is about RLS, not the policy tier matrix
    // ...and through their own tenant, A's property id is invisible under RLS.
    const viaC = await app.inject({ method: "GET", url: `/api/${C}/modules/search/properties/${propBound}/analytics/summary?${Q}`, headers: asUser(uC) });
    expect(viaC.statusCode).toBe(404);
  });
});
