// P2-05 QA GATE — ADVERSARIAL suite for the position reconciler. Goal: TEARDOWN-GAP and
// OVER-REVOCATION hunting, not confirming the author's happy path. Every test below sets up the
// race, the double-claim, or the collision FIRST and then asserts the reconciler does not take the
// bait.
//
// Runs against LIVE disposable Postgres (skips without DATABASE_URL_TEST), through the
// NOSUPERUSER NOBYPASSRLS app role, so RLS is exercised rather than declared.
//
// VECTORS
//   1. refcount — two seats justifying ONE grant must not double-revoke on the first close
//   2. manual-grant adoption — a hand-made grant is neither stolen, duplicated, nor torn down
//   3. service-owned collision — a `managed_by` row is structurally untouchable from this path
//   4. A16 orphan freeze — an orphaned seat freezes, never strips
//   5. mass-revoke brake — fires at the REAL default threshold and writes NOTHING
//   6. dry-run/real parity — the same collector, proven by comparing the two plans
//   7. concurrency — two overlapping teardowns of one artifact leave no zero-claim live grant
//   8. flag-off — every entry point is inert
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "../db";
import { config } from "../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole } from "../testing/fixtures";
import {
  reconcileUser,
  reconcileTenant,
  reconcilePosition,
  reconcileAssignment,
  computePlan,
  adoptPositionGrantAsManual,
  MassRevokeBrakeError,
} from "./position-reconciler";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────
async function createPosition(tenant: string, unitNode: string, title: string): Promise<string> {
  const id = newId();
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,$3,$4)`, [
      id,
      tenant,
      unitNode,
      title,
    ]),
  );
  return id;
}

async function addPositionRole(
  tenant: string,
  positionId: string,
  roleId: string,
  scopeKind: "company" | "own_unit" = "company",
): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO position_roles (tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4)`, [
      tenant,
      positionId,
      roleId,
      scopeKind,
    ]),
  );
}

async function assign(tenant: string, positionId: string, userId: string): Promise<string> {
  const id = newId();
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO position_assignments (id, tenant_id, position_id, user_id) VALUES ($1,$2,$3,$4)`, [
      id,
      tenant,
      positionId,
      userId,
    ]),
  );
  return id;
}

/** Close a seat exactly as P2-06's transfer will: stamp `valid_to`. */
async function closeAssignment(tenant: string, assignmentId: string): Promise<void> {
  await withTenants([tenant], (c) =>
    c.query(`UPDATE position_assignments SET valid_to = current_date WHERE id = $1`, [assignmentId]),
  );
}

async function grantRows(userId: string): Promise<
  { id: string; role_id: string; scope_type: string; scope_id: string; managed_by: string | null; managed_by_position: string | null }[]
> {
  const { rows } = await withGlobal((c) =>
    c.query(
      `SELECT id, role_id, scope_type, scope_id, managed_by, managed_by_position
         FROM user_roles WHERE user_id = $1 ORDER BY scope_type, scope_id`,
      [userId],
    ),
  );
  return rows as never;
}

async function claimCount(tenant: string, userRoleId: string): Promise<number> {
  const { rows } = await withTenants([tenant], (c) =>
    c.query<{ n: number }>(`SELECT count(*)::int AS n FROM position_grant_claims WHERE user_role_id = $1`, [
      userRoleId,
    ]),
  );
  return rows[0].n;
}

async function claimsForAssignment(tenant: string, assignmentId: string): Promise<number> {
  const { rows } = await withTenants([tenant], (c) =>
    c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM position_grant_claims WHERE position_assignment_id = $1`,
      [assignmentId],
    ),
  );
  return rows[0].n;
}

async function sessionVersion(userId: string): Promise<number> {
  const { rows } = await withGlobal((c) =>
    c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [userId]),
  );
  return rows[0].session_version;
}

