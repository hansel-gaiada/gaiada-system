// ORG-6 — reconciler correctness suite against LIVE Postgres (skips without DATABASE_URL_TEST).
// No Cerbos: the reconciler has no authz path — it materializes the memberships/grants that
// Cerbos+RLS later read. These tests prove: idempotent convergence, the owner acceptance scenario
// (1 HR unit → 3 companies, each sees only its slice), teardown precision, the deletion guard
// (never touches employee/manual rows), refcount overlap (RT-4), A14 admin-collision,
// suspend/resume, re-link re-diff, orphan-freeze, and skipped stale assigneeIds.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "../db";
import { config } from "../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";
import {
  reconcileAssignment,
  reconcileProvider,
  adoptManagedGrantAsManual,
  collectSubtreePersons,
} from "./service-reconciler";

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
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, 'main')
       ON CONFLICT (tenant_id) DO UPDATE SET structure = $2, updated_at = now()`,
      [tenant, JSON.stringify({ root })],
    ),
  );
}

async function createUnit(provider: string, nodeId: string, name = "HR", kind = "department"): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,$3,$4,$5)`, [
      id,
      provider,
      nodeId,
      kind,
      name,
    ]),
  );
  return id;
}

async function createAssignment(
  unitId: string,
  provider: string,
  target: string,
  opts: { status?: string; lead?: string | null; module?: string; createdBy: string },
): Promise<string> {
  const id = newId();
  await withTenants([provider], (c) =>
    c.query(
      `INSERT INTO service_assignments
         (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, lead_user_id,
          unit_name, unit_kind, unit_status, created_by, accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'HR','department','active',$8, now())`,
      [id, unitId, provider, target, opts.module ?? "hr", opts.status ?? "active", opts.lead ?? null, opts.createdBy],
    ),
  );
  return id;
}

async function setStatus(provider: string, id: string, status: string): Promise<void> {
  await withTenants([provider], (c) =>
    c.query(`UPDATE service_assignments SET status = $2 WHERE id = $1`, [id, status]),
  );
}

// user_roles is a global (RLS-free) table.
async function grantsFor(userId: string, target: string): Promise<{ role: string; managed: boolean }[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ role: string; managed_by: string | null }>(
      `SELECT r.name AS role, ur.managed_by FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.scope_type = 'company' AND ur.scope_id = $2`,
      [userId, target],
    ),
  );
  return rows.map((r) => ({ role: r.role, managed: r.managed_by !== null }));
}

