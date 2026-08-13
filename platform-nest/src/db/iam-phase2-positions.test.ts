// P2-01 — IAM Phase 2 foundation: employees / positions / position_roles / position_assignments /
// position_grant_claims + the user_roles provenance columns (migration 0109). Schema-only ticket;
// this suite proves the DDL, not any reconciler/controller behavior (none exists yet).
//
// Verified through the NOSUPERUSER NOBYPASSRLS app role (initTestDb), so RLS/FORCE RLS is actually
// exercised, not merely declared.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole } from "../testing/fixtures";

// withTenants + declare the hr module scope (models withTenants([t],{modules:['hr']})).
async function withHr<T>(tenantIds: string[], fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  return withTenants(tenantIds, async (c) => {
    await c.query("SELECT set_config('app.scopes', 'hr', true)");
    return fn(c);
  });
}

const NEW_TABLES = ["employees", "positions", "position_roles", "position_assignments", "position_grant_claims"];

describe.skipIf(!TEST_URL)("IAM Phase 2 substrate (0109) — employees/positions/*", () => {
  let A: string; // tenant A
  let B: string; // tenant B (unrelated, for isolation checks)
  let actor: string;
  let memberRoleId: string;
  let orgUnitLeadRoleId: string;
  let platformAdminRoleId: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Tenant A");
    B = await createCompany("Tenant B");
    actor = await createUser("actor@a.test");
    // Global baseline roles seeded by 0095/0102 in a migrations-only DB.
    memberRoleId = await createRole("member", null);
    orgUnitLeadRoleId = await createRole("org_unit_lead", null);
    platformAdminRoleId = await createRole("platform_admin", null);
  });
  afterAll(teardownTestDb);

  // ── (1) FORCE RLS on all five new tables ─────────────────────────────────────────────────────
  it("all five new tables FORCE RLS", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE relkind='r' AND relname = ANY($1::text[]) ORDER BY relname`,
        [NEW_TABLES],
      ),
    );
    expect(rows.map((r) => r.relname)).toEqual([...NEW_TABLES].sort());
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname} must FORCE RLS`).toBe(true);
  });

  it("positions/position_roles/position_assignments/position_grant_claims each have exactly one FOR-ALL tenant_isolation policy", async () => {
    const coreTables = ["positions", "position_roles", "position_assignments", "position_grant_claims"];
    const { rows } = await withGlobal((c) =>
      c.query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename = ANY($1::text[]) ORDER BY tablename`,
        [coreTables],
      ),
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual([...coreTables].sort());
    for (const r of rows) {
      expect(r.policyname, r.tablename).toBe("tenant_isolation");
      expect(r.cmd, r.tablename).toBe("ALL");
    }
  });

  // ── (2) core-wall tenant isolation (positions et al.) ────────────────────────────────────────
  it("a position in tenant A is invisible under tenant B's GUC, visible under A's", async () => {
    const posId = newId();
    await withTenants([A], (c) =>
      c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,'d-web','Engineer')`, [
        posId,
        A,
      ]),
    );
    const seenA = await withTenants([A], (c) => c.query(`SELECT id FROM positions WHERE id=$1`, [posId]));
    const seenB = await withTenants([B], (c) => c.query(`SELECT id FROM positions WHERE id=$1`, [posId]));
    expect(seenA.rows.length).toBe(1);
    expect(seenB.rows.length).toBe(0);
  });

  it("no tenant GUC at all -> zero rows on positions (fail-closed, not an error)", async () => {
    const res = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM positions`));
    expect(res.rows[0].n).toBe(0);
  });

  it("cannot INSERT a position into a tenant outside the authorized set (WITH CHECK)", async () => {
    await expect(
      withTenants([A], (c) =>
        c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,'d-web','smuggled')`, [
          newId(),
          B,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── (3) the employees HR wall — module-scope isolation ───────────────────────────────────────
  let employeeId: string;
  it("an employee row is visible under withHr([A]) with tenant A's GUC", async () => {
    employeeId = newId();
    await withHr([A], (c) =>
      c.query(`INSERT INTO employees (id, tenant_id, display_name) VALUES ($1,$2,'Jane Doe')`, [employeeId, A]),
    );
    const seen = await withHr([A], (c) => c.query(`SELECT id FROM employees WHERE id=$1`, [employeeId]));
    expect(seen.rows.length).toBe(1);
  });

  it("right tenant WITHOUT the hr module scope declared -> zero rows (module wall proof, non-vacuous)", async () => {
    const withoutScope = await withTenants([A], (c) => c.query(`SELECT id FROM employees WHERE id=$1`, [employeeId]));
    expect(withoutScope.rows.length).toBe(0);
    // Non-vacuous: the SAME row, same tenant, WITH the scope declared, is non-zero.
    const withScope = await withHr([A], (c) => c.query(`SELECT id FROM employees WHERE id=$1`, [employeeId]));
    expect(withScope.rows.length).toBe(1);
  });

  it("right tenant with a DIFFERENT module scope declared -> zero rows on employees", async () => {
    const res = await withTenants([A], async (c) => {
      await c.query("SELECT set_config('app.scopes', 'finance', true)");
      return c.query(`SELECT id FROM employees WHERE id=$1`, [employeeId]);
    });
    expect(res.rows.length).toBe(0);
  });

  it("tenant B (wrong tenant) with hr scope declared still cannot see tenant A's employee", async () => {
    const res = await withHr([B], (c) => c.query(`SELECT id FROM employees WHERE id=$1`, [employeeId]));
    expect(res.rows.length).toBe(0);
  });

  it("WITH CHECK: cannot INSERT an employee without declaring the hr scope", async () => {
    await expect(
      withTenants([A], (c) =>
        c.query(`INSERT INTO employees (id, tenant_id, display_name) VALUES ($1,$2,'no-scope')`, [newId(), A]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ── (4) employees partial-unique: (tenant_id, user_id) WHERE user_id IS NOT NULL ─────────────
  it("many NULL-user_id employees are allowed (pending_start candidates)", async () => {
    await withHr([A], (c) =>
      c.query(`INSERT INTO employees (id, tenant_id, display_name) VALUES ($1,$2,'Candidate 1'), ($3,$2,'Candidate 2')`, [
        newId(),
        A,
        newId(),
      ]),
    );
    // No throw = pass; both rows coexist despite both having user_id NULL.
  });

  it("VIOLATION: a second employee row for the same (tenant_id, user_id) is rejected", async () => {
    const u = await createUser("linked-employee@a.test");
    await withHr([A], (c) =>
      c.query(`INSERT INTO employees (id, tenant_id, user_id, display_name) VALUES ($1,$2,$3,'First link')`, [
        newId(),
        A,
        u,
      ]),
    );
    await expect(
      withHr([A], (c) =>
        c.query(`INSERT INTO employees (id, tenant_id, user_id, display_name) VALUES ($1,$2,$3,'Duplicate link')`, [
          newId(),
          A,
          u,
        ]),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // ── (5) composite tenant-scoped FK: position_roles/position_assignments reject cross-tenant refs ─
  it("VIOLATION: position_roles cannot reference a position from a DIFFERENT tenant", async () => {
    const posInB = newId();
    await withTenants([B], (c) =>
      c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,'d-b','Seat')`, [posInB, B]),
    );
    // tenant_id=A but position_id belongs to B -> composite FK (position_id, tenant_id) fails.
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_roles (id, tenant_id, position_id, role_id) VALUES ($1,$2,$3,$4)`,
          [newId(), A, posInB, memberRoleId],
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // ── (6) the §2.3 guard trigger — denied-role registry ────────────────────────────────────────
  async function makePosition(tenantId: string, unit = "d-web"): Promise<string> {
    const id = newId();
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,$3,'Seat')`, [
        id,
        tenantId,
        unit,
      ]),
    );
    return id;
  }

  it("VIOLATION: attaching platform_admin to a position is rejected (denied-role registry)", async () => {
    const posId = await makePosition(A);
    await expect(
      withTenants([A], (c) =>
        c.query(`INSERT INTO position_roles (id, tenant_id, position_id, role_id) VALUES ($1,$2,$3,$4)`, [
          newId(),
          A,
          posId,
          platformAdminRoleId,
        ]),
      ),
    ).rejects.toThrow(/denied-role registry/);
  });

  it("TEETH: dropping trg_position_roles_guard lets the denied role through (proves the trigger, not something else, blocks it)", async () => {
    // Requires table-owner privilege (DROP/CREATE TRIGGER) — the app role (platform_app_test) does
    // not own position_roles, so this uses adminPool() directly (the migration-owner connection),
    // never the RLS-bound app pool. The INSERT itself still runs through withTenants (app role) so
    // the RLS wall stays real; only the trigger's presence is toggled.
    const posId = await makePosition(A);
    await adminPool().query(`DROP TRIGGER trg_position_roles_guard ON position_roles`);
    try {
      const res = await withTenants([A], (c) =>
        c.query(`INSERT INTO position_roles (id, tenant_id, position_id, role_id) VALUES ($1,$2,$3,$4)`, [
          newId(),
          A,
          posId,
          platformAdminRoleId,
        ]),
      );
      expect(res.rowCount).toBe(1); // succeeds with the guard gone -> RED without the trigger
    } finally {
      // Restore for every subsequent test in this file.
      await adminPool().query(
        `CREATE TRIGGER trg_position_roles_guard BEFORE INSERT OR UPDATE ON position_roles
         FOR EACH ROW EXECUTE FUNCTION position_roles_guard()`,
      );
    }
  });

  it("re-attempting the same denied-role insert AFTER the trigger is restored is rejected again", async () => {
    const posId = await makePosition(A);
    await expect(
      withTenants([A], (c) =>
        c.query(`INSERT INTO position_roles (id, tenant_id, position_id, role_id) VALUES ($1,$2,$3,$4)`, [
          newId(),
          A,
          posId,
          platformAdminRoleId,
        ]),
      ),
    ).rejects.toThrow(/denied-role registry/);
  });

  // ── (7) the §2.3 guard trigger — scope-shape check ───────────────────────────────────────────
  it("VIOLATION: org_unit_lead at scope_kind='company' is rejected (its own Cerbos condition never reaches company scope)", async () => {
    const posId = await makePosition(A);
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
          [newId(), A, posId, orgUnitLeadRoleId],
        ),
      ),
    ).rejects.toThrow(/never reaches company scope/);
  });

  it("POSITIVE CONTROL: org_unit_lead at scope_kind='own_unit' is accepted", async () => {
    const posId = await makePosition(A);
    const res = await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'own_unit')`,
        [newId(), A, posId, orgUnitLeadRoleId],
      ),
    );
    expect(res.rowCount).toBe(1);
  });

  it("POSITIVE CONTROL: an unconstrained role (agency_approver — absent from scope-constrained-roles.json, per its own failOpenNote) is accepted at either scope_kind", async () => {
    // NOTE: 'member' is itself constrained in scope-constrained-roles.json (reachable:
    // company/global/project — NOT org_unit), so it is deliberately NOT used as the "unconstrained"
    // exemplar here; agency_approver (0096) is the JSON's own documented example of a role absent
    // from the map (module_staff/module_manager/module_approver-composed names).
    const posId = await makePosition(A);
    const agencyApproverRoleId = await createRole("agency_approver", null);
    const r1 = await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
        [newId(), A, posId, agencyApproverRoleId],
      ),
    );
    const r2 = await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'own_unit')`,
        [newId(), A, posId, agencyApproverRoleId],
      ),
    );
    expect(r1.rowCount).toBe(1);
    expect(r2.rowCount).toBe(1);
  });

  // ── (8) position_roles UNIQUE (position_id, role_id, scope_kind) ────────────────────────────
  it("VIOLATION: the same (position, role, scope_kind) triple twice is rejected", async () => {
    const posId = await makePosition(A);
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
        [newId(), A, posId, memberRoleId],
      ),
    );
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
          [newId(), A, posId, memberRoleId],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // ── (9) position_assignments EXCLUDE: no overlapping duplicate seat by the same person ───────
  it("VIOLATION: overlapping assignment of the SAME seat to the SAME person is rejected", async () => {
    const posId = await makePosition(A);
    const holder = await createUser("holder-1@a.test");
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from) VALUES ($1,$2,$3,$4,'2026-01-01')`,
        [newId(), A, posId, holder],
      ),
    );
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from) VALUES ($1,$2,$3,$4,'2026-02-01')`,
          [newId(), A, posId, holder],
        ),
      ),
    ).rejects.toThrow(/conflicting key|exclusion constraint/i);
  });

  it("POSITIVE CONTROL: the SAME person may hold TWO DIFFERENT concurrent positions (union semantics, owner decision Q3)", async () => {
    const posId1 = await makePosition(A, "d-web");
    const posId2 = await makePosition(A, "d-hr");
    const holder = await createUser("holder-2@a.test");
    const r1 = await withTenants([A], (c) =>
      c.query(`INSERT INTO position_assignments (id, tenant_id, position_id, user_id) VALUES ($1,$2,$3,$4)`, [
        newId(),
        A,
        posId1,
        holder,
      ]),
    );
    const r2 = await withTenants([A], (c) =>
      c.query(`INSERT INTO position_assignments (id, tenant_id, position_id, user_id) VALUES ($1,$2,$3,$4)`, [
        newId(),
        A,
        posId2,
        holder,
      ]),
    );
    expect(r1.rowCount).toBe(1);
    expect(r2.rowCount).toBe(1);
  });

  it("POSITIVE CONTROL: re-assigning the SAME seat to the SAME person AFTER closing the prior interval is accepted (no false-positive overlap)", async () => {
    const posId = await makePosition(A);
    const holder = await createUser("holder-3@a.test");
    const firstId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from) VALUES ($1,$2,$3,$4,'2026-01-01')`,
        [firstId, A, posId, holder],
      ),
    );
    await withTenants([A], (c) =>
      c.query(`UPDATE position_assignments SET valid_to = '2026-03-01' WHERE id = $1`, [firstId]),
    );
    const res = await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_assignments (id, tenant_id, position_id, user_id, valid_from) VALUES ($1,$2,$3,$4,'2026-03-02')`,
        [newId(), A, posId, holder],
      ),
    );
    expect(res.rowCount).toBe(1);
  });

  it("VIOLATION: composite FK rejects a position_assignment pointing at a position from a DIFFERENT tenant", async () => {
    const posInB = await makePosition(B, "d-b2");
    const holder = await createUser("holder-4@a.test");
    await expect(
      withTenants([A], (c) =>
        c.query(`INSERT INTO position_assignments (id, tenant_id, position_id, user_id) VALUES ($1,$2,$3,$4)`, [
          newId(),
          A,
          posInB,
          holder,
        ]),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // ── (10) position_grant_claims: num_nonnulls=1 CHECK + partial uniques ───────────────────────
  async function makeAssignment(tenantId: string): Promise<{ assignmentId: string; userRoleId: string }> {
    const posId = await makePosition(tenantId, `d-claims-${newId()}`);
    const holder = await createUser(`claims-holder-${newId()}@a.test`);
    const assignmentId = newId();
    await withTenants([tenantId], (c) =>
      c.query(`INSERT INTO position_assignments (id, tenant_id, position_id, user_id) VALUES ($1,$2,$3,$4)`, [
        assignmentId,
        tenantId,
        posId,
        holder,
      ]),
    );
    await grantRole(holder, memberRoleId, "company", tenantId);
    const { rows } = await withGlobal((c) =>
      c.query<{ id: string }>(
        `SELECT id FROM user_roles WHERE user_id=$1 AND role_id=$2 AND scope_type='company' AND scope_id=$3`,
        [holder, memberRoleId, tenantId],
      ),
    );
    return { assignmentId, userRoleId: rows[0].id };
  }

  it("VIOLATION: a claim with BOTH membership_id and user_role_id NULL is rejected (num_nonnulls=1)", async () => {
    const { assignmentId } = await makeAssignment(A);
    await expect(
      withTenants([A], (c) =>
        c.query(`INSERT INTO position_grant_claims (id, tenant_id, position_assignment_id) VALUES ($1,$2,$3)`, [
          newId(),
          A,
          assignmentId,
        ]),
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("VIOLATION: a claim with BOTH membership_id and user_role_id set is rejected (num_nonnulls=1)", async () => {
    const { assignmentId, userRoleId } = await makeAssignment(A);
    const membership = await withTenants([A], (c) =>
      c.query<{ id: string }>(
        `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site) VALUES ($1,$2,$3,'test') RETURNING id`,
        [newId(), A, actor],
      ),
    );
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_grant_claims (id, tenant_id, position_assignment_id, membership_id, user_role_id) VALUES ($1,$2,$3,$4,$5)`,
          [newId(), A, assignmentId, membership.rows[0].id, userRoleId],
        ),
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("POSITIVE CONTROL: a claim with exactly ONE artifact (user_role_id) is accepted", async () => {
    const { assignmentId, userRoleId } = await makeAssignment(A);
    const res = await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_grant_claims (id, tenant_id, position_assignment_id, user_role_id) VALUES ($1,$2,$3,$4)`,
        [newId(), A, assignmentId, userRoleId],
      ),
    );
    expect(res.rowCount).toBe(1);
  });

  it("VIOLATION: a second claim for the SAME (assignment, user_role) pair is rejected (partial unique)", async () => {
    const { assignmentId, userRoleId } = await makeAssignment(A);
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO position_grant_claims (id, tenant_id, position_assignment_id, user_role_id) VALUES ($1,$2,$3,$4)`,
        [newId(), A, assignmentId, userRoleId],
      ),
    );
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_grant_claims (id, tenant_id, position_assignment_id, user_role_id) VALUES ($1,$2,$3,$4)`,
          [newId(), A, assignmentId, userRoleId],
        ),
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  // ── (11) user_roles additive columns: managed_by / managed_by_position exclusivity ───────────
  // A real service_assignments row (0026) so `managed_by`'s typed FK has a legitimate target —
  // provider=A, target=B (the CHECK requires provider_tenant_id <> target_tenant_id).
  async function makeServiceAssignment(): Promise<string> {
    const unitId = newId();
    await withTenants([A], (c) =>
      c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,$3,'department','HR')`, [
        unitId,
        A,
        `d-sa-${unitId}`,
      ]),
    );
    const saId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO service_assignments
           (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, created_by)
         VALUES ($1,$2,$3,$4,'hr','proposed','HR','department',$5)`,
        [saId, unitId, A, B, actor],
      ),
    );
    return saId;
  }

  it("VIOLATION: a user_roles row cannot carry BOTH managed_by and managed_by_position", async () => {
    const { assignmentId } = await makeAssignment(A);
    const saId = await makeServiceAssignment();
    const holder = await createUser("exclusivity-check@a.test");
    await grantRole(holder, memberRoleId, "global", null);
    const { rows } = await withGlobal((c) =>
      c.query<{ id: string }>(`SELECT id FROM user_roles WHERE user_id=$1 AND role_id=$2 AND scope_type='global'`, [
        holder,
        memberRoleId,
      ]),
    );
    await expect(
      withGlobal((c) =>
        c.query(`UPDATE user_roles SET managed_by=$2, managed_by_position=$3 WHERE id=$1`, [
          rows[0].id,
          saId,
          assignmentId,
        ]),
      ),
    ).rejects.toThrow(/violates check constraint/i);
  });

  it("POSITIVE CONTROL: managed_by_position alone is accepted, and existing grants with neither column set are unaffected", async () => {
    const { assignmentId } = await makeAssignment(A);
    const holder = await createUser("managed-alone@a.test");
    await grantRole(holder, memberRoleId, "global", null);
    const { rows } = await withGlobal((c) =>
      c.query<{ id: string }>(`SELECT id FROM user_roles WHERE user_id=$1 AND role_id=$2 AND scope_type='global'`, [
        holder,
        memberRoleId,
      ]),
    );
    const res = await withGlobal((c) =>
      c.query(`UPDATE user_roles SET managed_by_position=$2 WHERE id=$1`, [rows[0].id, assignmentId]),
    );
    expect(res.rowCount).toBe(1);

    // A pre-existing manual grant (both columns NULL) is untouched by the ALTER — zero rows altered
    // in VALUE, only in shape (new nullable columns default to NULL).
    const manualHolder = await createUser("manual-grant@a.test");
    await grantRole(manualHolder, memberRoleId, "global", null);
    const { rows: manualRows } = await withGlobal((c) =>
      c.query<{ managed_by: string | null; managed_by_position: string | null; expires_at: string | null }>(
        `SELECT managed_by, managed_by_position, expires_at FROM user_roles WHERE user_id=$1 AND role_id=$2 AND scope_type='global'`,
        [manualHolder, memberRoleId],
      ),
    );
    expect(manualRows[0].managed_by).toBeNull();
    expect(manualRows[0].managed_by_position).toBeNull();
    expect(manualRows[0].expires_at).toBeNull();
  });
});
