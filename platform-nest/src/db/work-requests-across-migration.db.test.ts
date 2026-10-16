// DW-10e-1 (BFF §60.3 "Order, backfill and idempotency" and §60.11 "The migration") — migration 202610160200_work_requests_across.sql,
// run for real against a database that holds LEGACY rows. Real Postgres (skips silently without DATABASE_URL_TEST; runs on the
// Linux gate; a skip is NOT a pass).
//
//   (1) REWIND. The suites' template database was migrated by a superuser with an empty `work_requests`, which proves nothing
//       about a backfill. So this suite puts the table BACK into its pre-migration shape (no new columns, no triggers, no
//       client intake table) around two real same-company requests in two different companies, and applies the migration's REAL
//       text to it.
//   (2) AS A NOBYPASSRLS OWNER. Production's migration role (`platform_owner`) owns the tables and has no BYPASSRLS, and
//       `work_requests` is FORCE RLS, so an unscoped backfill UPDATE matches ZERO rows and reports success (the trap in
//       platform-nest/CLAUDE.md). A superuser would hide it: its UPDATE would match everything. So the migration is applied under
//       `SET LOCAL ROLE wr_migrator_test`, a NOSUPERUSER NOBYPASSRLS role that owns the table. The premise is proven first: that
//       role sees ZERO of the legacy rows with no tenant set. With the per-company walk deleted from the migration, the
//       `SET NOT NULL` that follows aborts it, which is this test failing loudly instead of live.
//   (3) TWICE. The second application (under the same role, then as a superuser) raises nothing and changes no row, including a
//       cross-company row that exists by then.
//
// It manipulates the schema of its own per-file database only (initTestDb gives every file its own).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import {
  buildAcrossWorld, validCrossCols, sameCompanyCols, insertSql, outcomeOf, type AcrossWorld,
} from "../testing/work-requests-across-fixtures";

const MIGRATION = "202610160200_work_requests_across.sql";
const MIGRATION_SQL = readFileSync(join(__dirname, "..", "..", "migrations", MIGRATION), "utf8");
const OWNER = "wr_migrator_test";

