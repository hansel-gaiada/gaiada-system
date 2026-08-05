// WSD-4 — HR module backend, end-to-end against live Postgres + Cerbos + Redis (skips without
// DATABASE_URL_TEST/CERBOS_URL/REDIS_URL_TEST). Walks the WSD-7-style acceptance path (design
// §5) at the level owned by this ticket:
//   (1) module registration + ModuleEnabledGuard dark-by-default,
//   (2) Wall 1 (enablement): an ACTIVE service_assignment lights up HR for a served company that
//       has NOT put 'hr' in its own enabled_modules,
//   (3) an hr_staff materialized into served company B can CRUD B's HR via the endpoints but is
//       DENIED (403, not 404 — the Cerbos wall, not just the module gate) on a company C where hr
//       is enabled but the staffer holds no grant,
//   (4) Wall 2 (declare-scope): withTenants(...,{modules:['hr']}) is what actually opens hr_* reads
///      (proven directly against module-hr-rls.test.ts already; here we prove the controller wires
//       it, by using the real endpoints rather than a raw client),
//   (5) leave file -> unified-inbox decide (the EXISTING /automation-approvals/:id/decide endpoint)
//       -> the real outbox->redis->consumer pipeline -> the hr eventHandler applies the decision +
//       moves the balance + notifies the subject with an href,
//   (6) user.invited -> auto-instantiated onboarding case, through the same real pipeline,
//   (7) hr_record has NO subject self-read (member denied even on their own record),
//   (8) served-tenant rollups compute non-zero (the rollups-engine module-scope wiring, WSD-4 AC).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withGlobal, withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules, getModule } from "../registry";
import { hrModule } from "./index";
import { recomputeRollups, syncMetricDefinitions, resetCoreRollupProviders } from "../../rollups/engine";
import { relayBatch } from "../../events/relay";
import { consumeOnce } from "../../events/consumer.service";
import { setRedis, closeRedis } from "../../events/redis";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function createUnit(provider: string, nodeId: string, name = "HR", kind = "department"): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,$3,$4,$5)`, [id, provider, nodeId, kind, name]),
  );
  return id;
}

async function createActiveAssignment(unitId: string, provider: string, target: string, createdBy: string): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(
      `INSERT INTO service_assignments
         (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, unit_status, created_by, accepted_at)
       VALUES ($1,$2,$3,$4,'hr','active','HR','department','active',$5, now())`,
      [id, unitId, provider, target, createdBy],
    ),
  );
  return id;
}

// Drains the real outbox -> Redis -> platform consumer group deterministically (no polling).
async function drainConsumer(entityTypes: string[]): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const relayed = await relayBatch(500);
    let consumed = 0;
    for (const t of entityTypes) consumed += await consumeOnce(t);
    if (relayed === 0 && consumed === 0) return;
  }
}

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("HR module (WSD-4)", () => {
  let app: NestFastifyApplication;
  let redis: Redis;
  let A: string; // provider (holding root); hr is in A's OWN enabled_modules
  let B: string; // served company — gets hr ONLY via an active service_assignment (never enabled_modules)
  let C: string; // a DIFFERENT company where hr IS enabled, but u2 holds no grant there
  let u2: string; // hr_staff, materialized (granted) at company:B only
  let admin: string; // B's own company_admin
  let member: string; // a plain B employee (the leave subject / self-service probe)

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

    A = await createCompany("HR Provider (Gaia)", ["hr"]);
    B = await createCompany("Served B (Viceroy)", [], A); // same holding as A; NOT hr-enabled
    C = await createCompany("Served C (hr enabled directly)", ["hr"]);

    u2 = await createUser("hr-staff-u2@a.test");
    admin = await createUser("admin@b.test");
    member = await createUser("employee@b.test");
    await addMembership(B, u2);
    await addMembership(B, admin);
    await addMembership(B, member);
    await addMembership(C, u2); // u2 IS a member of C too, but holds no hr_staff grant there

    const hrStaffRole = await createRole("hr_staff");
    const companyAdminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(u2, hrStaffRole, "company", B); // simulates the ORG-6 reconciler's materialized grant
    await grantRole(admin, companyAdminRole, "company", B);
    await grantRole(member, memberRole, "company", B);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await closeRedis();
    await teardownTestDb();
  });

  it("module registration: hr's ModuleContract carries the design's shape", () => {
    expect(getModule("hr")).toBe(hrModule);
    // Wave E added the two loan tools. hr.requestLoan is impact `high` (leave's file is `medium`) —
    // approving it moves money, so D14 suspends the agent/n8n path for a human decision.
    expect(hrModule.mcpTools.map((t) => t.name)).toEqual([
      "hr.listCases", "hr.listLeave", "hr.fileLeave", "hr.listLoans", "hr.requestLoan",
    ]);
    expect(hrModule.mcpTools.find((t) => t.name === "hr.requestLoan")?.impact).toBe("high");
    expect(hrModule.customFieldTargets).toEqual(["hr_case", "hr_record"]);
    // Still exactly TWO keys after wave E: `automation_approval.decided` is keyed by EVENT TYPE, so
    // hr gets one handler for it, and hr now files two kinds of approval (leave, loans). The contract
    // therefore registers a dispatcher that runs both appliers; adding a third key here would mean
    // one of them had silently stopped being called.
    expect(Object.keys(hrModule.eventHandlers ?? {})).toEqual(["automation_approval.decided", "user.invited"]);
  });

  it("dark by default: B's HR routes 404 before any enablement path exists", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2) });
    expect(r.statusCode).toBe(404);
  });

  let assignmentId: string;
  it("Wall 1 — enablement-via-assignment: an ACTIVE service_assignment lights up B WITHOUT touching B.enabled_modules", async () => {
    const unitId = await createUnit(A, "d-hr");
    assignmentId = await createActiveAssignment(unitId, A, B, u2);

    const enabled = await withGlobal((c) => c.query<{ enabled_modules: string[] }>(`SELECT enabled_modules FROM companies WHERE id = $1`, [B]));
    expect(enabled.rows[0].enabled_modules).not.toContain("hr"); // never mutated by serving (design §4)

    const r = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2) });
    expect(r.statusCode).toBe(200); // guard now passes via the isModuleEnabled OR-extension
    expect(r.json()).toEqual([]);
  });

  it("hr_staff materialized at company:B can create/read B's HR cases", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2),
      payload: { subjectUserId: member, kind: "onboarding", title: "Onboard employee" },
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2) });
    expect(list.json()).toHaveLength(1);
  });

  it("the SAME hr_staff is DENIED on company C (403, not 404 — the Cerbos wall, not the module gate)", async () => {
    // C has hr enabled directly (module gate passes) but u2 holds no hr_staff/company_admin grant
    // there — proves the denial is Cerbos's module_staff scoping, not merely ModuleEnabledGuard.
    const r = await app.inject({ method: "GET", url: `/api/${C}/modules/hr/cases`, headers: asUser(u2) });
    expect(r.statusCode).toBe(403);
  });

  it("B's own company_admin also sees B's HR (in-tenant, not module-scoped)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
  });

  it("a plain member sees only THEIR OWN case (self-service), and cannot update it", async () => {
    const mine = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(member) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toHaveLength(1); // the onboarding case filed with subjectUserId=member

    const caseId = (mine.json() as Array<{ id: string }>)[0].id;
    const denied = await app.inject({
      method: "PATCH", url: `/api/${B}/modules/hr/cases/${caseId}`, headers: asUser(member), payload: { status: "done" },
    });
    expect(denied.statusCode).toBe(403); // "update" has no member-self rule
  });

  it("hr_record has NO subject self-read in v1 — the subject is denied their own record", async () => {
    const created = await app.inject({
      method: "POST", url: `/api/${B}/modules/hr/records`, headers: asUser(u2),
      payload: { subjectUserId: member, recordType: "note", data: { text: "great hire" } },
    });
    expect(created.statusCode).toBe(201);
    const asSubject = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/records?subjectUserId=${member}`, headers: asUser(member) });
    expect(asSubject.statusCode).toBe(403);
    const asStaff = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/records`, headers: asUser(u2) });
    expect(asStaff.json()).toHaveLength(1);
  });

  it("export is module_manager/company_admin ONLY — plain hr_staff (u2) is denied", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/records/export`, headers: asUser(u2) });
    expect(r.statusCode).toBe(403); // resource_hr_record.yaml's export rule excludes module_staff
  });

  it("company_admin CAN export (dev-header principals resolve at 'high' assurance, see auth/guards)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/records/export`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
  });

  let leaveId: string;
  let approvalId: string;
  it("file leave: writes hr_leave_requests + an origin='hr' automation_approvals row in one tx", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${B}/modules/hr/leave`, headers: asUser(u2),
      payload: { subjectUserId: member, leaveType: "vacation", startsOn: "2026-08-03", endsOn: "2026-08-04", minutes: 960 },
    });
    expect(r.statusCode).toBe(201);
    leaveId = r.json().id;
    approvalId = r.json().approvalId;
    expect(leaveId).toBeTruthy();
    expect(approvalId).toBeTruthy();

    const pending = await app.inject({ method: "GET", url: `/api/${B}/automation-approvals?origin=hr`, headers: asUser(admin) });
    expect(pending.statusCode).toBe(200);
    expect((pending.json() as Array<{ id: string; origin: string }>).find((row) => row.id === approvalId)?.origin).toBe("hr");
  });

  it("decide via the EXISTING unified endpoint -> real outbox pipeline -> balance moves + notification with href", async () => {
    const decided = await app.inject({
      method: "POST", url: `/api/${B}/automation-approvals/${approvalId}/decide`, headers: asUser(admin), payload: { decision: "approved" },
    });
    expect(decided.statusCode).toBe(200);

    await drainConsumer(["automation_approval", "user"]);

    const leave = await withTenants([B], (c) => c.query(`SELECT status FROM hr_leave_requests WHERE id = $1`, [leaveId]), { modules: ["hr"] });
    expect(leave.rows[0].status).toBe("approved");

    const balance = await withTenants(
      [B],
      (c) => c.query<{ used_minutes: number }>(`SELECT used_minutes FROM hr_leave_balances WHERE tenant_id=$1 AND subject_user_id=$2 AND leave_type='vacation' AND year=2026`, [B, member]),
      { modules: ["hr"] },
    );
    expect(balance.rows[0].used_minutes).toBe(960);

    const notif = await withTenants([B], (c) =>
      c.query<{ payload: { href?: string; decision?: string } }>(`SELECT payload FROM notifications WHERE tenant_id=$1 AND user_id=$2 AND type='hr.leave.decided'`, [B, member]),
    );
    expect(notif.rows[0].payload).toMatchObject({ decision: "approved", href: `/hr/leave/${leaveId}` });
  });

  it("hr_manager (module_manager) can ALSO decide an hr-origin approval via the same endpoint", async () => {
    const hrManagerRole = await createRole("hr_manager");
    const u1 = await createUser("hr-manager-u1@a.test");
    await addMembership(B, u1); // the choke-point wall: inTenant needs B in principal.companies too
    await grantRole(u1, hrManagerRole, "company", B);
    // File a second leave request as u2, then let the PROVIDING unit's manager (u1) decide it —
    // proves resource_automation_approval.yaml's module_manager+module=='hr' rule (WSD-2).
    const filed = await app.inject({
      method: "POST", url: `/api/${B}/modules/hr/leave`, headers: asUser(u2),
      payload: { subjectUserId: member, leaveType: "sick", startsOn: "2026-09-01", endsOn: "2026-09-01", minutes: 480 },
    });
    expect(filed.statusCode).toBe(201);
    const decided = await app.inject({
      method: "POST", url: `/api/${B}/automation-approvals/${filed.json().approvalId}/decide`, headers: asUser(u1), payload: { decision: "rejected" },
    });
    expect(decided.statusCode).toBe(200);
  });

  it("user.invited auto-instantiates a default onboarding hr_case through the real pipeline", async () => {
    await withTenants([B], (c) =>
      c.query(
        `INSERT INTO hr_checklist_templates (id, tenant_id, kind, name, items, is_default) VALUES (gen_random_uuid(),$1,'onboarding','Default Onboarding',$2,true)`,
        [B, JSON.stringify([{ label: "Sign contract" }, { label: "Provision laptop" }])],
      ),
      { modules: ["hr"] },
    );
    const invite = await app.inject({
      method: "POST", url: `/api/${B}/users`, headers: asUser(admin),
      payload: { name: "New Hire", email: "new.hire@b.test" },
    });
    expect(invite.statusCode).toBe(201);
    const newUserId = invite.json().id;

    await drainConsumer(["automation_approval", "user"]);

    const cases = await withTenants(
      [B],
      (c) => c.query<{ title: string; details: { items: Array<{ label: string }> } }>(
        `SELECT title, details FROM hr_cases WHERE tenant_id=$1 AND subject_user_id=$2 AND kind='onboarding'`,
        [B, newUserId],
      ),
      { modules: ["hr"] },
    );
    expect(cases.rows).toHaveLength(1);
    expect(cases.rows[0].title).toBe("Default Onboarding");
    expect(cases.rows[0].details.items).toHaveLength(2);
  });

  it("served-tenant rollups compute non-zero (rollups-engine module-scope wiring)", async () => {
    const period = "2026-08-03";
    const written = await recomputeRollups(B, period);
    expect(written).toBeGreaterThan(0);
    const rows = await withTenants([B], (c) =>
      c.query<{ metric_key: string; numerator: string }>(`SELECT metric_key, numerator FROM rollup_metrics WHERE tenant_id=$1 AND period=$2 AND module='hr'`, [B, period]),
    );
    const openCases = rows.rows.find((r) => r.metric_key === "hr.open_cases");
    expect(Number(openCases?.numerator)).toBeGreaterThan(0);
  });

  it("both walls hold even for the module_staff grant: withTenants WITHOUT the hr scope reads zero hr rows in-process", async () => {
    const res = await withTenants([B], (c) => c.query(`SELECT id FROM hr_cases WHERE tenant_id = $1`, [B])); // no {modules:['hr']}
    expect(res.rows).toHaveLength(0); // third wall (app_module_allowed) — proven again at the app layer, not just module-hr-rls.test.ts
  });

  it("revoking the assignment closes the enablement wall: B's HR routes 404 again for u2", async () => {
    await withTenants([A], (c) => c.query(`UPDATE service_assignments SET status = 'revoked' WHERE id = $1`, [assignmentId]));
    const r = await app.inject({ method: "GET", url: `/api/${B}/modules/hr/cases`, headers: asUser(u2) });
    expect(r.statusCode).toBe(404);
    // B's own hr rows are untouched (tenant-owned data never re-homes/disappears on revoke).
    const stillThere = await withTenants([B], (c) => c.query(`SELECT count(*)::int AS n FROM hr_cases WHERE tenant_id = $1`, [B]), { modules: ["hr"] });
    expect(Number((stillThere.rows[0] as { n: number }).n)).toBeGreaterThan(0);
  });
});
