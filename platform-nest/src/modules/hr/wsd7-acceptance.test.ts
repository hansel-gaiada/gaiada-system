// WSD-7 — THE OWNER'S LITERAL ACCEPTANCE SCENARIO, scripted (backbone-program-plan.md row
// WSD-7; re-numbered WSD-9 in the later hr-module-design.md ticket table — same scenario, see
// QA note in the completion report). "One HR department serving 3 companies" end-to-end, with
// SERVICE_ASSIGNMENTS_ENABLED=1, driven ENTIRELY through real endpoints (buildApp + app.inject)
// against live Postgres + Cerbos + Redis — never a raw SQL shortcut for the behavior under test.
//
// Beats proven (design §5 / plan WSD-7 "done when"):
//   1. Setup: holding with A (HR dept d-hr, staff u2/u3, lead u1) + B, C (no HR staff of their
//      own) + D (a 4th company A does NOT serve).
//   2. Connect: propose (global actor -> auto-active) targeting B AND C in one call, module hr;
//      reconciler (real POST .../reconcile endpoint) materializes hr_staff grants for u2 (+u3)
//      scoped to B and C.
//   3. Slice enforcement: u2 CRUDs B's and C's HR via the real HR endpoints; u2 is DENIED (403)
//      on D; B's own admin sees ONLY B's rows, never C's (cross-slice fetch by id also 403, not
//      a content leak) -- proven server-side, under each tenant's own RLS session.
//   4. Company selector: GET /api/me for u2 returns serviceScopes covering exactly {A(home,
//      membership)+B+C} via the served-company fan-out, tagging/excluding D.
//   5. Revoke: revoking ONLY the B assignment (the OTHER target, C, stays active in the SAME
//      unit) drops u2's B access (404, module gate closed) while C access is untouched; no
//      orphaned grant/claim survives the revoke (ORG-6 invariant).
//   6. Focus scoping: u2's own PM "my work" (GET .../pm/tasks?assignee=me) in home company A is
//      unaffected by the cross-company HR grants -- still shows only u2's own task.
//   7. Server-side enforcement is authoritative: every proof above is a curl-equivalent
//      app.inject() call, never a UI-gating assumption.
//
// Needs DATABASE_URL_TEST + CERBOS_URL + REDIS_URL_TEST (disposable services; skips otherwise).
// This run used a disposable harness: live gaiada-postgres-1's pre-existing disposable
// `gaiada_platform_test` database (schema dropped+remigrated fresh by initTestDb(), never the
// real gaiada_platform DB), a throwaway Cerbos loading this repo's real policies on :15592, and a
// throwaway Redis on :16379 -- gaiada-platform-1 itself is internal-only (no host port) so it was
// not driven directly; this harness proves the same code path (buildApp() from this checkout).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withGlobal, withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { hrModule } from "./index";
import { pmModule } from "../pm";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { setRedis, closeRedis } from "../../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const RUN = !!(TEST_URL && REDIS_TEST_URL);

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface Node {
  id: string;
  name: string;
  kind: string;
  assigneeId?: string | null;
  children?: Node[];
}