describe.skipIf(!TEST_URL)("DW-10e-1 migration 202610160200 over legacy rows (NOBYPASSRLS owner, applied twice)", () => {
  let w: AcrossWorld;
  let legacyP: string;
  let legacyH: string;
  const q = (sql: string, args: unknown[] = []) => adminPool().query(sql, args);

  /** Run `sql` in one transaction, as `role` when given (SET LOCAL ROLE: RLS then applies to it like to any non-bypass role). */
  async function runAs(sql: string, role?: string): Promise<{ notices: string[] }> {
    const client = await adminPool().connect();
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      await client.query("BEGIN");
      if (role) await client.query(`SET LOCAL ROLE ${role}`);
      await client.query(sql);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return { notices };
  }

  const newCols = ["requester_tenant_id", "requester_unit_id", "requester_unit_name", "service_assignment_id", "client_id"];

  beforeAll(async () => {
    await initTestDb();
    w = await buildAcrossWorld();

    // Two real legacy requests in two different companies (written by the pre-column code path: no requester column).
    const p = await sameCompanyCols(w, w.P);
    const h = await sameCompanyCols(w, w.H);
    for (const cols of [p, h]) {
      const { sql, params } = insertSql(cols);
      await q(sql, params);
    }
    legacyP = p.id as string;
    legacyH = h.id as string;

    // (1) REWIND to the pre-migration shape.
    await q(`
      DROP TRIGGER IF EXISTS trg_work_requests_route_guard ON work_requests;
      DROP TRIGGER IF EXISTS trg_work_requests_freeze_requester ON work_requests;
      DROP FUNCTION IF EXISTS work_requests_route_guard();
      DROP FUNCTION IF EXISTS work_requests_freeze_requester();
      DROP TABLE IF EXISTS work_request_client_intakes;
      ALTER TABLE work_requests
        DROP COLUMN requester_tenant_id CASCADE, DROP COLUMN requester_unit_id CASCADE, DROP COLUMN requester_unit_name CASCADE,
        DROP COLUMN service_assignment_id CASCADE, DROP COLUMN client_id CASCADE;
    `);

    // (2) The migration role: owns work_requests, no BYPASSRLS, no superuser; may create objects and reference what the
    // migration references (FK targets need REFERENCES, the backfill's company walk needs SELECT on companies).
    await q(`
      DO $$ BEGIN CREATE ROLE ${OWNER} NOLOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      ALTER ROLE ${OWNER} NOSUPERUSER NOBYPASSRLS;
      ALTER TABLE work_requests OWNER TO ${OWNER};
      GRANT USAGE, CREATE ON SCHEMA public TO ${OWNER};
      GRANT SELECT, REFERENCES ON companies, clients, projects, service_assignments TO ${OWNER};
    `);
  }, 120_000);

  afterAll(teardownTestDb);

  it("the rewind is real: the five columns and both triggers are gone, the legacy rows are there", async () => {
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'work_requests' AND column_name = ANY($1)`, [newCols]);
    expect(cols.rows).toHaveLength(0);
    const trg = await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'work_requests'::regclass AND NOT tgisinternal`);
    expect(trg.rows[0].n).toBe(0);
    expect((await q(`SELECT id FROM work_requests WHERE id = ANY($1)`, [[legacyP, legacyH]])).rows).toHaveLength(2);
  });

  it("PREMISE: the migration role is subject to FORCE RLS, so with no tenant set it sees NONE of the legacy rows", async () => {
    const client = await adminPool().connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${OWNER}`);
      const unscoped = await client.query(`SELECT count(*)::int AS n FROM work_requests`);
      expect(unscoped.rows[0].n, "an owner without BYPASSRLS sees zero rows: this is why the backfill walks the companies").toBe(0);
      await client.query(`SELECT set_config('app.current_tenant_ids', $1, true)`, [w.P]);
      const scoped = await client.query(`SELECT count(*)::int AS n FROM work_requests`);
      expect(scoped.rows[0].n).toBe(1);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("applies the REAL migration text as that owner: every legacy row becomes a same-company row (one company at a time)", async () => {
    await runAs(MIGRATION_SQL, OWNER);
    const { rows } = await q(
      `SELECT id, tenant_id, requester_tenant_id, requester_unit_id, requester_unit_name, service_assignment_id, client_id
         FROM work_requests WHERE id = ANY($1) ORDER BY tenant_id`,
      [[legacyP, legacyH]],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.requester_tenant_id, `row ${r.id} of ${r.tenant_id}`).toBe(r.tenant_id);
      expect([r.requester_unit_id, r.requester_unit_name, r.service_assignment_id, r.client_id]).toEqual([null, null, null, null]);
    }
    // no row anywhere is left without a requester (the superuser pool sees every row regardless of RLS)
    expect((await q(`SELECT count(*)::int AS n FROM work_requests WHERE requester_tenant_id IS NULL`)).rows[0].n).toBe(0);
  });

  it("leaves the schema the contract names: NOT NULL, the client FK, five CHECKs, three indexes, two triggers, the new table", async () => {
    const nn = await q(`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'work_requests' AND column_name = 'requester_tenant_id'`);
    expect(nn.rows[0].is_nullable).toBe("NO");
    const checks = await q(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'work_requests'::regclass AND contype = 'c' AND conname LIKE ANY (ARRAY['work_requests_requester_%', 'work_requests_across_%']) ORDER BY conname`,
    );
    expect(checks.rows.map((r) => r.conname)).toEqual([
      "work_requests_across_from_ck", "work_requests_across_part_ck", "work_requests_requester_client_ck",
      "work_requests_requester_route_ck", "work_requests_requester_unit_ck", "work_requests_requester_unit_name_len_ck",
    ]);
    const fk = await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fk_work_requests_client_tenant'`);
    expect(fk.rows[0].def).toContain("FOREIGN KEY (client_id, tenant_id) REFERENCES clients(id, tenant_id)");
    const idx = await q(`SELECT indexname FROM pg_indexes WHERE tablename = 'work_requests' AND indexname IN ('ix_work_requests_requester', 'ix_work_requests_requester_unit', 'ix_work_requests_service_assignment')`);
    expect(idx.rows).toHaveLength(3);
    const trg = await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'work_requests'::regclass AND NOT tgisinternal ORDER BY tgname`);
    expect(trg.rows.map((r) => r.tgname)).toEqual(["trg_work_requests_freeze_requester", "trg_work_requests_route_guard"]);
    const t = await q(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'work_request_client_intakes'`);
    expect(t.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const pol = await q(`SELECT policyname FROM pg_policies WHERE tablename = 'work_request_client_intakes'`);
    expect(pol.rows).toEqual([{ policyname: "tenant_isolation" }]);
    const def = await q(`SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'fk_work_request_client_intakes_project_tenant'`);
    expect(def.rows).toEqual([{ condeferrable: true, condeferred: true }]);
  });

  it("a legacy-shaped INSERT (no requester column) still works and gets tenant_id; a cross row now needs its route", async () => {
    const legacy = await sameCompanyCols(w, w.P);
    const { sql, params } = insertSql(legacy);
    await q(sql, params);
    expect((await q(`SELECT requester_tenant_id FROM work_requests WHERE id = $1`, [legacy.id])).rows[0].requester_tenant_id).toBe(w.P);
    const cross = await validCrossCols(w, "assets", { service_assignment_id: null });
    const out = await outcomeOf(q(insertSql(cross).sql, insertSql(cross).params));
    expect(out.code).toBe("PD060");
  });

  it("applied a SECOND time under the same role it raises nothing and changes no row, cross-company row included", async () => {
    const cross = await validCrossCols(w, "assets");
    const ins = insertSql(cross);
    await q(ins.sql, ins.params);
    const snapshot = async () =>
      (await q(`SELECT id, tenant_id, requester_tenant_id, requester_unit_id, requester_unit_name, service_assignment_id, client_id, status, updated_at FROM work_requests ORDER BY id`)).rows;
    const before = await snapshot();
    expect(before.some((r) => r.requester_tenant_id !== r.tenant_id)).toBe(true);

    await runAs(MIGRATION_SQL, OWNER);
    expect(await snapshot()).toEqual(before);
  });

  it("applied a THIRD time as a superuser (the CI runner's role) it still raises nothing and the guard still holds", async () => {
    await runAs(MIGRATION_SQL);
    const cross = await validCrossCols(w, "assets", { client_id: w.cOther });
    const out = await outcomeOf(q(insertSql(cross).sql, insertSql(cross).params));
    expect(out.code).toBe("PD062");
    expect((await q(`SELECT count(*)::int AS n FROM work_requests WHERE requester_tenant_id IS NULL`)).rows[0].n).toBe(0);
  });
});
