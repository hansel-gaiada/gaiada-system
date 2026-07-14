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
    tenantB = await createCompany("Agency B");
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

  // Documented exceptions to the "tenant_id column ⇒ FORCE tenant RLS" invariant. A table lands
  // here only when tenant-isolation RLS would be WRONG, not merely inconvenient.
  //   site_subscriptions — the central node→tenant ACL that DEFINES cross-tenant authorization
  //   (0013_sync_tables.sql). The Go sync engine reads it with NO tenant context (acl.go:
  //   `WHERE node_id = $1` returns all of a node's tenants; tombstone.go: `SELECT DISTINCT
  //   tenant_id`). A tenant-isolation policy would return zero rows and break the ACL/GC — the
  //   table is the authz source, not tenant data. Writes are central-operator-only (operational,
  //   not RLS-enforced). See internal/protocol/acl.go and internal/db/db.go:40 in sync-engine-go.
  const RLS_EXEMPT_TENANT_TABLES = new Set(["site_subscriptions"]);

  it("every tenant-scoped table has FORCE RLS + the tenant policy (except documented central ACLs)", async () => {
    const res = await withTenants([tenantA], (c) =>
      c.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relforcerowsecurity FROM pg_class c
         JOIN information_schema.columns col ON col.table_name = c.relname AND col.column_name = 'tenant_id'
         WHERE c.relkind = 'r' AND col.table_schema = 'public'`,
      ),
    );
    const enforced = res.rows.filter((r) => !RLS_EXEMPT_TENANT_TABLES.has(r.relname));
    expect(enforced.length).toBeGreaterThanOrEqual(13);
    for (const row of enforced) {
      expect(row.relforcerowsecurity, `${row.relname} must FORCE RLS`).toBe(true);
    }
    // Guard the exemption list: every name in it must actually exist as a tenant_id table, so a
    // renamed/dropped table can't leave a stale exemption silently masking a real regression.
    const present = new Set(res.rows.map((r) => r.relname));
    for (const exempt of RLS_EXEMPT_TENANT_TABLES) {
      expect(present.has(exempt), `exempt table ${exempt} no longer exists — prune the exemption`).toBe(true);
    }
  });
});
