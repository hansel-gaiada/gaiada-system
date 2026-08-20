// P2-06 — the joiner / mover / leaver flows, driven through the REAL HTTP surface.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §5. Every case below goes through
// `app.inject()` against a real Postgres and a real Cerbos — not by calling the controller methods
// directly — because this program's own record says scripted/cross-process verification is not real-
// input verification, and three of its defects were only ever found by driving the surface.
//
// ⚠ THE MOVER CRITERION (§5.2, the reason this phase exists) is asserted here in its HTTP form:
// after `POST /transfer` returns, an authorization probe on an OLD-department resource must be 403
// and the NEW department 200 — probed against RUNNING Cerbos with a principal `assemblePrincipal()`
// builds from the `user_roles` rows the reconciler actually wrote. A bundle-based check cannot
// witness this (org_unit_lead's whole meaning is its condition), so it is deliberately not used.
//
// ⚠ STALENESS: Cerbos does not hot-reload policy; the test Cerbos was restarted before this suite
// was authored and run. Skips without CERBOS_URL, same convention as the P2-05 mover suite.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { withTenants, withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, addMembership, grantRole } from "../testing/fixtures";
import { check, type Resource } from "../rbac/cerbos";
import { assemblePrincipal } from "../rbac/principal";

const live = !!process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// Ancestor chains as `org_unit_closure` produces them: self-inclusive at depth 0, nearest-first.
const WEB = ["dv-frontend", "d-web", "d-corp"];
const HR = ["dv-hr-ops", "d-hr", "d-corp"];

// The blob the tenant starts with — the JML flows edit THIS, and every assertion about placement
// reads it back rather than trusting the flow's own response.
const ORG_BLOB = {
  root: {
    id: "d-corp", name: "Corp", kind: "company", assigneeId: null, assigneeName: null,
    children: [
      {
        id: "d-web", name: "Web Dev", kind: "department", assigneeId: null, assigneeName: null,
        children: [{ id: "dv-frontend", name: "Frontend", kind: "division", assigneeId: null, assigneeName: null, children: [] }],
      },
      {
        id: "d-hr", name: "HR", kind: "department", assigneeId: null, assigneeName: null,
        children: [{ id: "dv-hr-ops", name: "HR Ops", kind: "division", assigneeId: null, assigneeName: null, children: [] }],
      },
    ],
  },
};

