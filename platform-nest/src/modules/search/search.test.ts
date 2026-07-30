// SM-02 — search-marketing module: registration, tool-defs aggregation, the module guard, CRUD
// (properties/engagements/kpi-targets) + tool-scope endpoints/preset-seeding, FK tenant-validation,
// and rollups — against LIVE Postgres (RLS actually exercised, initTestDb) + the real HTTP layer
// (app.inject, exactly like hr.test.ts).
//
// Cerbos: resource_search_property.yaml / resource_search_engagement.yaml are SM-03's job (NOT
// built here — out of scope by design, see search.controller.ts's header comment). Verified against
// the live dev Cerbos instance while building this ticket: with no matching resourcePolicy, EVERY
// call for these two new kinds is EFFECT_DENY, even for platform_admin — Cerbos has no "unmatched
// kind -> allow" fallback. So THIS ticket's tests stub `check()` to always ALLOW, to exercise the
// layers SM-02 actually owns end-to-end: module registration, ModuleEnabledGuard (dark-by-default,
// standard enabled_modules OR active-service_assignment OR-clause), controller wiring, tenant/RLS
// scoping (the real point of "e2e under RLS" — proven at the HTTP layer here, on top of the
// DB-level proof already in db/module-search-rls.test.ts from SM-01), and FK tenant-validation.
// SM-03 lands the real Cerbos policies + the full owner/manager/member/served-dept parity matrix.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules, getModule } from "../registry";
import { searchModule } from "./index";
import { recomputeRollups, syncMetricDefinitions, resetCoreRollupProviders } from "../../rollups/engine";
import { MockSearchProvider } from "./providers/mock-provider";
import { registerProvider, resetProviders } from "./providers/registry";
import { insertLedgerRow } from "./providers/ledger";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function createUnit(provider: string, nodeId: string, name = "SEO", kind = "department"): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,$3,$4,$5)`, [id, provider, nodeId, kind, name]),
  );
  return id;
}

describe.skipIf(!TEST_URL)("search module (SM-02)", () => {
  let app: NestFastifyApplication;
  let A: string; // 'search' in its OWN enabled_modules
  let B: string; // 'search' NOT enabled anywhere — the module-guard 404 probe
  let C: string; // separate tenant with 'search' enabled — cross-tenant isolation probe
  let uA: string;
  let uC: string;
  let clientA: string;
  let clientC: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("Search Co A", ["search"]);
    B = await createCompany("Search Co B (disabled)");
    C = await createCompany("Search Co C", ["search"]);
    uA = await createUser("sm02-a@a.test");
    uC = await createUser("sm02-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "Client of A");
    clientC = await createClient(C, "Client of C");

    app = await buildApp();
  });
  afterAll(async () => {
    // `app` is undefined if beforeAll failed; an unguarded close() would throw here and skip
    // teardownTestDb(), leaking pool sessions that deadlock the NEXT suite's schema drop.
    await app?.close();
    await teardownTestDb();
  });

  it("registers and lists search.* tools on /mcp/tool-defs", async () => {
    expect(getModule("search")).toBe(searchModule);
    const res = await app.inject({ method: "GET", url: "/mcp/tool-defs", headers: svc });
    expect(res.statusCode).toBe(200);
    const defs = res.json() as Array<{ name: string; method?: string; pathTemplate?: string }>;
    const searchDefs = defs.filter((d) => d.name.startsWith("search."));
    expect(searchDefs.length).toBe(18);
    const listEngagements = searchDefs.find((d) => d.name === "search.listEngagements");
    expect(listEngagements?.method).toBe("GET");
    expect(listEngagements?.pathTemplate).toBe("/api/:tenantId/modules/search/engagements");
    // Live mutations always high-impact (design §07/D-6): sample one.
    const applyNegatives = defs.find((d) => d.name === "search.applyNegatives") as { impact?: string; write?: boolean };
    expect(applyNegatives.write).toBe(true);
    expect(applyNegatives.impact).toBe("high");
  });

  it("ModuleEnabledGuard 404s a tenant with 'search' NOT enabled (before Cerbos is ever consulted)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${B}/modules/search/properties`, headers: asUser(uA) });
    expect(res.statusCode).toBe(404);
  });

  it("a served company lights up via an ACTIVE service_assignment (the standard OR-clause), same as every other module", async () => {
    const served = await createCompany("Search Co Served");
    const unitId = await createUnit(A, "d-seo");
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO service_assignments (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, unit_status, created_by)
         VALUES ($1, $2, $3, $4, 'search', 'active', 'SEO', 'department', 'active', $5)`,
        [newId(), unitId, A, served, uA],
      ),
    );
    const res = await app.inject({ method: "GET", url: `/api/${served}/modules/search/properties`, headers: asUser(uA) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  let propertyId: string;
  let engagementId: string;

  it("property CRUD works e2e under RLS", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "example.com", siteUrl: "https://example.com" },
    });
    expect(create.statusCode).toBe(201);
    propertyId = create.json().id as string;

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties`, headers: asUser(uA) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { id: string }[]).map((r) => r.id)).toEqual([propertyId]);

    const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propertyId}`, headers: asUser(uA) });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ domain: "example.com", status: "active" });

    const patch = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/properties/${propertyId}`, headers: asUser(uA),
      payload: { status: "paused" },
    });
    expect(patch.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propertyId}`, headers: asUser(uA) });
    expect(after.json()).toMatchObject({ status: "paused" });

    // Cross-tenant: C cannot see A's property (RLS wall, proven through the real HTTP endpoint).
    const cross = await app.inject({ method: "GET", url: `/api/${C}/modules/search/properties/${propertyId}`, headers: asUser(uC) });
    expect(cross.statusCode).toBe(404);
    const crossList = await app.inject({ method: "GET", url: `/api/${C}/modules/search/properties`, headers: asUser(uC) });
    expect(crossList.json()).toEqual([]);
  });

  it("rejects a property create with a clientId from a DIFFERENT tenant (FK tenant-validation)", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientC, domain: "cross.example.com", siteUrl: "https://cross.example.com" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/clientId not found/);
  });

  it("engagement create seeds tool_scope from the 'standard' preset (design §04)", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "Q3 SEO Engagement", scopePreset: "standard" },
    });
    expect(create.statusCode).toBe(201);
    engagementId = create.json().id as string;

    const scope = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA) });
    expect(scope.statusCode).toBe(200);
    const body = scope.json() as { scopePreset: string; toolScope: Record<string, unknown>; providerBudgetUsd: number };
    expect(body.scopePreset).toBe("standard");
    expect(body.toolScope).toMatchObject({
      rank: { enabled: true, cadence: "weekly", maxKeywords: 50 },
      volume: { enabled: true },
      backlinks: { enabled: false },
      ai_visibility: { enabled: true, cadence: "weekly" },
    });
    expect(body.providerBudgetUsd).toBe(10);
  });

  // Regression guard for a class of bug that bit this module THREE times in one day: the console
  // reads a field the endpoint never selected, gets `undefined`, and renders a confident wrong
  // answer instead of an error. Here the engagement LIST powers a "N of 5 metered tools on" summary
  // per row; without `tool_scope` in the SELECT every row read as "none enabled" — which is exactly
  // the state an operator would then go hunting for in the scope editor. Nothing throws, so only an
  // assertion on the payload shape catches it.
  it("engagement LIST returns tool_scope, so the console's metered-tools summary is not silently 0", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; toolScope?: Record<string, { enabled?: boolean }> }>;
    const row = rows.find((r) => r.id === engagementId);
    expect(row).toBeDefined();
    // Seeded from the 'standard' preset by the test above — the LIST must agree with GET .../scope.
    expect(row!.toolScope).toMatchObject({ rank: { enabled: true }, backlinks: { enabled: false } });
  });

  it("rejects an engagement create where propertyId belongs to a DIFFERENT client in the SAME tenant", async () => {
    const otherClient = await createClient(A, "Other client of A");
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: otherClient, propertyId, name: "Mismatched engagement" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not belong to clientId/);
  });

  it("rejects an engagement create with a propertyId from a DIFFERENT tenant (FK tenant-validation)", async () => {
    const propC = await app.inject({
      method: "POST", url: `/api/${C}/modules/search/properties`, headers: asUser(uC),
      payload: { clientId: clientC, domain: "onlyc.example.com", siteUrl: "https://onlyc.example.com" },
    });
    const propertyIdC = propC.json().id as string;
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId: propertyIdC, name: "Cross-tenant engagement" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/propertyId not found/);
  });

  it("PUT .../scope re-seeds from a different preset, and 'custom' stores the caller's exact shape", async () => {
    const heavy = await app.inject({
      method: "PUT", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA),
      payload: { scopePreset: "heavy" },
    });
    expect(heavy.statusCode).toBe(200);
    const afterHeavy = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA) });
    expect((afterHeavy.json() as { toolScope: Record<string, unknown> }).toolScope).toMatchObject({
      rank: { enabled: true, cadence: "daily", maxKeywords: 200 },
      backlinks: { enabled: true, cadence: "monthly" },
    });

    const custom = await app.inject({
      method: "PUT", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA),
      payload: { scopePreset: "custom", toolScope: { rank: { enabled: true, cadence: "monthly", maxKeywords: 5 } } },
    });
    expect(custom.statusCode).toBe(200);
    const afterCustom = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA) });
    const customBody = afterCustom.json() as { scopePreset: string; toolScope: Record<string, unknown> };
    expect(customBody.scopePreset).toBe("custom");
    expect(customBody.toolScope).toEqual({ rank: { enabled: true, cadence: "monthly", maxKeywords: 5 } });
  });

  it("also updates providerBudgetUsd via the scope endpoint", async () => {
    const res = await app.inject({
      method: "PUT", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA),
      payload: { scopePreset: "custom", providerBudgetUsd: 42.5 },
    });
    expect(res.statusCode).toBe(200);
    const scope = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA) });
    expect((scope.json() as { providerBudgetUsd: number }).providerBudgetUsd).toBe(42.5);
  });

  // SM-04 — the cost-PROJECTION endpoint at the HTTP layer (the choke-point's own arithmetic is
  // proven in providers/dispatch.test.ts; this covers routing, auth, what-if, and the 404/400 edges).
  it("GET .../cost-projection prices the persisted tool_scope and flags an over-budget scope", async () => {
    resetProviders();
    registerProvider(new MockSearchProvider());
    await app.inject({
      method: "PUT", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA),
      payload: { scopePreset: "custom", toolScope: { rank: { enabled: true, cadence: "daily", maxKeywords: 100 } }, providerBudgetUsd: 42.5 },
    });

    const res = await app.inject({
      method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/cost-projection`, headers: asUser(uA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      whatIf: boolean; providerBudgetUsd: number; overBudget: boolean; totalMonthlyUsd: number;
      perTool: Array<{ tool: string; enabled: boolean; projectedMonthlyUsd: number; provider: string | null }>;
    };
    expect(body.whatIf).toBe(false);
    expect(body.providerBudgetUsd).toBe(42.5);
    // mock serp 0.0006/item x 100 items x 30 runs/mo = 1.80
    const rank = body.perTool.find((t) => t.tool === "rank")!;
    expect(rank.enabled).toBe(true);
    expect(rank.projectedMonthlyUsd).toBeCloseTo(1.8, 4);
    expect(rank.provider).toBe("dataforseo");
    expect(body.totalMonthlyUsd).toBeCloseTo(1.8, 4);
    expect(body.overBudget).toBe(false);

    // A heavier what-if scope must be priceable BEFORE it is saved.
    //   rank      200 x 0.0006 x 30 = 3.60
    //   backlinks   1 x 0.02   x 30 = 0.60
    //   volume    500 x 0.00012 x 30 = 1.80   => 6.00/mo
    const heavy = JSON.stringify({
      rank: { enabled: true, cadence: "daily", maxKeywords: 200 },
      backlinks: { enabled: true, cadence: "daily" },
      volume: { enabled: true, cadence: "daily", maxKeywords: 500 },
    });
    const heavyUrl = `/api/${A}/modules/search/engagements/${engagementId}/cost-projection?toolScope=${encodeURIComponent(heavy)}`;
    const whatIf = await app.inject({ method: "GET", url: heavyUrl, headers: asUser(uA) });
    const whatIfBody = whatIf.json() as { whatIf: boolean; overBudget: boolean; totalMonthlyUsd: number };
    expect(whatIfBody.whatIf).toBe(true);
    expect(whatIfBody.totalMonthlyUsd).toBeCloseTo(6.0, 4);
    expect(whatIfBody.overBudget).toBe(false); // still inside the $42.50 cap

    // Drop the cap under that projection and the same scope must now be flagged over-budget —
    // this is the signal that stops a human choosing a scope the stop-loss will refuse mid-month.
    await app.inject({
      method: "PUT", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA),
      payload: { scopePreset: "custom", toolScope: { rank: { enabled: true, cadence: "daily", maxKeywords: 100 } }, providerBudgetUsd: 5 },
    });
    const tight = await app.inject({ method: "GET", url: heavyUrl, headers: asUser(uA) });
    const tightBody = tight.json() as { overBudget: boolean; providerBudgetUsd: number; totalMonthlyUsd: number };
    expect(tightBody.providerBudgetUsd).toBe(5);
    expect(tightBody.totalMonthlyUsd).toBeCloseTo(6.0, 4);
    expect(tightBody.overBudget).toBe(true);

    // ...and the what-if must NOT have persisted anything.
    const after = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/scope`, headers: asUser(uA) });
    expect((after.json() as { toolScope: Record<string, unknown> }).toolScope).toEqual({
      rank: { enabled: true, cadence: "daily", maxKeywords: 100 },
    });
  });

  it("cost-projection 400s malformed toolScope and 404s an unknown engagement", async () => {
    const bad = await app.inject({
      method: "GET", headers: asUser(uA),
      url: `/api/${A}/modules/search/engagements/${engagementId}/cost-projection?toolScope=not-json`,
    });
    expect(bad.statusCode).toBe(400);

    const notArray = await app.inject({
      method: "GET", headers: asUser(uA),
      url: `/api/${A}/modules/search/engagements/${engagementId}/cost-projection?toolScope=${encodeURIComponent("[1,2]")}`,
    });
    expect(notArray.statusCode).toBe(400);

    const missing = await app.inject({
      method: "GET", url: `/api/${A}/modules/search/engagements/${newId()}/cost-projection`, headers: asUser(uA),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("cost-projection is cross-tenant safe — C's engagement is invisible from A", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/${C}/modules/search/engagements/${engagementId}/cost-projection`, headers: asUser(uC),
    });
    expect(res.statusCode).toBe(404);
  });

  // SM-17 — the ledger/cost surface (tracker §6j; addendum §A3). Route-level proof: routing, auth,
  // the empty-state/row-count distinction, per-row provenance, mode-filtered sums, the excluded
  // simulated-history line, 404, and cross-tenant isolation. The arithmetic sumMonthToDate itself
  // performs is already proven in providers/ledger.test.ts — this suite proves the ROUTE composes it
  // correctly, never re-derives it.
  describe("GET .../engagements/:id/ledger (SM-17)", () => {
    let ledgerEngagementId: string;

    it("a fresh engagement with ZERO ledger rows reads as 'no calls recorded', not a $0.00 sum", async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
        payload: { clientId: clientA, propertyId, name: "SM-17 ledger probe" },
      });
      expect(create.statusCode).toBe(201);
      ledgerEngagementId = create.json().id as string;

      const res = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/engagements/${ledgerEngagementId}/ledger`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        engagementId: string; providerMode: string; costToServeUsd: number;
        currentModeRowCount: number; simulatedHistoryExcludedUsd: number | null; rows: unknown[];
      };
      expect(body.engagementId).toBe(ledgerEngagementId);
      expect(body.providerMode).toBe(config.search.providerMode);
      expect(body.currentModeRowCount).toBe(0);
      expect(body.costToServeUsd).toBe(0); // sumMonthToDate's own COALESCE(sum,0) — 0 is a real answer here, the FE decides "no rows" from currentModeRowCount, not from this being falsy
      expect(body.simulatedHistoryExcludedUsd).toBeNull();
      expect(body.rows).toEqual([]);
    });

    it("every row exposes its OWN provider + simulated flag; sums are current-mode only with the other mode surfaced as a separate excluded line", async () => {
      const prevMode = config.search.providerMode;
      try {
        config.search.providerMode = "live";

        // Two REAL rows (one cache hit at cost 0, one billed), plus one SIMULATED row from a
        // dispatch made while the platform ran in simulate mode — a mixed table, on purpose: this is
        // exactly the "historical row keeps its own truth after a mode flip" shape the ticket exists
        // to prove, not a table with only one mode's rows.
        await withTenants(
          [A],
          async (c) => {
            await insertLedgerRow(c, {
              tenantId: A, engagementId: ledgerEngagementId, provider: "dataforseo", endpoint: "serp.google.organic.task_post",
              items: 10, costUsd: 0.006, cacheHit: false, status: "completed", requestedBy: uA, simulated: false,
            });
            await insertLedgerRow(c, {
              tenantId: A, engagementId: ledgerEngagementId, provider: "dataforseo", endpoint: "serp.google.organic.task_post",
              items: 10, costUsd: 0, cacheHit: true, status: "completed", requestedBy: uA, simulated: false,
            });
            await insertLedgerRow(c, {
              tenantId: A, engagementId: ledgerEngagementId, provider: "semrush", endpoint: "keywords.volume",
              items: 5, costUsd: 0.42, cacheHit: false, status: "completed", requestedBy: uA, simulated: true,
            });
          },
          { modules: ["search"] },
        );

        const liveRes = await app.inject({
          method: "GET", url: `/api/${A}/modules/search/engagements/${ledgerEngagementId}/ledger`, headers: asUser(uA),
        });
        expect(liveRes.statusCode).toBe(200);
        const live = liveRes.json() as {
          providerMode: string; costToServeUsd: number; currentModeRowCount: number;
          simulatedHistoryExcludedUsd: number | null;
          rows: Array<{ provider: string; simulated: boolean; costUsd: number; status: string; cacheHit: boolean }>;
        };
        expect(live.providerMode).toBe("live");
        // Current mode (live) = the 2 real rows: 0.006 + 0 = 0.006.
        expect(live.costToServeUsd).toBeCloseTo(0.006, 6);
        expect(live.currentModeRowCount).toBe(2);
        // The 1 simulated row exists — surfaced as its OWN excluded figure, never blended in.
        expect(live.simulatedHistoryExcludedUsd).toBeCloseTo(0.42, 6);
        // ALL 3 rows render, each carrying its OWN provider + simulated — the list is not itself
        // mode-filtered, because a historical row must keep badging its own truth after a mode flip.
        expect(live.rows.length).toBe(3);
        const bySemrush = live.rows.find((r) => r.provider === "semrush");
        expect(bySemrush?.simulated).toBe(true);
        expect(bySemrush?.costUsd).toBeCloseTo(0.42, 6);
        const cacheHitRow = live.rows.find((r) => r.cacheHit === true);
        expect(cacheHitRow).toMatchObject({ provider: "dataforseo", simulated: false, costUsd: 0, status: "completed" });
        const realRows = live.rows.filter((r) => r.provider === "dataforseo");
        expect(realRows.every((r) => r.simulated === false)).toBe(true);

        // Flip the platform mode: the SAME rows now compose the OPPOSITE way — sim mode's sum binds
        // only the 1 simulated row, and the 2 real rows become the excluded "history" line. This is
        // the mode-flip direction that proves the filter is a real predicate, not a fixed label.
        config.search.providerMode = "simulate";
        const simRes = await app.inject({
          method: "GET", url: `/api/${A}/modules/search/engagements/${ledgerEngagementId}/ledger`, headers: asUser(uA),
        });
        const sim = simRes.json() as {
          providerMode: string; costToServeUsd: number; currentModeRowCount: number; simulatedHistoryExcludedUsd: number | null;
        };
        expect(sim.providerMode).toBe("simulate");
        expect(sim.costToServeUsd).toBeCloseTo(0.42, 6);
        expect(sim.currentModeRowCount).toBe(1);
        expect(sim.simulatedHistoryExcludedUsd).toBeCloseTo(0.006, 6);
      } finally {
        config.search.providerMode = prevMode;
      }
    });

    it("status renders verbatim (a 'failed' refusal row is neither dropped nor relabelled)", async () => {
      await withTenants(
        [A],
        (c) => insertLedgerRow(c, {
          tenantId: A, engagementId: ledgerEngagementId, provider: "dataforseo", endpoint: "serp.google.organic.task_post",
          items: 1, costUsd: 0, cacheHit: false, status: "failed", requestedBy: uA, simulated: false,
        }),
        { modules: ["search"] },
      );
      const res = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/engagements/${ledgerEngagementId}/ledger`, headers: asUser(uA),
      });
      const body = res.json() as { rows: Array<{ status: string }> };
      expect(body.rows.some((r) => r.status === "failed")).toBe(true);
    });

    it("404s an unknown engagement", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${A}/modules/search/engagements/${newId()}/ledger`, headers: asUser(uA),
      });
      expect(res.statusCode).toBe(404);
    });

    it("is cross-tenant safe — C cannot read A's engagement ledger", async () => {
      const res = await app.inject({
        method: "GET", url: `/api/${C}/modules/search/engagements/${ledgerEngagementId}/ledger`, headers: asUser(uC),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it("kpi-target CRUD works e2e under RLS and validates the engagementId FK", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/kpi-targets`, headers: asUser(uA),
      payload: { engagementId, metricKey: "organic_sessions", targetValue: 5000, direction: "up" },
    });
    expect(create.statusCode).toBe(201);
    const kpiId = create.json().id as string;

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/kpi-targets?engagementId=${engagementId}`, headers: asUser(uA) });
    expect((list.json() as { id: string }[]).map((r) => r.id)).toEqual([kpiId]);

    const patch = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/kpi-targets/${kpiId}`, headers: asUser(uA),
      payload: { targetValue: 7500 },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({ method: "DELETE", url: `/api/${A}/modules/search/kpi-targets/${kpiId}`, headers: asUser(uA) });
    expect(del.statusCode).toBe(200);
    const afterDelete = await app.inject({ method: "GET", url: `/api/${A}/modules/search/kpi-targets/${kpiId}`, headers: asUser(uA) });
    expect(afterDelete.statusCode).toBe(404);

    // Bogus engagementId from a different tenant -> 400, not a silent cross-tenant write.
    const badFk = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/kpi-targets`, headers: asUser(uA),
      payload: { engagementId: newId(), metricKey: "conversions", targetValue: 10 },
    });
    expect(badFk.statusCode).toBe(400);
  });

  it("engagement soft-delete works and is excluded from subsequent reads", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "Throwaway engagement" },
    });
    const id = create.json().id as string;
    const del = await app.inject({ method: "DELETE", url: `/api/${A}/modules/search/engagements/${id}`, headers: asUser(uA) });
    expect(del.statusCode).toBe(200);
    const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${id}`, headers: asUser(uA) });
    expect(get.statusCode).toBe(404);
  });

  it("search.engagements.active rollup reflects the live engagement created above", async () => {
    // Engagements default to status='draft' (0034); flip the one from the earlier test to 'active'
    // so this metric — which counts status='active' — has something real to count.
    const activate = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/engagements/${engagementId}`, headers: asUser(uA),
      payload: { status: "active" },
    });
    expect(activate.statusCode).toBe(200);

    const period = new Date().toISOString().slice(0, 10);
    await recomputeRollups(A, period);
    const rows = await withTenants([A], (c) =>
      c.query<{ numerator: string }>(
        `SELECT numerator FROM rollup_metrics WHERE tenant_id = $1 AND module = 'search' AND metric_key = 'search.engagements.active' AND period = $2`,
        [A, period],
      ),
    );
    expect(Number(rows.rows[0]?.numerator ?? 0)).toBeGreaterThanOrEqual(1);
  });

  // SM-46a (design addendum §A4.7 enumeration) — the exec-facing search.rank.top10 rollup must be
  // mode-filtered, proven in BOTH directions on a MIXED search_rank_snapshots table: sim mode counts
  // only simulated rows, live mode only real rows. Asserting only one direction misses the fail-open
  // half (the same class as §4d).
  it("SM-46a: search.rank.top10 rollup is mode-filtered on a MIXED search_rank_snapshots table", async () => {
    const prevMode = config.search.providerMode;
    try {
      const setRow = await withTenants(
        [A],
        (c) => c.query<{ id: string }>(
          `INSERT INTO search_keyword_sets (tenant_id, engagement_id, name) VALUES ($1,$2,'SM-46a rollup probe') RETURNING id`,
          [A, engagementId],
        ),
        { modules: ["search"] },
      );
      const setId = setRow.rows[0].id;
      const kw = await withTenants(
        [A],
        (c) => c.query<{ id: string }>(
          `INSERT INTO search_keywords (tenant_id, set_id, keyword, locale)
           VALUES ($1,$2,'sm46a probe one','en-US'), ($1,$2,'sm46a probe two','en-US')
           RETURNING id`,
          [A, setId],
        ),
        { modules: ["search"] },
      );
      const [kw1, kw2] = kw.rows.map((r) => r.id);

      // Mixed table: 2 simulated top-10 rows + 1 real top-10 row (different engine, so it does not
      // collapse under the query's own DISTINCT ON keyword_id/engine/device) + 1 real NOT-top-10 row.
      await withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO search_rank_snapshots (tenant_id, property_id, keyword_id, engine, device, position, simulated)
           VALUES
             ($1,$2,$3,'google','desktop',2,true),
             ($1,$2,$4,'google','desktop',4,true),
             ($1,$2,$3,'bing','desktop',9,false),
             ($1,$2,$4,'google','mobile',55,false)`,
          [A, propertyId, kw1, kw2],
        ),
        { modules: ["search"] },
      );

      const period = new Date().toISOString().slice(0, 10);

      config.search.providerMode = "simulate";
      await recomputeRollups(A, period);
      const simRows = await withTenants([A], (c) =>
        c.query<{ numerator: string }>(
          `SELECT numerator FROM rollup_metrics WHERE tenant_id = $1 AND module = 'search' AND metric_key = 'search.rank.top10' AND period = $2`,
          [A, period],
        ),
      );
      expect(Number(simRows.rows[0]?.numerator ?? 0)).toBe(2);

      config.search.providerMode = "live";
      await recomputeRollups(A, period);
      const liveRows = await withTenants([A], (c) =>
        c.query<{ numerator: string }>(
          `SELECT numerator FROM rollup_metrics WHERE tenant_id = $1 AND module = 'search' AND metric_key = 'search.rank.top10' AND period = $2`,
          [A, period],
        ),
      );
      expect(Number(liveRows.rows[0]?.numerator ?? 0)).toBe(1);
    } finally {
      config.search.providerMode = prevMode;
    }
  });
});