describe.skipIf(!TEST_URL)("P2-05 — position reconciler, adversarial", () => {
  let T: string;
  let memberRole: string;
  let viewerRole: string;
  let leadRole: string;
  const originalThreshold = config.positionMassRevokeThreshold;

  beforeAll(async () => {
    await initTestDb();
    T = await createCompany("Recon Tenant");
    memberRole = await createRole("member", null);
    viewerRole = await createRole("viewer", null);
    leadRole = await createRole("org_unit_lead", null);
    config.positionSyncEnabled = true;
  });
  afterAll(async () => {
    config.positionSyncEnabled = false;
    config.positionMassRevokeThreshold = originalThreshold;
    await teardownTestDb();
  });

  // ── 1. REFCOUNT: the double-claim. Two seats justify ONE grant. ────────────────────────────
  it("VECTOR 1 — two seats conferring the SAME (role, scope) produce ONE grant with TWO claims, and closing ONE revokes NOTHING", async () => {
    const u = await createUser("refcount@a.test");
    const p1 = await createPosition(T, "d-eng", "Engineer");
    const p2 = await createPosition(T, "d-ops", "On-call");
    // BOTH seats confer `member @ company` — the collision this vector exists to create.
    await addPositionRole(T, p1, memberRole, "company");
    await addPositionRole(T, p2, memberRole, "company");
    const a1 = await assign(T, p1, u);
    const a2 = await assign(T, p2, u);

    const r = await reconcileUser(T, u);
    expect(r!.granted).toBe(1); // ONE grant, not two — union semantics
    const rows = await grantRows(u);
    expect(rows).toHaveLength(1);
    expect(rows[0].managed_by_position).not.toBeNull();
    expect(await claimCount(T, rows[0].id)).toBe(2); // TWO claims — the refcount

    // Close the FIRST seat. The naive implementation deletes the grant here. The correct one
    // decrements to 1 and deletes nothing.
    await closeAssignment(T, a1);
    const r2 = await reconcileUser(T, u);
    expect(r2!.revoked, "closing one of two justifying seats must revoke NOTHING").toBe(0);
    expect(r2!.claimsDropped).toBe(1);
    expect(await grantRows(u)).toHaveLength(1);
    expect(await claimCount(T, rows[0].id)).toBe(1);
    expect(await claimsForAssignment(T, a1), "the closed seat's claim is gone").toBe(0);

    // Close the SECOND. Now — and only now — the refcount hits zero and the grant goes.
    await closeAssignment(T, a2);
    const r3 = await reconcileUser(T, u);
    expect(r3!.revoked).toBe(1);
    expect(await grantRows(u)).toHaveLength(0);
    expect(await claimsForAssignment(T, a2)).toBe(0);
  });

  // ── 2. MANUAL-GRANT ADOPTION: neither stolen nor duplicated ────────────────────────────────
  it("VECTOR 2 — a PRE-EXISTING manual grant is not stamped, not claimed, not duplicated, and survives the seat closing", async () => {
    const u = await createUser("manual@a.test");
    // A hand-made grant lands FIRST — both markers NULL. This is the row the reconciler must not
    // touch in either direction.
    const manualId = newId();
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'company',$4)`, [
        manualId,
        u,
        memberRole,
        T,
      ]),
    );
    const p = await createPosition(T, "d-eng", "Engineer");
    await addPositionRole(T, p, memberRole, "company"); // SAME (role, scope) as the manual grant
    const a = await assign(T, p, u);

    const r = await reconcileUser(T, u);
    expect(r!.granted, "the manual grant already satisfies this — mint nothing").toBe(0);
    const rows = await grantRows(u);
    expect(rows, "and do NOT create a duplicate row alongside it").toHaveLength(1);
    expect(rows[0].id).toBe(manualId);
    expect(rows[0].managed_by_position, "the marker must NOT be stamped on a manual row").toBeNull();
    expect(await claimCount(T, manualId), "no claim recorded — a revoke can never decrement it").toBe(0);

    // Now close the seat. A reconciler that had claimed the manual row would delete it here.
    await closeAssignment(T, a);
    const r2 = await reconcileUser(T, u);
    expect(r2!.revoked, "a manual grant is never hostage to a seat change").toBe(0);
    const after = await grantRows(u);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(manualId);
  });

  // ── 3. SERVICE-OWNED COLLISION ─────────────────────────────────────────────────────────────
  it("VECTOR 3 — a grant owned by the SERVICE reconciler (managed_by set) is not claimed, not re-marked, and not torn down", async () => {
    const u = await createUser("svcowned@a.test");
    // A REAL service_assignments row — `user_roles.managed_by` has a live FK to it, so a fake id
    // would only prove the FK works. Provider must differ from target (table CHECK).
    const provider = await createCompany("Svc Provider");
    const creator = await createUser("svccreator@a.test");
    const unitId = newId();
    await withTenants([provider], (c) =>
      c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,'d-svc','department','Svc')`, [
        unitId,
        provider,
      ]),
    );
    const svcAssignment = newId();
    await withTenants([provider], (c) =>
      c.query(
        `INSERT INTO service_assignments
           (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, created_by)
         VALUES ($1,$2,$3,$4,'hr','active','Svc','department',$5)`,
        [svcAssignment, unitId, provider, T, creator],
      ),
    );

    const grantId = newId();
    await withGlobal((c) =>
      c.query(`INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1,$2,$3,'company',$4)`, [
        grantId,
        u,
        viewerRole,
        T,
      ]),
    );
    // Mark it service-owned. 0109's exclusivity CHECK means managed_by_position can never also be
    // set on this row — so a reconciler that tried would ERROR rather than silently double-own.
    await withGlobal((c) =>
      c.query(`UPDATE user_roles SET managed_by = $2 WHERE id = $1`, [grantId, svcAssignment]),
    );

    const p = await createPosition(T, "d-eng", "Engineer");
    await addPositionRole(T, p, viewerRole, "company");
    const a = await assign(T, p, u);

    const r = await reconcileUser(T, u);
    expect(r!.granted).toBe(0);
    expect(await claimCount(T, grantId), "no claim on a service-owned row").toBe(0);
    const rows = await grantRows(u);
    expect(rows[0].managed_by_position, "never double-marked (0109 exclusivity CHECK)").toBeNull();

    await closeAssignment(T, a);
    const r2 = await reconcileUser(T, u);
    expect(r2!.revoked, "the position reconciler must not tear down a service-owned grant").toBe(0);
    expect(await grantRows(u)).toHaveLength(1);
  });

  // ── 4. A16 ORPHAN FREEZE ───────────────────────────────────────────────────────────────────
  it("VECTOR 4 — an ORPHANED position FREEZES the user's grants standing; it never strips them", async () => {
    const u = await createUser("orphan@a.test");
    const p = await createPosition(T, "d-gone", "Ghost");
    await addPositionRole(T, p, memberRole, "company");
    await assign(T, p, u);
    await reconcileUser(T, u);
    expect(await grantRows(u)).toHaveLength(1);

    // The org chart edit lands: the unit node vanished, so the position is orphaned.
    await withTenants([T], (c) => c.query(`UPDATE positions SET status = 'orphaned' WHERE id = $1`, [p]));

    const r = await reconcileUser(T, u);
    expect(r!.orphaned).toBe(true);
    expect(r!.revoked, "freeze-don't-revoke: a chart edit is never a mass revocation").toBe(0);
    expect(await grantRows(u), "the grant stays standing while frozen").toHaveLength(1);
  });

  // ── 5. MASS-REVOKE BRAKE, at the REAL default threshold ────────────────────────────────────
  it("VECTOR 5 — a batch exceeding the DEFAULT threshold is refused WHOLESALE and writes nothing", async () => {
    expect(config.positionMassRevokeThreshold, "the shipped default the design specifies").toBe(20);
    const T2 = await createCompany("Brake Tenant");
    const p = await createPosition(T2, "d-all", "Staffer");
    await addPositionRole(T2, p, memberRole, "company");

    // 21 people on one seat — one over the default threshold.
    const users: string[] = [];
    for (let i = 0; i < 21; i++) {
      const u = await createUser(`brake${i}@b.test`);
      users.push(u);
      await assign(T2, p, u);
    }
    const built = await reconcileTenant(T2);
    expect(built!.granted).toBe(21);

    // The org edit from hell: the seat is retired, so EVERY holder loses their grant at once.
    await withTenants([T2], (c) => c.query(`UPDATE positions SET status = 'retired' WHERE id = $1`, [p]));

    await expect(reconcileTenant(T2)).rejects.toThrow(MassRevokeBrakeError);
    // AND — the part that matters — nothing was applied. A brake that trips after revoking the
    // first twenty is not a brake.
    for (const u of users) {
      expect(await grantRows(u), `user ${u} must be untouched by the refused batch`).toHaveLength(1);
    }

    // force:true, after a dry-run review, applies it.
    const forced = await reconcileTenant(T2, { force: true });
    expect(forced!.revoked).toBe(21);
    for (const u of users) expect(await grantRows(u)).toHaveLength(0);
  });

  it("VECTOR 5b — the per-USER brake also fails closed (threshold lowered to make one user exceed it)", async () => {
    config.positionMassRevokeThreshold = 1;
    try {
      const u = await createUser("peruserbrake@a.test");
      const p = await createPosition(T, "d-many", "Many-hatted");
      await addPositionRole(T, p, memberRole, "company");
      await addPositionRole(T, p, viewerRole, "company");
      const a = await assign(T, p, u);
      await reconcileUser(T, u);
      expect(await grantRows(u)).toHaveLength(2);

      await closeAssignment(T, a);
      await expect(reconcileUser(T, u)).rejects.toThrow(MassRevokeBrakeError);
      expect(await grantRows(u), "the refused run left BOTH grants standing").toHaveLength(2);

      const forced = await reconcileUser(T, u, { force: true });
      expect(forced!.revoked).toBe(2);
    } finally {
      config.positionMassRevokeThreshold = originalThreshold;
    }
  });

  // ── 6. DRY-RUN / REAL PARITY ───────────────────────────────────────────────────────────────
  it("VECTOR 6 — dryRun writes nothing and produces the SAME plan the real run then executes", async () => {
    const u = await createUser("dryrun@a.test");
    const p = await createPosition(T, "d-dry", "Analyst");
    await addPositionRole(T, p, memberRole, "company");
    await addPositionRole(T, p, leadRole, "own_unit");
    await assign(T, p, u);

    const preview = await reconcileUser(T, u, { dryRun: true });
    expect(preview!.dryRun).toBe(true);
    expect(preview!.granted).toBe(0);
    expect(await grantRows(u), "a dry run writes NOTHING").toHaveLength(0);
    expect(preview!.plan.grants.filter((g) => g.action === "insert")).toHaveLength(2);

    const real = await reconcileUser(T, u);
    expect(real!.granted).toBe(2);
    // Same collector ⇒ same plan shape. Compared on the fields that decide behaviour.
    const shape = (p2: typeof preview) =>
      p2!.plan.grants.map((g) => `${g.roleId}|${g.scopeType}|${g.scopeId}|${g.action}`).sort();
    expect(shape(real)).toEqual(shape(preview));

    // own_unit resolved to the position's own node id, at org_unit scope.
    const rows = await grantRows(u);
    const unitGrant = rows.find((r) => r.scope_type === "org_unit");
    expect(unitGrant, "own_unit materializes at scope_type=org_unit").toBeDefined();
    expect(unitGrant!.scope_id).toBe("d-dry");
  });

  // ── 7. CONCURRENCY: overlapping teardowns of ONE artifact ──────────────────────────────────
  it("VECTOR 7 — two concurrent reconciles of the same user leave NO live grant with zero claims", async () => {
    const u = await createUser("concurrent@a.test");
    const p1 = await createPosition(T, "d-c1", "C1");
    const p2 = await createPosition(T, "d-c2", "C2");
    await addPositionRole(T, p1, viewerRole, "company");
    await addPositionRole(T, p2, viewerRole, "company"); // shared artifact, two claims
    const a1 = await assign(T, p1, u);
    const a2 = await assign(T, p2, u);
    await reconcileUser(T, u);
    const [row] = await grantRows(u);
    expect(await claimCount(T, row.id)).toBe(2);

    // Both seats close, then two reconciles race for the same artifact.
    await closeAssignment(T, a1);
    await closeAssignment(T, a2);
    const results = await Promise.allSettled([reconcileUser(T, u), reconcileUser(T, u)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok.length, "at least one run must complete").toBeGreaterThan(0);

    // THE leak assertion: the failure mode is a grant that still exists with zero claims backing
    // it (both transactions saw the other's uncommitted sibling claim and neither deleted).
    const after = await grantRows(u);
    expect(after, "the grant is gone — no zero-claim live grant survived the race").toHaveLength(0);
    expect(await claimsForAssignment(T, a1)).toBe(0);
    expect(await claimsForAssignment(T, a2)).toBe(0);
  });

  // ── A14 adoption ───────────────────────────────────────────────────────────────────────────
  it("A14 — adopting a managed grant as manual drops its claims so a later close cannot delete it", async () => {
    const u = await createUser("adopt@a.test");
    const p = await createPosition(T, "d-adopt", "Adopted");
    await addPositionRole(T, p, memberRole, "company");
    const a = await assign(T, p, u);
    await reconcileUser(T, u);
    const [row] = await grantRows(u);
    expect(row.managed_by_position).not.toBeNull();

    await adoptPositionGrantAsManual(T, row.id);
    expect(await claimCount(T, row.id)).toBe(0);

    await closeAssignment(T, a);
    const r = await reconcileUser(T, u);
    expect(r!.revoked, "an adopted (now manual) grant is no longer the reconciler's to revoke").toBe(0);
    const after = await grantRows(u);
    expect(after).toHaveLength(1);
    expect(after[0].managed_by_position).toBeNull();
  });

  // ── 8. FLAG OFF ────────────────────────────────────────────────────────────────────────────
  it("VECTOR 8 — with POSITION_SYNC_ENABLED off, every entry point is inert and writes nothing", async () => {
    config.positionSyncEnabled = false;
    try {
      const u = await createUser("darkflag@a.test");
      const p = await createPosition(T, "d-dark", "Dark");
      await addPositionRole(T, p, memberRole, "company");
      const a = await assign(T, p, u);

      expect(await reconcileUser(T, u)).toBeNull();
      expect(await reconcileTenant(T)).toBeNull();
      expect(await reconcilePosition(T, p)).toBeNull();
      expect(await reconcileAssignment(T, a)).toBeNull();
      expect(await grantRows(u), "dark by default means NOTHING is materialized").toHaveLength(0);
    } finally {
      config.positionSyncEnabled = true;
    }
  });

  // ── RLS trap: the collector must be scoped, not silently empty ─────────────────────────────
  it("RLS — computePlan under the WRONG tenant's GUC sees zero desired grants (and does not leak across tenants)", async () => {
    const other = await createCompany("Other Tenant");
    const u = await createUser("rlsprobe@a.test");
    const p = await createPosition(T, "d-rls", "Probe");
    await addPositionRole(T, p, memberRole, "company");
    await assign(T, p, u);

    // Under T: the seat is visible and desired.
    const seen = await withTenants([T], (c) => computePlan(c, T, u));
    expect(seen.grants).toHaveLength(1);

    // Under `other`: RLS hides the assignment entirely. This is exactly the zero-row-looks-like-
    // success trap — asserted here so a future refactor that drops tenant scoping is caught.
    const blind = await withTenants([other], (c) => computePlan(c, other, u));
    expect(blind.grants).toHaveLength(0);
    expect(blind.revokes).toHaveLength(0);
  });
});
