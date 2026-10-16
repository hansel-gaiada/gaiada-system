// DW-10e-1 (BFF §60.2 and §60.11 "A route grants nothing") — ROUTES through ORG-13, over HTTP against real Postgres (RLS on) and
// real Cerbos. A route is a service assignment whose module_key is a routing key (`asset_requests`, `engineering_requests`):
// it records who may send which requests to which department, and it must materialise NOTHING.
//
//   1. creation: the ORG-13 flow accepts a routing key (a platform_admin creates it active; a provider proposes and the target
//      accepts), refuses a division (422 route_unit_not_department) and a lead (422 route_has_no_lead), and requires the target
//      to be the provider's client (422 route_needs_group_client / group_client_ambiguous, detail.targetId), on propose, on a
//      platform_admin create and on relink; the dry run lists nobody (`items: []`, `routeOnly: true`) and marks each target.
//   2. a route grants nothing: after a routing assignment is created, accepted and reconciled with the switch on, no membership,
//      no grant and no claim exists in the target for any person of the provider; `enabledModuleKeys` leaves the key out;
//      `/api/me` serviceScopes is unchanged; `gatherForeignContext` and the provider view ignore it.
//   3. TEETH: the same placed person, the same unit and the same target through a REAL module key DO materialise (membership,
//      grant, module key, scope, foreign context, provider view). Without that control every "nothing" above could be a fixture
//      that placed nobody.
//   4. the unit refresh and the orphan detection still run for a route (unit_name and unit_status stay current).
//   5. accept, suspend, resume and revoke do not check the client; relink does.
//
// Needs the Linux gate (DATABASE_URL_TEST and a Cerbos loaded with the CURRENT policy files). It SKIPS without a database; a skip
// is not a pass. The Redis-driven consumer is not involved: reconciles are driven through the manual endpoints and the exported
// functions, exactly as service-assignments-org7b.test.ts does.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { registerModule, resetModules, enabledModuleKeys } from "../modules/registry";
import { gatherForeignContext, REPORT_JOB_MODULES } from "../modules/reports/fact-job";
import { reportRollups } from "../modules/reports/report-rollups";
import { REQUEST_ROUTE_KEYS } from "../core/request-routes";
import { reconcileProvider, sweepDriftAndOrphans } from "./service-reconciler";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Node = { id: string; name: string; kind: string; assigneeId?: string; children: Node[] };
const dept = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "department", children });
const person = (userId: string, name: string): Node => ({ id: `p-${userId.slice(-8)}`, name, kind: "person", assigneeId: userId, children: [] });

