// ORG-3 dedicated test for 0027_service_assignment_unit_guard.sql: the composite FK
// (unit_id, provider_tenant_id) -> org_units(id, tenant_id) must reject a service_assignments
// row whose unit_id belongs to a DIFFERENT tenant than its declared provider_tenant_id — on
// INSERT, and on an UPDATE that changes unit_id — regardless of which tenant's session performs
// the write (the exact property a plain, non-bypassing trigger could not guarantee for a
// target-scoped write; see the migration header for the full rationale).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("0027 service_assignments unit-tenant guard (composite FK)", () => {
  let A: string; // real provider of unitA
  let C: string; // a DIFFERENT tenant that owns unitC — never a party to the assignment below
  let B: string; // legitimate target
  let actor: string;
  let unitA: string;
  let unitC: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Provider A");
    B = await createCompany("Target B");
    C = await createCompany("Other Provider C");
    actor = await createUser("exec2@holding.test");

    unitA = newId();
    await withTenants([A], (c) =>
      c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,'d-hr','department','HR')`, [
        unitA,
        A,
      ]),
    );
    unitC = newId();
    await withTenants([C], (c) =>
      c.query(`INSERT INTO org_units (id, tenant_id, node_id, kind, name) VALUES ($1,$2,'d-fin','department','Finance')`, [
        unitC,
        C,
      ]),
    );
  });
  afterAll(teardownTestDb);

  it("INSERT is rejected when unit_id belongs to a tenant other than provider_tenant_id", async () => {
    // Session is scoped to [A] (satisfies sa_insert's WITH CHECK on provider_tenant_id=A), but the
    // unit_id names C's org_units row — a cross-provider reference that must be refused by the DB
    // itself, not merely by the app layer.
    await expect(
      withTenants([A], (c) =>
        c.query(
          `INSERT INTO service_assignments
             (id, unit_id, provider_tenant_id, target_tenant_id, module_key, unit_name, unit_kind, created_by)
           VALUES ($1,$2,$3,$4,'hr','HR','department',$5)`,
          [newId(), unitC, A, B, actor],
        ),
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("a legitimate same-provider INSERT succeeds (control case)", async () => {
    const id = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO service_assignments
           (id, unit_id, provider_tenant_id, target_tenant_id, module_key, unit_name, unit_kind, created_by)
         VALUES ($1,$2,$3,$4,'hr-ok','HR','department',$5)`,
        [id, unitA, A, B, actor],
      ),
    );
    const { rows } = await withTenants([A], (c) => c.query(`SELECT id FROM service_assignments WHERE id=$1`, [id]));
    expect(rows.length).toBe(1);
  });

  it("an UPDATE that re-points unit_id to a foreign-tenant unit is rejected (the re-link path)", async () => {
    const id = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO service_assignments
           (id, unit_id, provider_tenant_id, target_tenant_id, module_key, unit_name, unit_kind, created_by)
         VALUES ($1,$2,$3,$4,'hr-relink','HR','department',$5)`,
        [id, unitA, A, B, actor],
      ),
    );
    await expect(
      withTenants([A], (c) =>
        c.query(`UPDATE service_assignments SET unit_id = $2 WHERE id = $1`, [id, unitC]),
      ),
    ).rejects.toThrow(/foreign key|violates/i);

    // The row is untouched — unit_id still points at the original, legitimate unit.
    const { rows } = await withTenants([A], (c) =>
      c.query<{ unit_id: string }>(`SELECT unit_id FROM service_assignments WHERE id=$1`, [id]),
    );
    expect(rows[0].unit_id).toBe(unitA);
  });
});