describe.skipIf(!TEST_URL || !live)("P2-06 — joiner / mover / leaver over the real surface", () => {
  let app: NestFastifyApplication;
  let T: string;
  let hrManager: string;
  let companyAdmin: string;
  let leadRole: string;
  let webPosition: string;
  let hrPosition: string;

  /** A position whose role-set confers `org_unit_lead` at the position's OWN unit — the only
   *  role-set shape whose reach is observable through a Cerbos probe (its condition IS its
   *  meaning), which is what makes the mover criterion assertable at all. */
  async function positionWithLead(unitNode: string, title: string): Promise<string> {
    const id = newId();
    await withTenants([T], async (c) => {
      await c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,$3,$4)`, [
        id, T, unitNode, title,
      ]);
      await c.query(
        `INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,'own_unit')`,
        [T, id, leadRole],
      );
    });
    return id;
  }

  /** Probe the LIVE engine with whatever the reconciler has materialized for this user right now. */
  async function probe(userId: string, unitAncestors: string[]): Promise<number> {
    const p = await assemblePrincipal(userId, "high");
    if (!p) return 401;
    const resource: Resource = { kind: "report_document", id: "doc-1", tenantId: T, module: "reports", unitAncestors };
    const decision = await check(p, resource, "read_department");
    return decision.allow ? 200 : 403;
  }

  // ⚠ RESOLVED BY OWNER DECISION, 2026-08-18. This suite originally PINNED the opposite: design §5.1
  // ("HR ... opens the position assignment") contradicted §4.1/§6.2 ("dept head assigns"), the policy
  // sided with §4.1, and an `hr_manager` got 403 the moment `positionId` was present. Rather than
  // widen a policy on my own authority I pinned the refusal and escalated. The owner ruled that HR
  // runs joiner/mover/leaver end to end, so `hr_people_ops` now holds `position.assign`/`.unassign`
  // (migration `0112`), and the cases below assert the NEW behaviour — with `hr_staff`'s continued
  // refusal pinned too, because `hr_people_ops` is the ACTING tier (hr_manager only), not all of HR.
  const hire = (body: Record<string, unknown>, actor = companyAdmin) =>
    app.inject({ method: "POST", url: `/api/${T}/hr/employees`, headers: asUser(actor), payload: body });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.positionSyncEnabled = true;

    T = await createCompany("JML Co", ["hr", "reports"]);
    hrManager = await createUser("jml-hrm@a.test");
    companyAdmin = await createUser("jml-ca@a.test");
    await addMembership(T, hrManager);
    await addMembership(T, companyAdmin);
    await grantRole(hrManager, await createRole("hr_manager"), "company", T);
    await grantRole(companyAdmin, await createRole("company_admin"), "company", T);
    leadRole = await createRole("org_unit_lead", null);

    app = await buildApp();

    // Seed the blob through the REAL PUT, so the closure table is built by the same pipeline the
    // JML flows will re-run — never hand-inserted.
    const put = await app.inject({
      method: "PUT", url: `/api/${T}/org-structure`, headers: asUser(companyAdmin), payload: ORG_BLOB,
    });
    expect(put.statusCode).toBe(200);

    webPosition = await positionWithLead("d-web", "Web Dev Lead");
    hrPosition = await positionWithLead("d-hr", "Head of HR");
  });

  afterAll(async () => {
    config.positionSyncEnabled = false;
    await app?.close();
    await teardownTestDb();
  });

  // ─────────────────────────── §5.1 joiner ───────────────────────────

  it("hires a candidate with no position: employee row, no principal, pending_start", async () => {
    const res = await hire({ displayName: "Candidate One", workEmail: "cand1@a.test" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.employmentStatus).toBe("pending_start");
    expect(body.userId).toBeNull(); // 0109: "a pending_start candidate may have no principal yet"
    expect(body.reconciled).toBeNull();
  });

  it("hires INTO a position: creates the principal, the seat, the blob node, and the grants", async () => {
    const res = await hire({ displayName: "Web Lead", workEmail: "weblead@a.test", positionId: webPosition });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.employmentStatus).toBe("active");
    expect(body.userId).toBeTruthy();
    expect(body.reconciled.granted).toBeGreaterThan(0);

    // the seat
    const seats = await withTenants([T], (c) =>
      c.query(`SELECT position_id FROM position_assignments WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`, [
        T, body.userId,
      ]),
    );
    expect(seats.rows.map((r) => (r as { position_id: string }).position_id)).toEqual([webPosition]);

    // the blob person node — §4.2's half that a seat-only write would have skipped
    const blob = await withTenants([T], (c) =>
      c.query<{ structure: { root: unknown } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [T]),
    );
    expect(JSON.stringify(blob.rows[0].structure)).toContain(body.userId);

    // and the membership sweep the blob write drives
    const oum = await withTenants([T], (c) =>
      c.query(`SELECT unit_node_id FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`, [
        T, body.userId,
      ]),
    );
    expect(oum.rows).toHaveLength(1);

    // the access the seat confers, proven against the live engine
    expect(await probe(body.userId, WEB)).toBe(200);
    expect(await probe(body.userId, HR)).toBe(403);
  });

  it("is idempotent: re-hiring the same work_email converges on ONE employee and ONE seat", async () => {
    const first = await hire({ displayName: "Retry Person", workEmail: "retry@a.test", positionId: hrPosition });
    expect(first.statusCode).toBe(201);
    const second = await hire({ displayName: "Retry Person", workEmail: "retry@a.test", positionId: hrPosition });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);

    const rows = await withTenants([T], (c) =>
      c.query(`SELECT id FROM employees WHERE tenant_id = $1 AND work_email = 'retry@a.test' AND deleted_at IS NULL`, [T]),
      { modules: ["hr"] },
    );
    expect(rows.rows).toHaveLength(1);
    const seats = await withTenants([T], (c) =>
      c.query(`SELECT id FROM position_assignments WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`, [
        T, first.json().userId,
      ]),
    );
    expect(seats.rows).toHaveLength(1);
  });

  it("refuses a placement without an email, and refuses a future start date", async () => {
    const noEmail = await hire({ displayName: "No Email", positionId: webPosition });
    expect(noEmail.statusCode).toBe(400);
    expect(noEmail.json().error).toContain("workEmail is required");

    const future = await hire({ displayName: "Future", workEmail: "future@a.test", startDate: "2099-01-01" });
    expect(future.statusCode).toBe(400);
    expect(future.json().error).toContain("cannot be in the future");
  });

  it("hr_manager runs the WHOLE flow: hire-with-placement, transfer and terminate (owner decision)", async () => {
    const recordOnly = await hire({ displayName: "HR Made", workEmail: "hrmade@a.test" }, hrManager);
    expect(recordOnly.statusCode).toBe(201);

    const placed = await hire({ displayName: "HR Placed", workEmail: "hrplaced@a.test", positionId: webPosition }, hrManager);
    expect(placed.statusCode).toBe(201);
    expect(placed.json().reconciled.granted).toBeGreaterThan(0);
    const placedId = placed.json().id as string;

    const mv = await app.inject({
      method: "POST", url: `/api/${T}/hr/employees/${placedId}/transfer`,
      headers: asUser(hrManager), payload: { toPositionId: hrPosition },
    });
    expect(mv.statusCode).toBe(200);

    const tm = await app.inject({
      method: "POST", url: `/api/${T}/hr/employees/${placedId}/terminate`, headers: asUser(hrManager), payload: {},
    });
    expect(tm.statusCode).toBe(200);
  });

  it("hr_STAFF still cannot place, transfer or terminate — hr_people_ops is the ACTING tier only", async () => {
    // The decision widened `hr_people_ops`, which resolves to hr_manager ALONE. If a future edit
    // grants hr_staff the same reach, that is a real widening and this case is what says so.
    const hrStaff = await createUser("jml-hrstaff@a.test");
    await addMembership(T, hrStaff);
    await grantRole(hrStaff, await createRole("hr_staff"), "company", T);

    const placed = await hire({ displayName: "Staff Placed", workEmail: "staffplaced@a.test", positionId: webPosition }, hrStaff);
    expect(placed.statusCode).toBe(403);
    const rows = await withTenants([T], (c) =>
      c.query(`SELECT id FROM employees WHERE tenant_id = $1 AND work_email = 'staffplaced@a.test'`, [T]),
      { modules: ["hr"] },
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses the whole hire when the caller may not create employees (403, no row left behind)", async () => {
    const plain = await createUser("jml-plain@a.test");
    await addMembership(T, plain);
    await grantRole(plain, await createRole("member"), "company", T);
    const res = await hire({ displayName: "Sneaky", workEmail: "sneaky@a.test", positionId: webPosition }, plain);
    expect(res.statusCode).toBe(403);
    const rows = await withTenants([T], (c) =>
      c.query(`SELECT id FROM employees WHERE tenant_id = $1 AND work_email = 'sneaky@a.test'`, [T]),
      { modules: ["hr"] },
    );
    expect(rows.rows).toHaveLength(0);
  });

  // ─────────────────────────── §5.2 mover ───────────────────────────

  it("THE MOVER CRITERION: after a transfer the old department denies and the new one allows", async () => {
    const hired = await hire({ displayName: "Mover", workEmail: "mover@a.test", positionId: webPosition });
    expect(hired.statusCode).toBe(201);
    const userId = hired.json().userId as string;
    const employeeId = hired.json().id as string;
    expect(await probe(userId, WEB)).toBe(200);

    const before = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId]),
    );

    const res = await app.inject({
      method: "POST", url: `/api/${T}/hr/employees/${employeeId}/transfer`,
      headers: asUser(companyAdmin), payload: { toPositionId: hrPosition, reason: "reorg" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.closedAssignmentIds).toHaveLength(1);

    // (a) no grant still points at the closed assignment
    const stale = await withGlobal((c) =>
      c.query(`SELECT id FROM user_roles WHERE managed_by_position = ANY($1::uuid[])`, [body.closedAssignmentIds]),
    );
    expect(stale.rows).toHaveLength(0);

    // (b) + (c) the live engine, not a bundle
    expect(await probe(userId, WEB)).toBe(403);
    expect(await probe(userId, HR)).toBe(200);

    // (d) the session was cut
    const after = await withGlobal((c) =>
      c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId]),
    );
    expect(after.rows[0].session_version).toBeGreaterThan(before.rows[0].session_version);

    // the blob moved too — otherwise the next org PUT's sweep would silently revert the transfer
    const oum = await withTenants([T], (c) =>
      c.query<{ unit_node_id: string }>(
        `SELECT unit_node_id FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`,
        [T, userId],
      ),
    );
    expect(oum.rows[0].unit_node_id).toBe("d-hr");
  });

  it("transferring to the seat already held is an idempotent no-op", async () => {
    const hired = await hire({ displayName: "Stayer", workEmail: "stayer@a.test", positionId: hrPosition });
    const employeeId = hired.json().id as string;
    const res = await app.inject({
      method: "POST", url: `/api/${T}/hr/employees/${employeeId}/transfer`,
      headers: asUser(companyAdmin), payload: { toPositionId: hrPosition },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().unchanged).toBe(true);
  });

  it("a retried transfer converges instead of stacking seats", async () => {
    const hired = await hire({ displayName: "Retried Mover", workEmail: "retrymove@a.test", positionId: webPosition });
    const employeeId = hired.json().id as string;
    const userId = hired.json().userId as string;
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "POST", url: `/api/${T}/hr/employees/${employeeId}/transfer`,
        headers: asUser(companyAdmin), payload: { toPositionId: hrPosition },
      });
      expect(res.statusCode).toBe(200);
    }
    const open = await withTenants([T], (c) =>
      c.query(`SELECT id FROM position_assignments WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`, [T, userId]),
    );
    expect(open.rows).toHaveLength(1);
  });

  // ─────────────────────────── §5.3 leaver ───────────────────────────

  it("terminates: seats close, manual grants are revoked and reported, access dies, login disabled", async () => {
    const hired = await hire({ displayName: "Leaver", workEmail: "leaver@a.test", positionId: hrPosition });
    const employeeId = hired.json().id as string;
    const userId = hired.json().userId as string;
    // A grant nobody's seat justifies — §5.3 requires the flow to revoke it and report it, which the
    // reconciler alone would deliberately leave standing (it only tears down what a seat claimed).
    await grantRole(userId, await createRole("member"), "company", T);
    expect(await probe(userId, HR)).toBe(200);

    const res = await app.inject({
      method: "POST", url: `/api/${T}/hr/employees/${employeeId}/terminate`,
      headers: asUser(companyAdmin), payload: { reason: "resigned" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.closedAssignmentIds).toHaveLength(1);
    expect(body.revokedManualGrants.map((g: { role: string }) => g.role)).toContain("member");
    expect(body.userDisabled).toBe(true);
    expect(body.itFollowUp).toBe("disable_login");

    // `assemblePrincipal()` returns null for a disabled user, so access is gone before Keycloak is
    // touched at all — the probe helper reports that as 401.
    expect(await probe(userId, HR)).toBe(401);

    const emp = await withTenants([T], (c) =>
      c.query<{ employment_status: string }>(`SELECT employment_status FROM employees WHERE id = $1`, [employeeId]),
      { modules: ["hr"] },
    );
    expect(emp.rows[0].employment_status).toBe("terminated");
    const mem = await withTenants([T], (c) =>
      c.query<{ status: string }>(`SELECT status FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`, [T, userId]),
    );
    expect(mem.rows[0].status).toBe("inactive");
  });

  it("a retried termination is idempotent", async () => {
    const hired = await hire({ displayName: "Twice Gone", workEmail: "twice@a.test", positionId: webPosition });
    const employeeId = hired.json().id as string;
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "POST", url: `/api/${T}/hr/employees/${employeeId}/terminate`, headers: asUser(companyAdmin), payload: {},
      });
      expect(res.statusCode).toBe(200);
    }
    const open = await withTenants([T], (c) =>
      c.query(`SELECT id FROM position_assignments WHERE tenant_id = $1 AND user_id = $2 AND valid_to IS NULL`, [
        T, hired.json().userId,
      ]),
    );
    expect(open.rows).toHaveLength(0);
  });

  it("does NOT disable a login when the person still works at another group company", async () => {
    const other = await createCompany("Other Group Co", ["hr"]);
    const hired = await hire({ displayName: "Dual Employed", workEmail: "dual@a.test", positionId: webPosition });
    const employeeId = hired.json().id as string;
    const userId = hired.json().userId as string;
    await addMembership(other, userId);

    const res = await app.inject({
      method: "POST", url: `/api/${T}/hr/employees/${employeeId}/terminate`, headers: asUser(companyAdmin), payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userDisabled).toBe(false);
    const u = await withGlobal((c) => c.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId]));
    expect(u.rows[0].status).toBe("active");
  });

  // ─────────────────────────── record edits ───────────────────────────

  it("refuses `employmentStatus: terminated` as a field edit, and refuses deleting a seated employee", async () => {
    const hired = await hire({ displayName: "Guarded", workEmail: "guarded@a.test", positionId: webPosition });
    const employeeId = hired.json().id as string;

    const patch = await app.inject({
      method: "PATCH", url: `/api/${T}/hr/employees/${employeeId}`,
      headers: asUser(hrManager), payload: { employmentStatus: "terminated" },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().error).toContain("/terminate");

    const del = await app.inject({
      method: "DELETE", url: `/api/${T}/hr/employees/${employeeId}`, headers: asUser(hrManager),
    });
    expect(del.statusCode).toBe(400);
    expect(del.json().error).toContain("terminate first");
  });

  it("reads are gated: a member gets 403 on the list, HR sees rows", async () => {
    const plain = await createUser("jml-reader@a.test");
    await addMembership(T, plain);
    await grantRole(plain, await createRole("member"), "company", T);
    const denied = await app.inject({ method: "GET", url: `/api/${T}/hr/employees`, headers: asUser(plain) });
    expect(denied.statusCode).toBe(403);
    const allowed = await app.inject({ method: "GET", url: `/api/${T}/hr/employees`, headers: asUser(hrManager) });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().employees.length).toBeGreaterThan(0);
  });
});