async function membershipFor(
  target: string,
  userId: string,
): Promise<{ kind: string; status: string; deleted: boolean; managed: boolean } | null> {
  const { rows } = await withTenants([target], (c) =>
    c.query<{ kind: string; status: string; deleted_at: string | null; managed_by: string | null }>(
      `SELECT kind, status, deleted_at, managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [target, userId],
    ),
  );
  if (!rows[0]) return null;
  return { kind: rows[0].kind, status: rows[0].status, deleted: rows[0].deleted_at !== null, managed: rows[0].managed_by !== null };
}

// service_grant_claims has FORCE RLS keyed on the TARGET tenant — must read under it.
async function claimCount(assignmentId: string, target: string): Promise<number> {
  const { rows } = await withTenants([target], (c) =>
    c.query<{ n: number }>(`SELECT count(*)::int AS n FROM service_grant_claims WHERE assignment_id = $1`, [
      assignmentId,
    ]),
  );
  return rows[0].n;
}

async function sessionVersion(userId: string): Promise<number> {
  const { rows } = await withGlobal((c) =>
    c.query<{ v: number }>(`SELECT session_version AS v FROM users WHERE id = $1`, [userId]),
  );
  return rows[0].v;
}

describe.skipIf(!TEST_URL)("service-assignment reconciler (ORG-6)", () => {
  let H: string;
  let actor: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceAssignmentsEnabled = true;
    H = await createCompany("Holding");
    actor = await createUser("exec@holding.test");
  });
  afterAll(teardownTestDb);

  // Each test gets its own provider/targets/users to avoid cross-test interference on the
  // global users/user_roles tables and the unit/target/module unique index.
  async function scenario(prefix: string, targetCount = 1) {
    const A = await createCompany(`${prefix}-provider`, [], H);
    const targets: string[] = [];
    for (let i = 0; i < targetCount; i++) targets.push(await createCompany(`${prefix}-target-${i}`, [], H));
    const u1 = await createUser(`${prefix}-u1@x.test`);
    const u2 = await createUser(`${prefix}-u2@x.test`);
    const u3 = await createUser(`${prefix}-u3@x.test`);
    await addMembership(A, u1);
    await addMembership(A, u2);
    await addMembership(A, u3);
    // d-hr department: u1 under a 'role' node, u2/u3 direct persons.
    await setBlob(A, {
      id: "root",
      name: prefix,
      kind: "company",
      children: [
        {
          id: "d-hr",
          name: "HR",
          kind: "department",
          children: [
            { id: "r-lead", name: "Lead", kind: "role", children: [{ id: "p1", name: "U1", kind: "person", assigneeId: u1 }] },
            { id: "p2", name: "U2", kind: "person", assigneeId: u2 },
            { id: "p3", name: "U3", kind: "person", assigneeId: u3 },
          ],
        },
      ],
    });
    const unitId = await createUnit(A, "d-hr");
    return { A, targets, u1, u2, u3, unitId };
  }

  it("pure blob walk collects distinct person assigneeIds in the subtree", () => {
    const persons = collectSubtreePersons({
      id: "d-hr",
      name: "HR",
      kind: "department",
      children: [
        { id: "x", name: "x", kind: "division", children: [{ id: "p1", name: "p", kind: "person", assigneeId: "u1" }] },
        { id: "p2", name: "p", kind: "person", assigneeId: "u2" },
        { id: "p3", name: "p", kind: "person", assigneeId: "u2" }, // dup collapses
        { id: "p4", name: "p", kind: "person", assigneeId: null }, // no assignee ignored
      ],
    });
    expect(persons.sort()).toEqual(["u1", "u2"]);
  });

  it("materializes lead→_manager, rest→_staff; is IDEMPOTENT (second run changes nothing)", async () => {
    const s = await scenario("idem");
    const asg = await createAssignment(s.unitId, s.A, s.targets[0], { lead: s.u1, createdBy: actor });
    const B = s.targets[0];

    const r1 = await reconcileAssignment(asg, s.A);
    expect(r1?.granted).toBe(3);
    expect(r1?.revoked).toBe(0);
    expect((await grantsFor(s.u1, B))).toEqual([{ role: "hr_manager", managed: true }]);
    expect((await grantsFor(s.u2, B))).toEqual([{ role: "hr_staff", managed: true }]);
    expect((await grantsFor(s.u3, B))).toEqual([{ role: "hr_staff", managed: true }]);
    for (const u of [s.u1, s.u2, s.u3]) {
      const m = await membershipFor(B, u);
      expect(m).toMatchObject({ kind: "service", status: "active", deleted: false, managed: true });
    }
    // 3 membership claims + 3 grant claims
    expect(await claimCount(asg, B)).toBe(6);
    const v1 = await sessionVersion(s.u1);

    const r2 = await reconcileAssignment(asg, s.A);
    expect(r2?.granted).toBe(0);
    expect(r2?.revoked).toBe(0);
    expect(await claimCount(asg, B)).toBe(6); // no duplicate claims
    expect((await grantsFor(s.u1, B))).toEqual([{ role: "hr_manager", managed: true }]);
    expect(await sessionVersion(s.u1)).toBe(v1); // no session bump on a no-op pass
  });

  it("OWNER ACCEPTANCE: one HR unit serving 3 companies — each target sees ONLY its own slice", async () => {
    const s = await scenario("accept", 3);
    const [B, C, D] = s.targets;
    const aB = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    const aC = await createAssignment(s.unitId, s.A, C, { lead: s.u1, createdBy: actor });
    const aD = await createAssignment(s.unitId, s.A, D, { lead: s.u1, createdBy: actor });

    await reconcileAssignment(aB, s.A);
    await reconcileAssignment(aC, s.A);
    await reconcileAssignment(aD, s.A);

    // u2 is hr_staff in B, C AND D — but each grant is scoped to exactly one target.
    for (const t of [B, C, D]) expect(await grantsFor(s.u2, t)).toEqual([{ role: "hr_staff", managed: true }]);
    // No leak: B's grant set for u2 contains nothing scoped to C or D (scope is per-target).
    const u2AllScopes = await withGlobal((c) =>
      c.query<{ scope_id: string }>(
        `SELECT scope_id FROM user_roles WHERE user_id = $1 AND scope_type = 'company'`,
        [s.u2],
      ),
    );
    expect(new Set(u2AllScopes.rows.map((r) => r.scope_id))).toEqual(new Set([B, C, D]));
    // Revoking the B leg tears down ONLY B; C and D untouched (teardown precision + no leak).
    await setStatus(s.A, aB, "revoked");
    await reconcileAssignment(aB, s.A);
    expect(await grantsFor(s.u2, B)).toEqual([]);
    expect(await grantsFor(s.u2, C)).toEqual([{ role: "hr_staff", managed: true }]);
    expect(await grantsFor(s.u2, D)).toEqual([{ role: "hr_staff", managed: true }]);
    expect((await membershipFor(B, s.u2))).toMatchObject({ status: "inactive", deleted: true });
    expect((await membershipFor(C, s.u2))).toMatchObject({ status: "active", deleted: false });
  });

  it("REVOKE tears down exactly the managed rows — the deletion guard spares EMPLOYEE + MANUAL rows", async () => {
    const s = await scenario("guard");
    const B = s.targets[0];
    // u3 is a pre-existing EMPLOYEE of B (not reconciler-owned).
    await addMembership(B, s.u3);
    // u2 has a pre-existing MANUAL hr_staff grant in B (managed_by NULL).
    const hrStaff = (
      await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM roles WHERE company_id IS NULL AND name='hr_staff'`))
    ).rows[0].id;
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'company',$4)`, [
        newId(),
        s.u2,
        hrStaff,
        B,
      ]),
    );

    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);
    // u2's grant is the manual one — reconciler recorded NO grant claim on it (A2).
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: false }]);
    // u3's employee membership was claimed but not converted.
    expect((await membershipFor(B, s.u3))).toMatchObject({ kind: "employee", status: "active" });

    await setStatus(s.A, asg, "revoked");
    await reconcileAssignment(asg, s.A);
    // Managed artifacts gone (u1 manager grant + u1 service membership); u3 got a managed grant too.
    expect(await grantsFor(s.u1, B)).toEqual([]);
    expect((await membershipFor(B, s.u1))).toMatchObject({ kind: "service", status: "inactive", deleted: true });
    // GUARD: employee membership survives; manual grant survives.
    expect((await membershipFor(B, s.u3))).toMatchObject({ kind: "employee", status: "active", deleted: false });
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: false }]);
  });

  it("REFCOUNT (RT-4): a shared grant survives while ANY assignment still claims it", async () => {
    const s = await scenario("refcount");
    const B = s.targets[0];
    // Second unit in the SAME provider that also contains u2.
    await setBlob(s.A, {
      id: "root",
      name: "refcount",
      kind: "company",
      children: [
        { id: "d-hr", name: "HR", kind: "department", children: [{ id: "p2", name: "U2", kind: "person", assigneeId: s.u2 }] },
        { id: "d-hr2", name: "HR2", kind: "department", children: [{ id: "p2b", name: "U2", kind: "person", assigneeId: s.u2 }] },
      ],
    });
    const unit2 = await createUnit(s.A, "d-hr2", "HR2");
    const asg1 = await createAssignment(s.unitId, s.A, B, { createdBy: actor });
    const asg2 = await createAssignment(unit2, s.A, B, { createdBy: actor });

    await reconcileAssignment(asg1, s.A);
    await reconcileAssignment(asg2, s.A);
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: true }]); // ONE grant, two claims

    await setStatus(s.A, asg1, "revoked");
    await reconcileAssignment(asg1, s.A);
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: true }]); // still claimed by asg2
    expect((await membershipFor(B, s.u2))).toMatchObject({ status: "active" });

    await setStatus(s.A, asg2, "revoked");
    await reconcileAssignment(asg2, s.A);
    expect(await grantsFor(s.u2, B)).toEqual([]); // last claim gone → deleted
    expect((await membershipFor(B, s.u2))).toMatchObject({ status: "inactive", deleted: true });
  });

  it("A14 admin-collision: converting a managed grant to manual immunizes it from a later revoke", async () => {
    const s = await scenario("a14");
    const B = s.targets[0];
    const asg = await createAssignment(s.unitId, s.A, B, { createdBy: actor });
    await reconcileAssignment(asg, s.A);
    const urId = (
      await withGlobal((c) =>
        c.query<{ id: string; name: string }>(
          `SELECT ur.id, r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           WHERE ur.user_id = $1 AND ur.scope_id = $2 AND ur.managed_by IS NOT NULL`,
          [s.u2, B],
        ),
      )
    ).rows[0].id;

    await adoptManagedGrantAsManual(B, { userRoleId: urId });
    // Now revoke: the row is manual (managed_by NULL, claims cleared) → must NOT be deleted.
    await setStatus(s.A, asg, "revoked");
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: false }]);
  });

  it("SUSPEND strips grants but KEEPS the edge; RESUME re-materializes", async () => {
    const s = await scenario("suspend");
    const B = s.targets[0];
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);

    await setStatus(s.A, asg, "suspended");
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u1, B)).toEqual([]); // desired-empty
    expect(await claimCount(asg, B)).toBe(0);
    // edge kept
    const stillThere = await withTenants([s.A], (c) =>
      c.query(`SELECT 1 FROM service_assignments WHERE id = $1 AND status = 'suspended'`, [asg]),
    );
    expect(stillThere.rowCount).toBe(1);

    await setStatus(s.A, asg, "active");
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);
    expect((await membershipFor(B, s.u1))).toMatchObject({ status: "active", deleted: false }); // resurrected
  });

  it("RE-LINK / re-diff: a person moved OUT of a present unit loses access; others intact", async () => {
    const s = await scenario("rediff");
    const B = s.targets[0];
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u3, B)).toEqual([{ role: "hr_staff", managed: true }]);

    // u3 moved out of d-hr (unit still present).
    await setBlob(s.A, {
      id: "root",
      name: "rediff",
      kind: "company",
      children: [
        {
          id: "d-hr",
          name: "HR",
          kind: "department",
          children: [
            { id: "r-lead", name: "Lead", kind: "role", children: [{ id: "p1", name: "U1", kind: "person", assigneeId: s.u1 }] },
            { id: "p2", name: "U2", kind: "person", assigneeId: s.u2 },
          ],
        },
      ],
    });
    const r = await reconcileAssignment(asg, s.A);
    expect(r?.revoked).toBe(1);
    expect(await grantsFor(s.u3, B)).toEqual([]);
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: true }]);
  });

  it("ORPHAN-FREEZE: unit node vanishes → grants FROZEN, not stripped; unit flagged orphaned", async () => {
    const s = await scenario("orphan");
    const B = s.targets[0];
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await reconcileAssignment(asg, s.A);
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);

    // d-hr disappears from the blob entirely.
    await setBlob(s.A, { id: "root", name: "orphan", kind: "company", children: [] });
    const r = await reconcileAssignment(asg, s.A);
    expect(r?.orphaned).toBe(true);
    // FROZEN: grants remain standing.
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);
    const unit = await withTenants([s.A], (c) =>
      c.query<{ status: string }>(`SELECT status FROM org_units WHERE id = $1`, [s.unitId]),
    );
    expect(unit.rows[0].status).toBe("orphaned");
    const asgRow = await withTenants([s.A], (c) =>
      c.query<{ unit_status: string }>(`SELECT unit_status FROM service_assignments WHERE id = $1`, [asg]),
    );
    expect(asgRow.rows[0].unit_status).toBe("orphaned");
  });

  it("skips + reports a stale/bogus assigneeId (no membership in the provider)", async () => {
    const s = await scenario("stale");
    const B = s.targets[0];
    const ghost = newId(); // a user id with no membership in A
    await setBlob(s.A, {
      id: "root",
      name: "stale",
      kind: "company",
      children: [
        {
          id: "d-hr",
          name: "HR",
          kind: "department",
          children: [
            { id: "p2", name: "U2", kind: "person", assigneeId: s.u2 },
            { id: "pg", name: "ghost", kind: "person", assigneeId: ghost },
          ],
        },
      ],
    });
    const asg = await createAssignment(s.unitId, s.A, B, { createdBy: actor });
    const r = await reconcileAssignment(asg, s.A);
    expect(r?.skipped).toContain(ghost);
    expect(await grantsFor(s.u2, B)).toEqual([{ role: "hr_staff", managed: true }]);
    expect(await grantsFor(ghost, B)).toEqual([]);
  });

  it("reconcileProvider re-diffs every live-ish assignment of a provider (org-PUT path)", async () => {
    const s = await scenario("provider", 2);
    const [B, C] = s.targets;
    await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    await createAssignment(s.unitId, s.A, C, { lead: s.u1, createdBy: actor });
    const results = await reconcileProvider(s.A);
    expect(results.length).toBe(2);
    expect(await grantsFor(s.u1, B)).toEqual([{ role: "hr_manager", managed: true }]);
    expect(await grantsFor(s.u1, C)).toEqual([{ role: "hr_manager", managed: true }]);
  });

  it("flag OFF ⇒ reconciler is a no-op (release-train dark default)", async () => {
    const s = await scenario("flagoff");
    const B = s.targets[0];
    const asg = await createAssignment(s.unitId, s.A, B, { lead: s.u1, createdBy: actor });
    config.serviceAssignmentsEnabled = false;
    try {
      const r = await reconcileAssignment(asg, s.A);
      expect(r).toBeNull();
      expect(await grantsFor(s.u1, B)).toEqual([]);
    } finally {
      config.serviceAssignmentsEnabled = true;
    }
  });
});