describe.skipIf(!TEST_URL)("DW-10e-1 routes through ORG-13 (HTTP, real Postgres + Cerbos)", () => {
  let app: NestFastifyApplication;
  let P: string; // the provider (the agency)
  let H: string; // the requesting company: P's client
  let T: string; // a company with NO client record at P
  let T2: string; // a company with TWO client records at P
  let providerAdmin: string;
  let targetAdmin: string;
  let exec: string; // platform_admin
  let staffer: string; // a member of P placed in d-creative
  let staffer2: string; // placed in the division dv-ops
  let leadCandidate: string;
  let clientH: string;
  const q = (sql: string, args: unknown[] = []) => adminPool().query(sql, args);

  const treeP = (o: { renamed?: boolean; withOrphan?: boolean } = {}) => ({
    root: {
      id: "root", name: "Route Provider", kind: "company", children: [
        dept("d-creative", "Creatives", [person(staffer, "Staffer One")]),
        dept("d-web", "Web Dev"),
        dept("d-ops", "Ops"),
        dept("d-spare", "Spare"),
        dept("d-ren", o.renamed ? "Renamed Dept" : "Rename Me"),
        ...(o.withOrphan === false ? [] : [dept("d-orph", "Orphan Me")]),
        { id: "dv-ops", name: "Ops Division", kind: "division", children: [person(staffer2, "Staffer Two")] },
      ],
    },
  });
  const putOrg = (o: Parameters<typeof treeP>[0] = {}) =>
    app.inject({ method: "PUT", url: `/api/${P}/org-structure`, headers: asUser(providerAdmin), payload: treeP(o) });

  const create = (by: string, node: string, body: Record<string, unknown>, query = "") =>
    app.inject({ method: "POST", url: `/api/${P}/org-structure/units/${node}/assignments${query}`, headers: asUser(by), payload: body });
  const idOf = (r: { json: () => unknown }) => (r.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
  const reason = (r: { json: () => unknown }) => (r.json() as { reason?: string }).reason;
  const detail = (r: { json: () => unknown }) => (r.json() as { detail?: Record<string, unknown> }).detail;
  const reconcile = (id: string) =>
    app.inject({ method: "POST", url: `/api/${P}/org-structure/assignments/${id}/reconcile`, headers: asUser(exec) });
  const count = async (sql: string, args: unknown[] = []) => Number((await q(sql, args)).rows[0].n);
  const assignmentCount = () => count(`SELECT count(*) AS n FROM service_assignments`);

  /** Everything a route must never create in H for a person of P. */
  async function materialisedInH(userId: string) {
    return {
      memberships: await count(`SELECT count(*) AS n FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`, [H, userId]),
      grants: await count(`SELECT count(*) AS n FROM user_roles WHERE user_id = $1 AND scope_type = 'company' AND scope_id = $2`, [userId, H]),
      claims: await count(`SELECT count(*) AS n FROM service_grant_claims WHERE tenant_id = $1`, [H]),
    };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;

    // A registered control module with its staff and manager roles: the reconciler grants `<module>_staff` (moduleRoleId).
    registerModule({ key: "rt_ctl", migrations: [], permissions: [], customFieldTargets: [], mcpTools: [], rollupProviders: [], uiManifest: [] });
    await createRole("rt_ctl_staff");
    await createRole("rt_ctl_manager");

    P = await createCompany("Route Provider", ["agency"]);
    H = await createCompany("Route Holding", [], P);
    T = await createCompany("Route Hotel", [], P);
    T2 = await createCompany("Route Hotel Two", [], P);

    providerAdmin = await createUser("route-provider-admin@route.test");
    targetAdmin = await createUser("route-target-admin@route.test");
    exec = await createUser("route-exec@route.test");
    staffer = await createUser("route-staffer@route.test");
    staffer2 = await createUser("route-staffer2@route.test");
    leadCandidate = await createUser("route-lead@route.test");
    for (const u of [providerAdmin, staffer, staffer2, leadCandidate]) await addMembership(P, u);
    await addMembership(H, targetAdmin);
    const companyAdmin = await createRole("company_admin");
    await grantRole(providerAdmin, companyAdmin, "company", P);
    await grantRole(targetAdmin, companyAdmin, "company", H);
    await grantRole(exec, await createRole("platform_admin"), "global", null);
    await q(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [P, exec]);

    // P's client records: one linked to H (the holding), none for T, two for T2. A platform operator's link, direct.
    clientH = await createClient(P, "Holding at Provider");
    await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [clientH, H]);
    for (const name of ["Hotel Two A", "Hotel Two B"]) {
      const id = await createClient(P, name);
      await q(`UPDATE clients SET group_company_id = $2 WHERE id = $1`, [id, T2]);
    }

    app = await buildApp();
    expect((await putOrg()).statusCode).toBe(200);
  }, 120_000);
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    resetModules();
  });

  // ── 1 · refusals: nothing is written ────────────────────────────────────────────────────────────────────────────────────
  describe("creation refusals leave nothing behind", () => {
    it("a division answers 422 route_unit_not_department, on a platform_admin create and on a company_admin propose", async () => {
      const before = await assignmentCount();
      for (const by of [exec, providerAdmin]) {
        const r = await create(by, "dv-ops", { targets: [H], module: "asset_requests" });
        expect(r.statusCode, r.body).toBe(422);
        expect(reason(r)).toBe("route_unit_not_department");
      }
      expect(await assignmentCount()).toBe(before);
      expect(await count(`SELECT count(*) AS n FROM org_units WHERE tenant_id = $1 AND node_id = 'dv-ops'`, [P]), "no org_units anchor either").toBe(0);
    });

    it("a lead answers 422 route_has_no_lead (a route has no manager)", async () => {
      const before = await assignmentCount();
      const r = await create(exec, "d-creative", { targets: [H], module: "asset_requests", leadUserId: leadCandidate });
      expect(r.statusCode, r.body).toBe(422);
      expect(reason(r)).toBe("route_has_no_lead");
      expect(await assignmentCount()).toBe(before);
      // ...and an absent or null lead is simply no lead
      const dry = await create(exec, "d-creative", { targets: [H], module: "asset_requests", leadUserId: null }, "?dryRun=1");
      expect(dry.statusCode, dry.body).toBe(200);
    });

    it("a target with NO client record answers 422 route_needs_group_client with detail.targetId, for both creators", async () => {
      const before = await assignmentCount();
      for (const by of [exec, providerAdmin]) {
        const r = await create(by, "d-ops", { targets: [T], module: "asset_requests" });
        expect(r.statusCode, r.body).toBe(422);
        expect(reason(r)).toBe("route_needs_group_client");
        expect(detail(r)).toEqual({ targetId: T });
      }
      expect(await assignmentCount()).toBe(before);
    });

    it("a target with TWO client records answers 422 group_client_ambiguous with detail.targetId", async () => {
      const r = await create(exec, "d-ops", { targets: [T2], module: "engineering_requests" });
      expect(r.statusCode, r.body).toBe(422);
      expect(reason(r)).toBe("group_client_ambiguous");
      expect(detail(r)).toEqual({ targetId: T2 });
    });

    it("one bad target refuses the whole request: the good target gets no route either", async () => {
      const before = await assignmentCount();
      const r = await create(exec, "d-ops", { targets: [H, T], module: "asset_requests" });
      expect(r.statusCode, r.body).toBe(422);
      expect(detail(r)).toEqual({ targetId: T });
      expect(await assignmentCount()).toBe(before);
      expect(await count(`SELECT count(*) AS n FROM service_assignments WHERE module_key = 'asset_requests'`)).toBe(0);
    });

    it("a misspelt routing key is still an unknown module", async () => {
      const r = await create(exec, "d-ops", { targets: [H], module: "asset_request" });
      expect(r.statusCode).toBe(422);
      expect((r.json() as { error: string }).error).toContain("unknown module");
    });

    it("a company with no client of the provider still gets an ordinary module assignment (the client rule is for routes only)", async () => {
      const r = await create(exec, "d-spare", { targets: [T], module: "rt_ctl" });
      expect(r.statusCode, r.body).toBe(201);
      await app.inject({ method: "DELETE", url: `/api/${P}/org-structure/assignments/${idOf(r)}`, headers: asUser(exec) });
    });
  });

  // ── 2 · the dry run ─────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the dry run of a route lists nobody and marks each target", () => {
    it("items is empty, routeOnly is true, and each target is included or says why not", async () => {
      const before = await assignmentCount();
      const r = await create(exec, "d-creative", { targets: [H, T, T2], module: "asset_requests" }, "?dryRun=1");
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as {
        dryRun: boolean; routeOnly?: boolean; items: unknown[]; unit: { nodeId: string; kind: string };
        companies: Array<{ id: string; name?: string; included: boolean; reason?: string }>;
      };
      expect(body.dryRun).toBe(true);
      expect(body.routeOnly).toBe(true);
      expect(body.items).toEqual([]);
      expect(body.unit).toMatchObject({ nodeId: "d-creative", kind: "department" });
      const by = new Map(body.companies.map((c) => [c.id, c]));
      expect(by.get(H)).toMatchObject({ included: true, name: "Route Holding" });
      expect(by.get(T)).toEqual({ id: T, included: false, reason: "no_group_client" });
      expect(by.get(T2)).toEqual({ id: T2, included: false, reason: "group_client_ambiguous" });
      expect(await assignmentCount(), "a dry run writes nothing").toBe(before);
    });

    it("a division answers 422 route_unit_not_department on the dry run too", async () => {
      const r = await create(exec, "dv-ops", { targets: [H], module: "asset_requests" }, "?dryRun=1");
      expect(r.statusCode).toBe(422);
      expect(reason(r)).toBe("route_unit_not_department");
    });

    it("CONTROL: the same unit through a real module lists its placed people and carries no routeOnly", async () => {
      const r = await create(exec, "d-creative", { targets: [H], module: "rt_ctl" }, "?dryRun=1");
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as { routeOnly?: boolean; items: Array<{ userId: string }> };
      expect(body.routeOnly).toBeUndefined();
      expect(body.items.map((i) => i.userId)).toContain(staffer);
    });
  });

  // ── 3 · creation, accept, and a route that grants nothing ───────────────────────────────────────────────────────────────
  describe("a route grants nothing", () => {
    let assetRoute: string;
    let engRoute: string;

    it("a platform_admin creates the asset route active; the provider proposes the engineering route and the target accepts it", async () => {
      const a = await create(exec, "d-creative", { targets: [H], module: "asset_requests" });
      expect(a.statusCode, a.body).toBe(201);
      expect((a.json() as { assignments: Array<{ status: string }> }).assignments[0].status).toBe("active");
      assetRoute = idOf(a);

      const e = await create(providerAdmin, "d-web", { targets: [H], module: "engineering_requests" });
      expect(e.statusCode, e.body).toBe(201);
      expect((e.json() as { assignments: Array<{ status: string }> }).assignments[0].status).toBe("proposed");
      engRoute = idOf(e);
      const acc = await app.inject({ method: "POST", url: `/api/${H}/org-structure/assignments/${engRoute}/accept`, headers: asUser(targetAdmin) });
      expect(acc.statusCode, acc.body).toBe(200);

      const rows = await q(`SELECT id, module_key, status, unit_kind, unit_status FROM service_assignments WHERE id = ANY($1) ORDER BY module_key`, [[assetRoute, engRoute]]);
      expect(rows.rows).toEqual([
        { id: assetRoute, module_key: "asset_requests", status: "active", unit_kind: "department", unit_status: "active" },
        { id: engRoute, module_key: "engineering_requests", status: "active", unit_kind: "department", unit_status: "active" },
      ]);
    });

    it("PREMISE: the person IS placed in the routed unit, so an empty result below is the exclusion, not an empty fixture", async () => {
      expect(await count(`SELECT count(*) AS n FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2 AND unit_node_id = 'd-creative' AND is_primary AND valid_to IS NULL`, [P, staffer])).toBeGreaterThanOrEqual(1);
    });

    it("reconciling (one route, then the whole provider, then the nightly sweep) grants nothing and creates nothing in H", async () => {
      const one = await reconcile(assetRoute);
      expect(one.statusCode, one.body).toBe(200);
      expect(one.json()).toMatchObject({ granted: 0, revoked: 0, orphaned: false, affectedUsers: [] });
      const eng = await reconcile(engRoute);
      expect(eng.json()).toMatchObject({ granted: 0, revoked: 0, affectedUsers: [] });

      const all = await reconcileProvider(P);
      expect(all.length).toBeGreaterThanOrEqual(2);
      for (const res of all) expect(res).toMatchObject({ granted: 0, revoked: 0, affectedUsers: [] });
      const sweep = await sweepDriftAndOrphans();
      expect(sweep.drift).toBe(0);

      expect(await materialisedInH(staffer)).toEqual({ memberships: 0, grants: 0, claims: 0 });
      expect(await materialisedInH(staffer2)).toEqual({ memberships: 0, grants: 0, claims: 0 });
      expect(await count(`SELECT count(*) AS n FROM user_roles WHERE managed_by = ANY($1)`, [[assetRoute, engRoute]])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM service_grant_claims WHERE assignment_id = ANY($1)`, [[assetRoute, engRoute]])).toBe(0);
    });

    it("enabledModuleKeys(H) leaves the routing keys out: a route turns no module on", async () => {
      const keys = await enabledModuleKeys(H);
      for (const key of REQUEST_ROUTE_KEYS) expect(keys).not.toContain(key);
      expect(keys).toEqual([]);
    });

    it("GET /api/me serviceScopes is unchanged for the provider's staff", async () => {
      const me = await app.inject({ method: "GET", url: "/api/me", headers: asUser(staffer) });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { serviceScopes: unknown[] }).serviceScopes).toEqual([]);
    });

    it("gatherForeignContext(H) ignores the route: no foreign membership, no provider stamp", async () => {
      const ctx = await gatherForeignContext(H);
      expect(ctx.memberships).toEqual({});
      expect(ctx.activeProviderUnits.size).toBe(0);
    });

    it("the provider view of P ignores the route even with a fact stamped for P in H", async () => {
      await q(
        `INSERT INTO report_work_facts (tenant_id, fact_date, user_id, unit_node_id, department_node_id, provider_tenant_id, provider_unit_node_id, tasks_completed, origin_site)
         VALUES ($1, '2026-07-10', $2, 'd-creative', 'd-creative', $3, 'd-creative', 1, 'central')`,
        [H, staffer, P],
      );
      const rows = await withTenants([P], (c) => reportRollups.compute(c, P, "2026-07-01:2026-07-31"), { modules: [...REPORT_JOB_MODULES] });
      expect(rows.filter((r) => r.dimensions?.servedTenant !== undefined)).toEqual([]);
    });

    it("no role named <routing key>_staff, _manager or _approver exists", async () => {
      const names = REQUEST_ROUTE_KEYS.flatMap((k) => ["staff", "manager", "approver"].map((s) => `${k}_${s}`));
      expect(await count(`SELECT count(*) AS n FROM roles WHERE name = ANY($1)`, [names])).toBe(0);
    });

    // ── TEETH: the same person, unit and target through a REAL module key DO materialise ────────────────────────────────────
    it("CONTROL: the same unit and target through a real module key materialises everything the route must not", async () => {
      const c = await create(exec, "d-creative", { targets: [H], module: "rt_ctl" });
      expect(c.statusCode, c.body).toBe(201);
      const ctl = idOf(c);
      const res = await reconcile(ctl);
      expect(res.json()).toMatchObject({ granted: 1, orphaned: false });
      expect(await materialisedInH(staffer)).toMatchObject({ memberships: 1, grants: 1 });

      const keys = await enabledModuleKeys(H);
      expect(keys).toContain("rt_ctl");
      for (const key of REQUEST_ROUTE_KEYS) expect(keys).not.toContain(key);

      const me = await app.inject({ method: "GET", url: "/api/me", headers: asUser(staffer) });
      const scopes = (me.json() as { serviceScopes: Array<{ companyId: string; module: string }> }).serviceScopes;
      expect(scopes.map((s) => `${s.companyId}|${s.module}`)).toEqual([`${H}|rt_ctl`]);

      const ctx = await gatherForeignContext(H);
      expect(Object.keys(ctx.memberships)).toContain(staffer);
      expect([...ctx.activeProviderUnits]).toEqual([`${P}|d-creative`]);

      const rows = await withTenants([P], (cl) => reportRollups.compute(cl, P, "2026-07-01:2026-07-31"), { modules: [...REPORT_JOB_MODULES] });
      expect(rows.some((r) => r.dimensions?.servedTenant === H), "the provider view now sees H through the real module edge").toBe(true);
    });
  });

  // ── 4 · the unit refresh and the orphan detection still run for a route ─────────────────────────────────────────────────
  describe("the unit refresh and the orphan detection still run for a route", () => {
    it("a renamed department refreshes unit_name; a removed one is marked orphaned (and nothing is stripped, nothing granted)", async () => {
      const created = await create(exec, "d-ren", { targets: [H], module: "asset_requests" });
      expect(created.statusCode, created.body).toBe(201);
      const id = idOf(created);

      expect((await putOrg({ renamed: true })).statusCode).toBe(200);
      const r1 = await reconcile(id);
      expect(r1.statusCode, r1.body).toBe(200);
      expect((await q(`SELECT unit_name, unit_status FROM service_assignments WHERE id = $1`, [id])).rows[0]).toEqual({ unit_name: "Renamed Dept", unit_status: "active" });

      // remove the node: the route's own unit disappears from the tree
      const orph = await create(exec, "d-orph", { targets: [H], module: "engineering_requests" });
      expect(orph.statusCode, orph.body).toBe(201);
      const orphId = idOf(orph);
      expect((await putOrg({ renamed: true, withOrphan: false })).statusCode).toBe(200);
      const r2 = await reconcile(orphId);
      expect(r2.json()).toMatchObject({ orphaned: true, granted: 0, revoked: 0 });
      expect((await q(`SELECT unit_status FROM service_assignments WHERE id = $1`, [orphId])).rows[0].unit_status).toBe("orphaned");
      expect((await q(`SELECT status FROM org_units WHERE tenant_id = $1 AND node_id = 'd-orph'`, [P])).rows[0].status).toBe("orphaned");
      expect(await putOrg({ renamed: true })).toBeTruthy();
    });
  });

  // ── 5 · accept/suspend/resume/revoke do not check the client; relink does ─────────────────────────────────────────────────
  describe("the client record is checked on creation and relink, not on the rest of the lifecycle", () => {
    it("relink keeps a route on a department and keeps its target a client; the other transitions work without the client", async () => {
      const created = await create(exec, "d-ops", { targets: [H], module: "asset_requests" });
      expect(created.statusCode, created.body).toBe(201);
      const id = idOf(created);
      const relink = (nodeId: string) =>
        app.inject({ method: "PATCH", url: `/api/${P}/org-structure/assignments/${id}`, headers: asUser(exec), payload: { nodeId } });

      const toDivision = await relink("dv-ops");
      expect(toDivision.statusCode, toDivision.body).toBe(422);
      expect(reason(toDivision)).toBe("route_unit_not_department");
      expect((await q(`SELECT unit_kind FROM service_assignments WHERE id = $1`, [id])).rows[0].unit_kind, "nothing written on refusal").toBe("department");

      const ok = await relink("d-spare");
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await q(`SELECT unit_name FROM service_assignments WHERE id = $1`, [id])).rows[0].unit_name).toBe("Spare");

      // H stops being a client of P (the record is deleted)
      await q(`UPDATE clients SET deleted_at = now() WHERE id = $1`, [clientH]);
      try {
        const lost = await relink("d-ops");
        expect(lost.statusCode, lost.body).toBe(422);
        expect(reason(lost)).toBe("route_needs_group_client");
        expect(detail(lost)).toEqual({ targetId: H });
        expect((await q(`SELECT unit_name FROM service_assignments WHERE id = $1`, [id])).rows[0].unit_name).toBe("Spare");

        // a NEW route is refused for the same reason
        const fresh = await create(exec, "d-ops", { targets: [H], module: "engineering_requests" });
        expect(fresh.statusCode).toBe(422);
        expect(reason(fresh)).toBe("route_needs_group_client");

        // suspend, resume and revoke do not look at the client
        for (const [method, path, status] of [["PATCH", "suspend", "suspended"], ["PATCH", "resume", "active"]] as const) {
          const r = await app.inject({ method, url: `/api/${P}/org-structure/assignments/${id}/${path}`, headers: asUser(exec) });
          expect(r.statusCode, `${path}: ${r.body}`).toBe(200);
          expect((await q(`SELECT status FROM service_assignments WHERE id = $1`, [id])).rows[0].status).toBe(status);
        }
        const revoke = await app.inject({ method: "DELETE", url: `/api/${P}/org-structure/assignments/${id}`, headers: asUser(exec) });
        expect(revoke.statusCode, revoke.body).toBe(200);
      } finally {
        await q(`UPDATE clients SET deleted_at = NULL WHERE id = $1`, [clientH]);
      }
    });

    it("a route whose id is a fresh uuid still 404s on accept (the lifecycle routes are unchanged)", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${H}/org-structure/assignments/${newId()}/accept`, headers: asUser(targetAdmin) });
      expect(r.statusCode).toBe(404);
    });
  });
});