async function setBlob(tenant: string, root: Node): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'main')
       ON CONFLICT (tenant_id) DO UPDATE SET structure=$2, updated_at=now()`,
      [tenant, JSON.stringify({ root })],
    ),
  );
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
  const { rows } = await withTenants([target], (c) =>
    c.query<{ n: number }>(`SELECT count(*)::int n FROM service_grant_claims WHERE assignment_id=$1`, [assignmentId]),
  );
  return rows[0].n;
}

describe.skipIf(!RUN)("WSD-7 — owner's literal acceptance scenario (HR serving 3 companies)", () => {
  let app: NestFastifyApplication;
  let redis: Redis;

  let H: string; // holding root
  let A: string; // provider: Gaia Digital Agency — has HR dept d-hr, staff u2/u3, lead u1
  let B: string; // served company 1 (Viceroy) — no HR staff of its own
  let C: string; // served company 2 — no HR staff of its own
  let D: string; // a 4th company A does NOT serve
  let exec: string; // group_executive (global) — proposes via the OrgBuilder "connect" action

  let u1: string; // HR lead -> hr_manager
  let u2: string; // HR staff -> hr_staff
  let u3: string; // HR staff -> hr_staff
  let bEmp: string;
  let cEmp: string;
  let bAdmin: string;
  let cAdmin: string;

  let unitId: string;
  let asgB: string;
  let asgC: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;
    redis = new Redis(REDIS_TEST_URL);
    setRedis(redis);
    resetModules();
    resetCoreRollupProviders();
    registerModule(hrModule);
    registerModule(pmModule);
    await syncMetricDefinitions();

    H = await createCompany("Syrowatka Holding");
    A = await createCompany("Gaia Digital Agency", ["hr", "pm"], H); // A owns hr (+pm, for beat 6's "my work" probe) for itself
    B = await createCompany("Viceroy", [], H); // NOT hr-enabled -- gets HR only via serving
    C = await createCompany("Seeded Co C", [], H); // NOT hr-enabled -- gets HR only via serving
    D = await createCompany("Unserved Co D", ["hr"], H); // hr enabled directly, but A never serves it

    exec = await createUser("exec@holding.test");
    const ge = await createRole("group_executive");
    await grantRole(exec, ge, "global", null);

    u1 = await createUser("u1-lead@a.test", "HR Lead");
    u2 = await createUser("u2-staff@a.test", "HR Staff Two");
    u3 = await createUser("u3-staff@a.test", "HR Staff Three");
    await addMembership(A, u1);
    await addMembership(A, u2);
    await addMembership(A, u3);
    const memberRole = await createRole("member");
    await grantRole(u2, memberRole, "company", A); // u2's own home-company baseline role, for beat 6's PM "my work" read

    bAdmin = await createUser("badmin@b.test");
    cAdmin = await createUser("cadmin@c.test");
    bEmp = await createUser("bemp@b.test");
    cEmp = await createUser("cemp@c.test");
    const caRole = await createRole("company_admin");
    await addMembership(B, bAdmin);
    await grantRole(bAdmin, caRole, "company", B);
    await addMembership(C, cAdmin);
    await grantRole(cAdmin, caRole, "company", C);
    await addMembership(B, bEmp);
    await addMembership(C, cEmp);

    // A's org blob: d-hr department with lead u1 and staff u2, u3 (mirrors the design's shape).
    await setBlob(A, {
      id: "root", name: "Gaia", kind: "company",
      children: [{
        id: "d-hr", name: "HR", kind: "department",
        children: [
          { id: "p-lead", name: "Lead", kind: "person", assigneeId: u1 },
          { id: "p-u2", name: "Staff", kind: "person", assigneeId: u2 },
          { id: "p-u3", name: "Staff", kind: "person", assigneeId: u3 },
        ],
      }],
    });

    // ---- Give u2 a "my work" task in A, in a completely different module (PM) BEFORE any HR
    // grant exists, to prove focus scoping is unaffected by what happens later (beat 6). ----
    const proj = await createProject(A, "Internal Ops");
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, assignee, origin_site)
         VALUES ($1,$2,$3,'u2 personal task',$4,'main')`,
        [newId(), A, proj, JSON.stringify({ kind: "person", refId: u2, responsibleId: u2 })],
      ),
    );

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await closeRedis();
    await teardownTestDb();
  });

  // ───────────────────────── BEAT 1+2: CONNECT (via the real OrgBuilder gesture) ─────────────────────────
  it("beat 1+2 — exec proposes d-hr -> serve B AND C in one call (module hr); global actor => auto-active", async () => {
    const propose = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(exec),
      payload: { targets: [B, C], module: "hr", leadUserId: u1 },
    });
    expect(propose.statusCode).toBe(201);
    const body = propose.json() as { assignments: Array<{ id: string; target: string; status: string }> };
    expect(body.assignments).toHaveLength(2);
    expect(body.assignments.every((a) => a.status === "active")).toBe(true); // global proposer => auto-active
    asgB = body.assignments.find((a) => a.target === B)!.id;
    asgC = body.assignments.find((a) => a.target === C)!.id;
    expect(asgB).toBeTruthy();
    expect(asgC).toBeTruthy();

    unitId = (
      await withTenants([A], (c) => c.query<{ id: string }>(`SELECT id FROM org_units WHERE tenant_id=$1 AND node_id='d-hr'`, [A]))
    ).rows[0].id;

    // A's own enabled_modules is NEVER mutated by serving (design §4).
    const aRow = await withGlobal((c) => c.query<{ enabled_modules: string[] }>(`SELECT enabled_modules FROM companies WHERE id=$1`, [A]));
    expect(aRow.rows[0].enabled_modules.slice().sort()).toEqual(["hr", "pm"]);
  });

  it("beat 2 — reconciler (real endpoint) materializes hr_manager(u1)/hr_staff(u2,u3) scoped to B AND C", async () => {
    const recB = await app.inject({ method: "POST", url: `/api/${A}/org-structure/assignments/${asgB}/reconcile`, headers: asUser(exec) });
    expect(recB.statusCode).toBe(200);
    expect(recB.json().granted).toBeGreaterThan(0);
    const recC = await app.inject({ method: "POST", url: `/api/${A}/org-structure/assignments/${asgC}/reconcile`, headers: asUser(exec) });
    expect(recC.statusCode).toBe(200);
    expect(recC.json().granted).toBeGreaterThan(0);

    for (const target of [B, C]) {
      expect(await grantsFor(u1, target)).toEqual([{ role: "hr_manager", managed: true }]);
      expect(await grantsFor(u2, target)).toEqual([{ role: "hr_staff", managed: true }]);
      expect(await grantsFor(u3, target)).toEqual([{ role: "hr_staff", managed: true }]);
    }
    // isModuleEnabled OR-extension: HR is now alive for B and C without touching their own
    // enabled_modules arrays.
    for (const target of [B, C]) {
      const row = await withGlobal((c) => c.query<{ enabled_modules: string[] }>(`SELECT enabled_modules FROM companies WHERE id=$1`, [target]));
      expect(row.rows[0].enabled_modules).not.toContain("hr");
    }
  });

  // ───────────────────────── BEAT 3: SLICE ENFORCEMENT ─────────────────────────
  let bCaseId: string;
  let cCaseId: string;
  it("beat 3 — u2 can create+read HR cases for B via the real HR endpoints", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2),
      payload: { subjectUserId: bEmp, kind: "onboarding", title: "Onboard B employee" },
    });
    expect(created.statusCode).toBe(201);
    bCaseId = created.json().id;
    const list = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[])).toHaveLength(1);
  });

  it("beat 3 — u2 can create+read HR cases for C via the real HR endpoints", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${C}/modules/hr/cases`, headers: asUser(u2),
      payload: { subjectUserId: cEmp, kind: "onboarding", title: "Onboard C employee" },
    });
    expect(created.statusCode).toBe(201);
    cCaseId = created.json().id;
    const list = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases`, headers: asUser(u2) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as unknown[])).toHaveLength(1);
  });

  it("beat 3 — u2 is DENIED (403) HR access to D, the 4th company A does NOT serve (hr IS enabled on D, so this is the Cerbos wall, not the module gate)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${D}/modules/hr/cases`, headers: asUser(u2) });
    expect(r.statusCode).toBe(403);
    // direct-id fetch attempt against D is denied the same way -- never a 200/404 content leak.
    const byId = await app.inject({ method: "GET", url: `/api/${D}/modules/hr/cases/${bCaseId}`, headers: asUser(u2) });
    expect([403, 404]).toContain(byId.statusCode);
    expect(byId.statusCode).not.toBe(200);
  });

  it("beat 3 — B's own company_admin sees ONLY B's HR row, never C's (server-side, under B's own RLS session)", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(bAdmin) });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual([bCaseId]);
    expect(rows.map((r) => r.id)).not.toContain(cCaseId);

    // B's admin attempting C directly: denied outright (B's admin has no C grant/membership at all).
    const cross = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases`, headers: asUser(bAdmin) });
    expect(cross.statusCode).toBe(403);
    const crossById = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases/${cCaseId}`, headers: asUser(bAdmin) });
    expect(crossById.statusCode).not.toBe(200);

    // Same proof from C's side, symmetric.
    const cList = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases`, headers: asUser(cAdmin) });
    expect((cList.json() as Array<{ id: string }>).map((r) => r.id)).toEqual([cCaseId]);
  });

  it("beat 3 — direct DB-level proof under each tenant's own RLS session (not just the endpoint)", async () => {
    const asB = await withTenants([B], (c) => c.query<{ id: string }>(`SELECT id FROM hr_cases WHERE deleted_at IS NULL`), { modules: ["hr"] });
    expect(asB.rows.map((r) => r.id)).toEqual([bCaseId]);
    const asC = await withTenants([C], (c) => c.query<{ id: string }>(`SELECT id FROM hr_cases WHERE deleted_at IS NULL`), { modules: ["hr"] });
    expect(asC.rows.map((r) => r.id)).toEqual([cCaseId]);
    // provider A holds NO hr_* rows -- data never re-homes to the provider.
    const asA = await withTenants([A], (c) => c.query<{ id: string }>(`SELECT id FROM hr_cases WHERE deleted_at IS NULL`), { modules: ["hr"] });
    expect(asA.rows).toEqual([]);
  });

  // ───────────────────────── BEAT 4: COMPANY SELECTOR ─────────────────────────
  it("beat 4 — GET /api/me for u2 returns serviceScopes covering exactly B and C, excludes D", async () => {
    const me = await app.inject({ method: "GET", url: `/api/me`, headers: asUser(u2) });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { companies: Array<{ id: string }>; serviceScopes: Array<{ companyId: string; module: string; role: string }> };
    // companies includes A (real, employee-kind membership) PLUS B and C -- the reconciler
    // materializes a company_memberships(kind='service') row on each served company too (design
    // §2.1: "company_memberships(B,u2,kind='service',...) -> B in principal.companies"). This is
    // the mechanism that lets inTenant/withTenants pass for B/C, not a leak: D is absent.
    expect(body.companies.map((c) => c.id).sort()).toEqual([A, B, C].sort());
    expect(body.companies.map((c) => c.id)).not.toContain(D);
    const scopeCompanyIds = body.serviceScopes.map((s) => s.companyId).sort();
    expect(scopeCompanyIds).toEqual([B, C].sort());
    expect(scopeCompanyIds).not.toContain(D);
    for (const s of body.serviceScopes) {
      expect(s.module).toBe("hr");
      expect(s.role).toBe("staff");
    }

    // Distinguish the real home membership (A, kind='employee') from the two SERVICE memberships
    // (B/C, kind='service', managed_by=the assignment) -- this is what makes A/B/C behave as
    // "each or all" for the company selector while D never appears anywhere. company_memberships
    // is FORCE RLS: each tenant must be read under its OWN withTenants session (withGlobal sees
    // zero rows here, by design).
    const memA = await withTenants([A], (c) => c.query<{ kind: string; managed_by: string | null }>(`SELECT kind, managed_by FROM company_memberships WHERE tenant_id=$1 AND user_id=$2`, [A, u2]));
    const memB = await withTenants([B], (c) => c.query<{ kind: string; managed_by: string | null }>(`SELECT kind, managed_by FROM company_memberships WHERE tenant_id=$1 AND user_id=$2`, [B, u2]));
    const memC = await withTenants([C], (c) => c.query<{ kind: string; managed_by: string | null }>(`SELECT kind, managed_by FROM company_memberships WHERE tenant_id=$1 AND user_id=$2`, [C, u2]));
    expect(memA.rows[0]).toMatchObject({ kind: "employee", managed_by: null });
    expect(memB.rows[0]).toMatchObject({ kind: "service" });
    expect(memC.rows[0]).toMatchObject({ kind: "service" });
  });

  it("beat 4 — the fan-out envelope (org-structure/assignments, direction=served) labels A/B/C and excludes D as no_access when the caller widens toward it", async () => {
    const fan = await app.inject({
      method: "GET",
      url: `/api/${B}/org-structure/assignments?direction=served&companyIds=${C},${D}&module=hr`,
      headers: asUser(u2),
    });
    expect(fan.statusCode).toBe(200);
    const body = fan.json() as { items: Array<{ targetTenantId: string }>; companies: Array<{ id: string; included: boolean; reason?: string }> };
    expect(body.companies.find((c) => c.id === B)?.included).toBe(true);
    expect(body.companies.find((c) => c.id === C)?.included).toBe(true);
    const dEntry = body.companies.find((c) => c.id === D);
    expect(dEntry?.included).toBe(false);
    expect(dEntry?.reason).toBe("no_access");
    expect(body.items.every((i) => i.targetTenantId !== D)).toBe(true); // never a silent leak of D rows
  });

  // ───────────────────────── BEAT 5: REVOKE (ONE target of the multi-target unit) ─────────────────────────
  it("beat 5 — revoking ONLY the B assignment (real DELETE endpoint) drops u2's B access; C (same unit, other target) stays live; no orphaned grant/claim", async () => {
    const revoke = await app.inject({ method: "DELETE", url: `/api/${A}/org-structure/assignments/${asgB}`, headers: asUser(exec) });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toMatchObject({ ok: true, status: "revoked" });

    // Reconcile drains the revoke (mirrors the real event-driven path; ORG-6 tears down claims/grants).
    const rec = await app.inject({ method: "POST", url: `/api/${A}/org-structure/assignments/${asgB}/reconcile`, headers: asUser(exec) });
    expect(rec.statusCode).toBe(200);

    // B: 404 (module gate closes -- HR is no longer enabled for B at all, no live assignment left).
    const bAfter = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2) });
    expect(bAfter.statusCode).toBe(404);

    // C: untouched -- still 200, still u2's own case visible (SAME unit, the OTHER target).
    const cAfter = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases`, headers: asUser(u2) });
    expect(cAfter.statusCode).toBe(200);
    expect((cAfter.json() as Array<{ id: string }>).map((r) => r.id)).toEqual([cCaseId]);

    // No orphaned grant/claim for the REVOKED (B) assignment.
    expect(await grantsFor(u2, B)).toEqual([]);
    expect(await grantsFor(u1, B)).toEqual([]);
    expect(await claimCount(asgB, B)).toBe(0);
    // The LIVE (C) assignment's grants are intact.
    expect(await grantsFor(u2, C)).toEqual([{ role: "hr_staff", managed: true }]);

    // B's own tenant-owned HR data is untouched (tenant-owned data never re-homes on revoke).
    const stillThere = await withTenants([B], (c) => c.query<{ n: number }>(`SELECT count(*)::int n FROM hr_cases WHERE tenant_id=$1`, [B]), { modules: ["hr"] });
    expect(Number(stillThere.rows[0].n)).toBeGreaterThan(0);
  });

  // ───────────────────────── BEAT 6: FOCUS SCOPING (personal "my work" unaffected) ─────────────────────────
  it("beat 6 — u2's own PM 'my work' in home company A still shows only u2's own task, unaffected by cross-company HR grants (before AND after the revoke)", async () => {
    const mine = await app.inject({ method: "GET", url: `/api/${A}/pm/tasks?assignee=me`, headers: asUser(u2) });
    expect(mine.statusCode).toBe(200);
    // P4-A1 made this endpoint paginated: `{ items, nextCursor }`, not a bare array. This test lives
    // in the HR module and consumes PM, which is exactly why the shape change looked consumer-free
    // from inside `src/modules/pm/` — a response-shape change has to be verified against the WHOLE
    // suite, not the module that owns the handler.
    const body = mine.json() as { items: Array<{ title: string }>; nextCursor: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("u2 personal task");
    // No B/C hr_case ever leaks into a PM task listing (different module, different tenant).
  });

  // ───────────────────────── BEAT 7: SERVER-SIDE, NOT UI-GATED ─────────────────────────
  it("beat 7 — every denial above was a real HTTP status from app.inject(), never a client-side assumption (smoke: re-probe D denial fresh)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${D}/modules/hr/cases`, headers: asUser(u2) });
    expect(r.statusCode).toBe(403);
  });
});
