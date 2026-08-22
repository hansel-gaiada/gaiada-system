// ORG-14 — PRE-FLAG adversarial gate. The go/no-go safety audit over the WHOLE integrated
// shared-service surface, driven through the REAL endpoints (buildApp + app.inject) plus the
// reconciler, across A/B/C RLS sessions. This suite deliberately goes BEYOND
// service-reconciler-adversarial.test.ts (reconciler internals) and hr.test.ts (happy path):
// it hunts leaks at the INTEGRATION SEAMS where per-ticket tests don't look — the endpoint,
// read fan-out, envelope, serviceScopes, member/approval origin attr, and session invalidation —
// with SERVICE_ASSIGNMENTS_ENABLED=1 (the about-to-ship state).
//
// Needs DATABASE_URL_TEST + CERBOS_URL + REDIS_URL_TEST (disposable services; skips otherwise).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withGlobal, withTenants, newId } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { registerModule, resetModules, getModule } from "../modules/registry";
import { hrModule } from "../modules/hr";
import { syncMetricDefinitions, resetCoreRollupProviders } from "../rollups/engine";
import { setRedis, closeRedis } from "../events/redis";
import { reconcileAssignment } from "./service-reconciler";
import { assemblePrincipal } from "../rbac/principal";
import { check } from "../rbac/cerbos";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const RUN = !!(TEST_URL && REDIS_TEST_URL);

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface Node { id: string; name: string; kind: string; assigneeId?: string | null; children?: Node[]; }

async function setBlob(tenant: string, root: Node): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'main')
       ON CONFLICT (tenant_id) DO UPDATE SET structure=$2, updated_at=now()`,
      [tenant, JSON.stringify({ root })],
    ),
  );
}
async function createUnit(provider: string, nodeId: string, name = "HR", kind = "department"): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,$3,$4,$5)`, [id, provider, nodeId, kind, name]),
  );
  return id;
}
async function createActiveAssignment(unitId: string, provider: string, target: string, createdBy: string, lead: string | null): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(
      `INSERT INTO service_assignments
         (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, lead_user_id,
          unit_name, unit_kind, unit_status, created_by, accepted_at)
       VALUES ($1,$2,$3,$4,'hr','active',$5,'HR','department','active',$6, now())`,
      [id, unitId, provider, target, lead, createdBy],
    ),
  );
  return id;
}
async function setStatus(provider: string, id: string, status: string): Promise<void> {
  await withTenants([provider], (c) => c.query(`UPDATE service_assignments SET status=$2 WHERE id=$1`, [id, status]));
}
async function grantsFor(userId: string, target: string): Promise<{ role: string; managed: boolean }[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ role: string; managed_by: string | null }>(
      `SELECT r.name AS role, ur.managed_by FROM user_roles ur JOIN roles r ON r.id=ur.role_id
       WHERE ur.user_id=$1 AND ur.scope_type='company' AND ur.scope_id=$2 ORDER BY r.name`,
      [userId, target],
    ),
  );
  return rows.map((r) => ({ role: r.role, managed: r.managed_by !== null }));
}
async function claimCount(assignmentId: string, target: string): Promise<number> {
  // service_grant_claims is FORCE-RLS on tenant_id — MUST read under the target's tenant scope,
  // never withGlobal (which sets no app.current_tenant_ids and would always see zero rows).
  const { rows } = await withTenants([target], (c) =>
    c.query<{ n: number }>(`SELECT count(*)::int n FROM service_grant_claims WHERE assignment_id=$1`, [assignmentId]),
  );
  return rows[0].n;
}
async function sessionVersion(userId: string): Promise<number> {
  const { rows } = await withGlobal((c) => c.query<{ v: number }>(`SELECT session_version v FROM users WHERE id=$1`, [userId]));
  return rows[0].v;
}
async function hrCaseRowsAs(tenant: string): Promise<{ id: string; tenant_id: string }[]> {
  const { rows } = await withTenants([tenant], (c) =>
    c.query<{ id: string; tenant_id: string }>(`SELECT id, tenant_id FROM hr_cases WHERE deleted_at IS NULL`),
    { modules: ["hr"] },
  );
  return rows;
}

