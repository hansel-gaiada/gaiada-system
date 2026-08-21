// Task 4.2: schema applies + FORCE RLS isolates by the authorized-tenant-set (D5),
// verified through a NOSUPERUSER NOBYPASSRLS role.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "./index";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createProject } from "../testing/fixtures";

describe.skipIf(!TEST_URL)("core schema + RLS (authorized-tenant-set)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await initTestDb();
    tenantA = await createCompany("Resort A");
    // MON-00b: `withTenants` now REFUSES a tenant set spanning two root company trees
    // (CrossRootTenantSetError), so two independently-created companies can no longer be authorized
    // together — which is what every "management path sees {A,B}" case below does. B is therefore a
    // SUBSIDIARY of A rather than an unrelated company: one root, two tenants.
    //
    // This does not weaken what these suites test. RLS isolation is keyed on `tenant_id`, not on the
    // root, so B remains a fully distinct tenant that A must not see; if anything it is the stronger
    // case, since isolation now has to hold for two companies that DO share a root. Cross-root
    // refusal is a separate guarantee, pinned in cross-root-boundary.db.test.ts.
    tenantB = await createCompany("Agency B", [], tenantA);
    await createProject(tenantA, "Pool renovation");
    await createProject(tenantB, "Brand campaign");
  });
  afterAll(teardownTestDb);

  it("a session authorized for tenant A sees only A's projects", async () => {
    const res = await withTenants([tenantA], (c) => c.query(`SELECT tenant_id FROM projects`));
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].tenant_id).toBe(tenantA);
  });

  it("a session authorized for {A,B} sees both (management path)", async () => {
    const res = await withTenants([tenantA, tenantB], (c) => c.query(`SELECT count(*)::int AS n FROM projects`));
    expect(res.rows[0].n).toBe(2);
  });

  it("no tenant context → zero rows (fail-closed)", async () => {
    const { getPool } = await import("./index");
    const res = await getPool().query(`SELECT count(*)::int AS n FROM projects`);
    expect(res.rows[0].n).toBe(0);
  });

  it("cannot INSERT into a tenant outside the authorized set (WITH CHECK)", async () => {
    await expect(
      withTenants([tenantA], (c) =>
        c.query(`INSERT INTO projects (id, tenant_id, name, origin_site) VALUES (gen_random_uuid(), $1, 'smuggled', 'x')`, [
          tenantB,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("every tenant-scoped table has FORCE RLS", async () => {
    // Every table with a tenant_id column must FORCE RLS. site_subscriptions (the central node→tenant
    // ACL) is not TENANT-isolated — the sync engine reads it with no tenant context — but it is still
    // FORCE-RLS'd via a sync-context GUC gate (migration 0015), so it satisfies this invariant too.
    const res = await withTenants([tenantA], (c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relforcerowsecurity FROM pg_class c
         JOIN information_schema.columns col ON col.table_name = c.relname AND col.column_name = 'tenant_id'
         WHERE c.relkind = 'r' AND col.table_schema = 'public'`,
      ),
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(13);
    for (const row of res.rows) {
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
  });
});
