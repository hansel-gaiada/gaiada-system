// ORG-2 dedicated RLS test. service_assignments is keyed by provider_tenant_id/target_tenant_id
// (NOT a column literally named tenant_id), so the rls.test.ts FORCE-RLS sweep MISSES it — this
// suite is its coverage. It asserts: FORCE RLS on all three new tables, the A3 per-command policy
// shapes, dual-side visibility, provider-only INSERT, the target-side accept UPDATE (the exact case
// the spec's original FOR ALL policy would have failed), and the immutability trigger.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("service layer RLS (org_units / service_assignments / claims — 0026)", () => {
  let A: string; // provider
  let B: string; // target
  let C: string; // unrelated third tenant
  let actor: string; // created_by
  let unitId: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Provider A");
    B = await createCompany("Target B");
    C = await createCompany("Other C");
    actor = await createUser("exec@holding.test");
    unitId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,'d-hr','department','HR')`,
        [unitId, A],
      ),
    );
  });
  afterAll(teardownTestDb);

  it("all three new tables FORCE RLS", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT relname, relforcerowsecurity FROM pg_class
          WHERE relkind='r' AND relname IN ('org_units','service_assignments','service_grant_claims')`,
      ),
    );
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.relforcerowsecurity, `${r.relname}`).toBe(true);
  });

  it("service_assignments has exactly the A3 per-command policies (no FOR ALL)", async () => {
    const { rows } = await withGlobal((c) =>
      c.query<{ policyname: string; cmd: string }>(
        `SELECT policyname, cmd FROM pg_policies
          WHERE tablename='service_assignments' ORDER BY policyname`,
      ),
    );
    const shape = rows.map((r) => `${r.policyname}:${r.cmd}`).sort();
    expect(shape).toEqual(["sa_insert:INSERT", "sa_select:SELECT", "sa_update:UPDATE"]);
  });

  it("org_units is provider-side only (tenant_isolation)", async () => {
    const seen = await withTenants([A], (c) => c.query(`SELECT id FROM org_units WHERE id=$1`, [unitId]));
    expect(seen.rows.length).toBe(1);
    const hidden = await withTenants([B], (c) => c.query(`SELECT id FROM org_units WHERE id=$1`, [unitId]));
    expect(hidden.rows.length).toBe(0);
  });

  // Distinct module_key per call so the ux_service_assignments_active guard (one live edge per
  // unit+target+module) doesn't collide across independent test cases.
  let moduleSeq = 0;
  async function insertProposed(): Promise<string> {
    const id = newId();
    const moduleKey = `hr${moduleSeq++}`;
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO service_assignments
           (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status, unit_name, unit_kind, created_by)
         VALUES ($1,$2,$3,$4,$5,'proposed','HR','department',$6)`,
        [id, unitId, A, B, moduleKey, actor],
      ),
    );
    return id;
  }

  it("sa_insert is provider-only: inserting a provider-A row from the target session fails WITH CHECK", async () => {
    await expect(
      withTenants([B], (c) =>
        c.query(
          `INSERT INTO service_assignments
             (id, unit_id, provider_tenant_id, target_tenant_id, module_key, unit_name, unit_kind, created_by)
           VALUES ($1,$2,$3,$4,'hr','HR','department',$5)`,
          [newId(), unitId, A, B, actor],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("the edge is visible from BOTH sides (dual-side sa_select) and hidden from a third tenant", async () => {
    const id = await insertProposed();
    const fromProvider = await withTenants([A], (c) => c.query(`SELECT id FROM service_assignments WHERE id=$1`, [id]));
    const fromTarget = await withTenants([B], (c) => c.query(`SELECT id FROM service_assignments WHERE id=$1`, [id]));
    const fromOther = await withTenants([C], (c) => c.query(`SELECT id FROM service_assignments WHERE id=$1`, [id]));
    expect(fromProvider.rows.length).toBe(1);
    expect(fromTarget.rows.length).toBe(1);
    expect(fromOther.rows.length).toBe(0);
  });

  it("A3 regression: the TARGET side can accept (proposed→active) under withTenants([target])", async () => {
    const id = await insertProposed();
    // This UPDATE rewrites a row whose provider_tenant_id=A while the session set is [B]. The spec's
    // original FOR ALL WITH CHECK(provider) would have failed here; sa_update's dual-side WITH CHECK
    // permits it.
    const res = await withTenants([B], (c) =>
      c.query(
        `UPDATE service_assignments SET status='active', accepted_by=$2, accepted_at=now() WHERE id=$1`,
        [id, actor],
      ),
    );
    expect(res.rowCount).toBe(1);
    const { rows } = await withTenants([B], (c) => c.query<{ status: string }>(`SELECT status FROM service_assignments WHERE id=$1`, [id]));
    expect(rows[0].status).toBe("active");
  });

  it("the identity columns are immutable after insert (freeze trigger)", async () => {
    const id = await insertProposed();
    await expect(
      withTenants([A], (c) => c.query(`UPDATE service_assignments SET target_tenant_id=$2 WHERE id=$1`, [id, C])),
    ).rejects.toThrow(/immutable/);
    await expect(
      withTenants([A], (c) => c.query(`UPDATE service_assignments SET module_key='finance' WHERE id=$1`, [id])),
    ).rejects.toThrow(/immutable/);
  });

  it("service_grant_claims is target-tenant isolated", async () => {
    const asg = await insertProposed();
    await addMembership(B, actor);
    const { rows: mrows } = await withTenants([B], (c) =>
      c.query<{ id: string }>(`SELECT id FROM company_memberships WHERE tenant_id=$1 AND user_id=$2`, [B, actor]),
    );
    const membershipId = mrows[0].id;
    const claimId = newId();
    await withTenants([B], (c) =>
      c.query(
        `INSERT INTO service_grant_claims (id, tenant_id, assignment_id, membership_id) VALUES ($1,$2,$3,$4)`,
        [claimId, B, asg, membershipId],
      ),
    );
    const seen = await withTenants([B], (c) => c.query(`SELECT id FROM service_grant_claims WHERE id=$1`, [claimId]));
    const hidden = await withTenants([A], (c) => c.query(`SELECT id FROM service_grant_claims WHERE id=$1`, [claimId]));
    expect(seen.rows.length).toBe(1);
    expect(hidden.rows.length).toBe(0);
  });
});