describe.skipIf(!RUN)("ORG-14 pre-flag adversarial gate", () => {
  let app: NestFastifyApplication;
  let redis: Redis;
  let H: string;
  let exec: string; // platform_admin (global) — proposes auto-active / reconciles

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    resetModules();
    resetCoreRollupProviders();
    registerModule(hrModule);
    await syncMetricDefinitions();
    expect(getModule("hr")).toBe(hrModule);

    H = await createCompany("ORG14 Holding");
    exec = await createUser("org14-exec@holding.test");
    const ge = await createRole("platform_admin");
    await grantRole(exec, ge, "global", null);
    // MON-00c: a GLOBAL platform_admin grant carries no membership, so no root resolves and
    // `variables.inRoot` was false — denying the exec on its own rules. Anchored via
    // home_company_id, not a membership, so the exec does not join the companies under assertion.
    await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [H, exec]);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await closeRedis();
    await teardownTestDb();
  });

  // A fresh provider/target pair in the holding, staff placed in the provider's HR unit.
  async function scenario(prefix: string) {
    const A = await createCompany(`${prefix}-A-provider`, [], H);
    const B = await createCompany(`${prefix}-B-target`, [], H);
    const uMgr = await createUser(`${prefix}-mgr@a.test`);
    const uStf = await createUser(`${prefix}-stf@a.test`);
    await addMembership(A, uMgr);
    await addMembership(A, uStf);
    await setBlob(A, {
      id: "root", name: prefix, kind: "company",
      children: [{
        id: "d-hr", name: "HR", kind: "department",
        children: [
          { id: "r-lead", name: "Lead", kind: "role", children: [{ id: "p1", name: "Mgr", kind: "person", assigneeId: uMgr }] },
          { id: "p2", name: "Stf", kind: "person", assigneeId: uStf },
        ],
      }],
    });
    const unitId = await createUnit(A, "d-hr");
    return { A, B, uMgr, uStf, unitId };
  }

  // ───────────────────────── TARGET 1 — FULL-FLOW NO-LEAK ─────────────────────────
  it("T1 full flow (propose→accept→reconcile→act) isolates B; C & provider A see nothing; B-scoped principal cannot reach C by ANY seam", async () => {
    // Provider A serves B; a SEPARATE company C runs its own HR with its own data.
    const A = await createCompany("t1-A", [], H);
    const B = await createCompany("t1-B", [], H);
    const C = await createCompany("t1-C", ["hr"], H); // C enables hr itself (not served by A)
    const aAdmin = await createUser("t1-aadmin@a.test");
    const bAdmin = await createUser("t1-badmin@b.test");
    const cAdmin = await createUser("t1-cadmin@c.test");
    const uStf = await createUser("t1-stf@a.test");
    const bEmp = await createUser("t1-emp@b.test");
    const cEmp = await createUser("t1-emp@c.test");
    const caRole = await createRole("company_admin");
    await addMembership(A, aAdmin); await grantRole(aAdmin, caRole, "company", A);
    await addMembership(B, bAdmin); await grantRole(bAdmin, caRole, "company", B);
    await addMembership(C, cAdmin); await grantRole(cAdmin, caRole, "company", C);
    await addMembership(A, uStf);
    await addMembership(B, bEmp);
    await addMembership(C, cEmp);
    await setBlob(A, {
      id: "root", name: "t1", kind: "company",
      children: [{ id: "d-hr", name: "HR", kind: "department", children: [{ id: "p2", name: "Stf", kind: "person", assigneeId: uStf }] }],
    });

    // C creates its OWN HR case (the row a B-scoped principal must never reach).
    const cCase = await app.inject({ method: "POST", url: `/api/${C}/modules/hr/cases`, headers: asUser(cAdmin), payload: { subjectUserId: cEmp, kind: "review", title: "C-only review" } });
    expect(cCase.statusCode).toBe(201);
    const cCaseId = cCase.json().id as string;

    // (1) PROPOSE (A admin) → status proposed.
    const proposed = await app.inject({ method: "POST", url: `/api/${A}/org-structure/units/d-hr/assignments`, headers: asUser(aAdmin), payload: { targets: [B], module: "hr" } });
    expect(proposed.statusCode).toBe(201);
    const asg = proposed.json().assignments[0].id as string;
    expect(proposed.json().assignments[0].status).toBe("proposed");

    // (2) ACCEPT (B admin) → active.
    const accepted = await app.inject({ method: "POST", url: `/api/${B}/org-structure/assignments/${asg}/accept`, headers: asUser(bAdmin) });
    expect(accepted.statusCode).toBe(200);

    // (3) RECONCILE via the real endpoint (global actor) → grants materialize.
    const rec = await app.inject({ method: "POST", url: `/api/${A}/org-structure/assignments/${asg}/reconcile`, headers: asUser(exec) });
    expect(rec.statusCode).toBe(200);
    expect(rec.json().granted).toBe(1);
    expect(await grantsFor(uStf, B)).toEqual([{ role: "hr_staff", managed: true }]);

    // (4) hr_staff ACTS on B's HR via the real endpoints.
    const mk = await app.inject({ method: "POST", url: `/api/${B}/modules/hr/cases`, headers: asUser(uStf), payload: { subjectUserId: bEmp, kind: "onboarding", title: "B onboarding" } });
    expect(mk.statusCode).toBe(201);
    const bCaseId = mk.json().id as string;
    const bList = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(uStf) });
    expect(bList.statusCode).toBe(200);
    expect((bList.json() as unknown[]).length).toBe(1);
    expect((bList.json() as { id: string }[])[0].id).toBe(bCaseId);

    // ═══ ISOLATION UNDER RLS SESSIONS: only B's row visible from B; C's row only from C; A none. ═══
    const asB = await hrCaseRowsAs(B);
    expect(asB.map((r) => r.id)).toEqual([bCaseId]);
    expect(asB.every((r) => r.tenant_id === B)).toBe(true);
    const asC = await hrCaseRowsAs(C);
    expect(asC.map((r) => r.id)).toEqual([cCaseId]);
    const asA = await hrCaseRowsAs(A);
    expect(asA).toEqual([]); // provider A holds NO hr rows (data never re-homes to the provider)

    // provider A membership for uStf is untouched (employee, unmanaged) — never flipped to service.
    const mA = await withTenants([A], (c) => c.query<{ kind: string; managed_by: string | null }>(`SELECT kind, managed_by FROM company_memberships WHERE tenant_id=$1 AND user_id=$2`, [A, uStf]));
    expect(mA.rows[0]).toMatchObject({ kind: "employee", managed_by: null });

    // ═══ B-SCOPED PRINCIPAL CANNOT REACH C — EVERY SEAM ═══
    // Seam (a) endpoint: u_staff (hr_staff@B) → C's HR cases: 403 (Cerbos wall, module gate open on C).
    const seamEndpoint = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases`, headers: asUser(uStf) });
    expect(seamEndpoint.statusCode).toBe(403);
    // Seam (a') direct-id fetch of C's actual case id via B principal on C path: still 403 (never 200/404-leak of content).
    const seamById = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases/${cCaseId}`, headers: asUser(uStf) });
    expect(seamById.statusCode).toBe(403);
    // Seam (b) read fan-out: assignments served-view widened to C → C excluded, NO C rows in items.
    const fan = await app.inject({ method: "GET", url: `/api/${B}/org-structure/assignments?direction=served&companyIds=${C}&module=hr`, headers: asUser(uStf) });
    expect(fan.statusCode).toBe(200);
    const fanBody = fan.json() as { items: { targetTenantId: string }[]; companies: { id: string; included: boolean }[] };
    expect(fanBody.items.every((i) => i.targetTenantId !== C)).toBe(true);
    expect(fanBody.companies.find((c) => c.id === C)?.included).toBe(false);
    // Seam (c) envelope/serviceScopes in /api/me: only B, never C.
    const me = await app.inject({ method: "GET", url: `/api/me`, headers: asUser(uStf) });
    const scopes = (me.json() as { serviceScopes: { companyId: string }[] }).serviceScopes;
    expect(scopes.map((s) => s.companyId)).toEqual([B]);
    // Seam (d) members directory forge against C: 403 (see also T6).
    const mem = await app.inject({ method: "GET", url: `/api/${C}/members?module=hr`, headers: asUser(uStf) });
    expect(mem.statusCode).toBe(403);
    // Seam (e) MCP tool path: hr.listCases resolves to GET /api/:t/modules/hr/cases with the SAME
    // OBO principal → identical authorize()+RLS gate as seam (a). Proven equivalent here by driving
    // the exact pathTemplate the hub aggregates.
    const listCasesTool = (hrModule.mcpTools ?? []).find((t) => t.name === "hr.listCases");
    if (!listCasesTool?.pathTemplate) throw new Error("hr.listCases tool/pathTemplate missing");
    const toolPath = listCasesTool.pathTemplate.replace(":tenantId", C);
    const seamMcp = await app.inject({ method: "GET", url: toolPath, headers: asUser(uStf) });
    expect(seamMcp.statusCode).toBe(403);
  });

  // ───────────────────────── TARGET 2 — REVOKE RACE (ORG-6 class) ─────────────────────────
  it("T2 revoke while an HR request is in flight: access drops, no orphaned grant/claim survives", async () => {
    const s = await scenario("t2");
    const asg = await createActiveAssignment(s.unitId, s.A, s.B, exec, s.uMgr);
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.uStf, s.B)).toEqual([{ role: "hr_staff", managed: true }]);
    expect(await grantsFor(s.uMgr, s.B)).toEqual([{ role: "hr_manager", managed: true }]);

    // Interleave: flip to revoked, then fire an HR read (in-flight consumer) AND the reconcile
    // concurrently. Final state must be fully torn down — never a grant with zero claims.
    await setStatus(s.A, asg, "revoked");
    await Promise.all([
      reconcileAssignment(asg, s.A),
      app.inject({ method: "GET", url: `/api/${s.B}/modules/hr/cases`, headers: asUser(s.uStf) }),
      reconcileAssignment(asg, s.A), // duplicate redelivery
    ]);

    expect(await grantsFor(s.uStf, s.B)).toEqual([]);
    expect(await grantsFor(s.uMgr, s.B)).toEqual([]);
    expect(await claimCount(asg, s.B)).toBe(0);
    // Enablement wall closes: B's HR routes 404 again for the (now ungranted) staffer.
    const after = await app.inject({ method: "GET", url: `/api/${s.B}/modules/hr/cases`, headers: asUser(s.uStf) });
    expect(after.statusCode).toBe(404);
  });

  // ───────────────────────── TARGET 3 — WALL INDEPENDENCE ─────────────────────────
  it("T3a app.scopes GUC unset → hr rows invisible even to a correctly-granted tenant set", async () => {
    const s = await scenario("t3a");
    const asg = await createActiveAssignment(s.unitId, s.A, s.B, exec, s.uMgr);
    await reconcileAssignment(asg, s.A);
    // Seed a row WITH the hr scope, then attempt to read WITHOUT declaring the module scope.
    await withTenants([s.B], (c) => c.query(`INSERT INTO hr_cases (id, tenant_id, subject_user_id, kind, title, created_by, origin_site) VALUES (gen_random_uuid(),$1,$2,'other','x',$3,'main')`, [s.B, s.uStf, exec]), { modules: ["hr"] });
    const withScope = await withTenants([s.B], (c) => c.query(`SELECT count(*)::int n FROM hr_cases WHERE tenant_id=$1`, [s.B]), { modules: ["hr"] });
    expect((withScope.rows[0] as { n: number }).n).toBe(1);
    const noScope = await withTenants([s.B], (c) => c.query(`SELECT count(*)::int n FROM hr_cases WHERE tenant_id=$1`, [s.B])); // NO {modules:['hr']}
    expect((noScope.rows[0] as { n: number }).n).toBe(0); // third wall (app_module_allowed) holds alone
  });

  it("T3b Cerbos denies cross-company HR even with the RLS wall open (walls are independent)", async () => {
    const s = await scenario("t3b");
    const asg = await createActiveAssignment(s.unitId, s.A, s.B, exec, s.uMgr);
    await reconcileAssignment(asg, s.A);
    // Assemble uStf's real principal (hr_staff@B). Cerbos must ALLOW hr_case read on B but DENY on
    // a foreign tenant C — even though, hypothetically, a mis-set RLS scope could open C's rows.
    const foreignC = await createCompany("t3b-C", ["hr"], H);
    const p = (await assemblePrincipal(s.uStf, "high"))!;
    expect(p.companies).toContain(s.B);
    const allowB = await check(p, { kind: "hr_case", tenantId: s.B, module: "hr" }, "read");
    expect(allowB.allow).toBe(true);
    const denyC = await check(p, { kind: "hr_case", tenantId: foreignC, module: "hr" }, "read");
    expect(denyC.allow).toBe(false); // Cerbos wall independent of RLS: grant scoped to B, not C
    // And an hr scope WITHOUT the module attr also denies (module_staff self-gates on module!="").
    const denyNoModule = await check(p, { kind: "hr_case", tenantId: s.B }, "read");
    expect(denyNoModule.allow).toBe(false);
  });

  // ───────────────────────── TARGET 4 — A14 BOTH PATHS ─────────────────────────
  it("T4 role-assign AND invite-user collisions each adopt the managed artifact; later revoke does NOT delete it", async () => {
    const s = await scenario("t4");
    // give uStf a KNOWN email for the invite path
    const stfEmail = "t4-stf@a.test";
    const asg = await createActiveAssignment(s.unitId, s.A, s.B, exec, s.uMgr);
    await reconcileAssignment(asg, s.A);
    const caRole = await createRole("company_admin");
    const bAdmin = await createUser("t4-badmin@b.test");
    await addMembership(s.B, bAdmin); await grantRole(bAdmin, caRole, "company", s.B);

    // (path 1) ROLE-ASSIGN collision on uMgr's managed hr_manager grant → adopt to manual.
    const hrMgr = (await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name='hr_manager'`))).rows[0].id;
    const assign = await app.inject({ method: "POST", url: `/api/${s.B}/users/${s.uMgr}/roles`, headers: asUser(bAdmin), payload: { roleId: hrMgr, scopeType: "company", scopeId: s.B } });
    expect(assign.statusCode).toBe(201);
    // adopted: managed_by cleared, no claim references it anymore.
    expect(await grantsFor(s.uMgr, s.B)).toEqual([{ role: "hr_manager", managed: false }]);
    const mgrClaims = await withTenants([s.B], (c) => c.query<{ n: number }>(`SELECT count(*)::int n FROM service_grant_claims sgc JOIN user_roles ur ON ur.id=sgc.user_role_id WHERE ur.user_id=$1`, [s.uMgr]));
    expect((mgrClaims.rows[0] as { n: number }).n).toBe(0);

    // (path 2) INVITE collision on uStf's managed 'service' membership → adopt to employee.
    const invite = await app.inject({ method: "POST", url: `/api/${s.B}/users`, headers: asUser(bAdmin), payload: { name: "Stf", email: stfEmail } });
    expect(invite.statusCode).toBe(201);
    expect(invite.json().id).toBe(s.uStf); // reused by email
    const memAdopted = await withTenants([s.B], (c) => c.query<{ kind: string; managed_by: string | null }>(`SELECT kind, managed_by FROM company_memberships WHERE tenant_id=$1 AND user_id=$2`, [s.B, s.uStf]));
    expect(memAdopted.rows[0]).toMatchObject({ kind: "employee", managed_by: null });

    // Now REVOKE the owning assignment + reconcile. The adopted artifacts MUST survive (desync attempt).
    await setStatus(s.A, asg, "revoked");
    await reconcileAssignment(asg, s.A);
    // uMgr's adopted grant survives (manual now); uStf's adopted membership survives as employee.
    expect(await grantsFor(s.uMgr, s.B)).toEqual([{ role: "hr_manager", managed: false }]);
    expect(memAdopted.rows[0]).toMatchObject({ kind: "employee" });
    const memAfter = await withTenants([s.B], (c) => c.query<{ kind: string; status: string; deleted_at: string | null }>(`SELECT kind, status, deleted_at FROM company_memberships WHERE tenant_id=$1 AND user_id=$2`, [s.B, s.uStf]));
    expect(memAfter.rows[0]).toMatchObject({ kind: "employee", status: "active", deleted_at: null });
    // The NON-adopted managed artifacts (uStf's grant) are correctly torn down.
    expect(await grantsFor(s.uStf, s.B)).toEqual([]);
    expect(await claimCount(asg, s.B)).toBe(0);
  });

  // ───────────────────────── TARGET 5 — ENVELOPE HONESTY ─────────────────────────
  it("T5 served/ALL fan-out tags hidden companies included:false, never drops silently, never leaks their rows", async () => {
    const s = await scenario("t5");
    const asg = await createActiveAssignment(s.unitId, s.A, s.B, exec, s.uMgr);
    await reconcileAssignment(asg, s.A);
    const caRole = await createRole("company_admin");
    const bAdmin = await createUser("t5-badmin@b.test");
    await addMembership(s.B, bAdmin); await grantRole(bAdmin, caRole, "company", s.B);
    // A company the caller genuinely can't see + a foreign-holding company.
    const hidden = await createCompany("t5-hidden", [], H);
    const foreignHolding = await createCompany("t5-foreign-holding");
    const foreignCo = await createCompany("t5-foreign-co", [], foreignHolding);

    const r = await app.inject({ method: "GET", url: `/api/${s.B}/org-structure/assignments?companyIds=${hidden},${foreignCo}`, headers: asUser(bAdmin) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { items: { providerTenantId: string; targetTenantId: string }[]; companies: { id: string; included: boolean; reason?: string; name?: string }[] };
    // hidden + foreign are present as included:false (NEVER silently dropped).
    for (const id of [hidden, foreignCo]) {
      const entry = body.companies.find((c) => c.id === id);
      expect(entry).toBeDefined();
      expect(entry!.included).toBe(false);
      expect(entry!.reason).toBe("no_access");
      // F1 (ORG-14 hardening): an excluded company must carry NO display name — {id,included:false,
      // reason} only. A resolved name here would be a cross-holding UUID->name oracle.
      expect(entry!.name).toBeUndefined();
    }
    // No row belonging to the hidden/foreign companies leaks into items.
    for (const it of body.items) {
      expect([hidden, foreignCo]).not.toContain(it.providerTenantId);
      expect([hidden, foreignCo]).not.toContain(it.targetTenantId);
    }
  });

  // ───────────────────────── TARGET 6 — ORIGIN-FORGE ─────────────────────────
  it("T6 client-supplied module/origin cannot forge elevated visibility (attr binds to the held grant / row)", async () => {
    const s = await scenario("t6");
    const asg = await createActiveAssignment(s.unitId, s.A, s.B, exec, s.uMgr);
    await reconcileAssignment(asg, s.A);
    // A totally separate company C where uStf holds NOTHING.
    const C = await createCompany("t6-C", ["hr"], H);

    // (a) members?module=hr forge against C (no grant there) → 403 (module_staff needs the C-scoped grant).
    const memC = await app.inject({ method: "GET", url: `/api/${C}/members?module=hr`, headers: asUser(s.uStf) });
    expect(memC.statusCode).toBe(403);
    // members?module=hr against B (their served co) DOES work — the grant, not the attr, is the gate.
    const memB = await app.inject({ method: "GET", url: `/api/${s.B}/members?module=hr`, headers: asUser(s.uStf) });
    expect(memB.statusCode).toBe(200);

    // (b) automation-approvals?origin=hr forge by a plain hr_staff (NOT hr_manager) → 403.
    const apprForge = await app.inject({ method: "GET", url: `/api/${s.B}/automation-approvals?origin=hr`, headers: asUser(s.uStf) });
    expect(apprForge.statusCode).toBe(403); // module_manager rule needs hr_manager; staff has none
    // the unit MANAGER (hr_manager@B) legitimately can read the hr slice.
    const apprMgr = await app.inject({ method: "GET", url: `/api/${s.B}/automation-approvals?origin=hr`, headers: asUser(s.uMgr) });
    expect(apprMgr.statusCode).toBe(200);

    // (c) decide: module is ROW-derived. A non-hr approval cannot be decided by an hr_manager even
    //     if they try — module stays "" for a non-hr row, so module_manager never matches. Create a
    //     plain automation-origin approval and have the hr_manager attempt to decide it.
    const caRole = await createRole("company_admin");
    const bAdmin = await createUser("t6-badmin@b.test");
    await addMembership(s.B, bAdmin); await grantRole(bAdmin, caRole, "company", s.B);
    const appr = await app.inject({ method: "POST", url: `/api/${s.B}/automation-approvals`, headers: asUser(bAdmin), payload: { workflowId: "wf1", toolName: "some.write", impact: "medium", origin: "automation" } });
    expect(appr.statusCode).toBe(201);
    const apprId = appr.json().id as string;
    const decideForge = await app.inject({ method: "POST", url: `/api/${s.B}/automation-approvals/${apprId}/decide`, headers: asUser(s.uMgr), payload: { decision: "approved" } });
    expect(decideForge.statusCode).toBe(403); // hr_manager cannot decide a non-hr (module="") approval
  });

  // ───────────────────────── TARGET 7 — session_version / revocation ─────────────────────────
  it("T7 revoked HR access bumps session_version (cached-principal invalidation) and endpoint denies the stale principal", async () => {
    const s = await scenario("t7");
    const asg = await createActiveAssignment(s.unitId, s.A, s.B, exec, s.uMgr);
    const before = await sessionVersion(s.uStf);
    await reconcileAssignment(asg, s.A);
    const afterGrant = await sessionVersion(s.uStf);
    expect(afterGrant).toBe(before + 1);

    // A principal captured while access was live (the "cached" principal).
    const cached = (await assemblePrincipal(s.uStf, "high"))!;

    await setStatus(s.A, asg, "revoked");
    await reconcileAssignment(asg, s.A);
    expect(await sessionVersion(s.uStf)).toBe(afterGrant + 1); // revoke bumped it again

    // The cached principal's HR write is now rejected at the endpoint (grant gone AND session stale).
    const stale = await app.inject({ method: "POST", url: `/api/${s.B}/modules/hr/cases`, headers: asUser(s.uStf), payload: { subjectUserId: s.uStf, kind: "other", title: "x" } });
    expect([403, 404]).toContain(stale.statusCode); // module gate closed (404) — access fully cut
    // And the D11 mechanism itself: the cached sessionVersion no longer matches live.
    const live = await sessionVersion(s.uStf);
    expect(cached.sessionVersion).not.toBe(live);
  });
});
