// Task 0.3 — RLS on the authorized-tenant-set (D5). Needs a live Postgres:
// set DATABASE_URL_TEST to run (skipped otherwise, e.g. in envs without Postgres).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { PgStore, withTenant } from "./pg";

const url = process.env.DATABASE_URL_TEST ?? "";

describe.skipIf(!url)("Postgres RLS (authorized-tenant-set)", () => {
  let admin: Pool;
  let pool: Pool; // non-superuser app role — superusers bypass RLS, app roles must not
  let store: PgStore;

  beforeAll(async () => {
    store = new PgStore(url);
    await store.init();
    admin = new Pool({ connectionString: url });
    await admin.query(`
      DO $$ BEGIN
        CREATE ROLE gaiada_app_test LOGIN PASSWORD 'test' NOSUPERUSER NOBYPASSRLS;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO gaiada_app_test;
      GRANT SELECT, INSERT, DELETE ON messages TO gaiada_app_test;
    `);
    const u = new URL(url);
    u.username = "gaiada_app_test";
    u.password = "test";
    pool = new Pool({ connectionString: u.toString() });
    await withTenant(pool, ["tenantA"], (c) =>
      c.query(
        `INSERT INTO messages (tenant_id, chat_id, ts, text) VALUES ('tenantA', 'rls-test@g.us', 1, 'from A')`,
      ),
    );
    await withTenant(pool, ["tenantB"], (c) =>
      c.query(
        `INSERT INTO messages (tenant_id, chat_id, ts, text) VALUES ('tenantB', 'rls-test@g.us', 2, 'from B')`,
      ),
    );
  });

  afterAll(async () => {
    await withTenant(pool, ["tenantA", "tenantB"], (c) =>
      c.query(`DELETE FROM messages WHERE chat_id = 'rls-test@g.us'`),
    );
    await pool.end();
    await admin.end();
    await store.close();
  });

  it("a session authorized for tenant A cannot see tenant B's rows", async () => {
    const res = await withTenant(pool, ["tenantA"], (c) =>
      c.query(`SELECT tenant_id FROM messages WHERE chat_id = 'rls-test@g.us'`),
    );
    expect(res.rows.length).toBe(1);
    expect(res.rows.every((r: { tenant_id: string }) => r.tenant_id === "tenantA")).toBe(true);
  });

  it("a session authorized for {A,B} sees both", async () => {
    const res = await withTenant(pool, ["tenantA", "tenantB"], (c) =>
      c.query(`SELECT count(*)::int AS n FROM messages WHERE chat_id = 'rls-test@g.us'`),
    );
    expect(res.rows[0].n).toBe(2);
  });

  it("a session with NO tenant set sees nothing (fail-closed)", async () => {
    const client = await pool.connect();
    try {
      const res = await client.query(`SELECT count(*)::int AS n FROM messages WHERE chat_id = 'rls-test@g.us'`);
      expect(res.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it("a session cannot INSERT into a tenant it is not authorized for", async () => {
    await expect(
      withTenant(pool, ["tenantA"], (c) =>
        c.query(`INSERT INTO messages (tenant_id, chat_id, ts, text) VALUES ('tenantB', 'rls-test@g.us', 3, 'smuggled')`),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
