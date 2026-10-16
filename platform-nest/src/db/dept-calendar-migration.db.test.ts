// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59.3; PERMISSION-CONTRACT §48) — migration 202610160300_calendar_events_department.sql (the
// `department` visibility and `unit_node_id`) and 202610160310_iam_org_structure_read_calendar.sql (the permission seed), proven against a
// REAL Postgres:
//   - the CHECKs from both sides, as the NOSUPERUSER NOBYPASSRLS app role, each refusal asserting the SQLSTATE and that nothing was stored;
//   - the old values still work (a DROP + ADD on a shared CHECK re-declares everything);
//   - THE REPLAY: the migration is run again over a table that holds the OLD shape (the inline CHECK, no column, legacy rows). A fresh-database
//     assertion passes with the migration deleted (initTestDb has already applied it), so the proof that the DDL does its job on a
//     database that ALREADY has data is the replay;
//   - the IAM seed's reach: the key, its eight holders, owner = company_admin, no self-scoped marker, and a second run changes nothing.
//
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";

const CHECK_VIOLATION = "23514";
const KEY = "core.org_structure.read_calendar";
const MIGRATIONS = join(__dirname, "../../migrations");
const sqlOf = (file: string) => readFileSync(join(MIGRATIONS, file), "utf8");

describe.skipIf(!TEST_URL)("DW-10c — calendar_events.department and the read_calendar seed (real Postgres)", () => {
  let A: string;
  let B: string;
  let user: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Dept Cal Tenant A");
    B = await createCompany("Dept Cal Tenant B");
    user = await createUser("dcal@schema.test", "Dept Cal");
    await addMembership(A, user);
    await addMembership(B, user);
  }, 120_000);
  afterAll(teardownTestDb);

  async function insertEvent(tenant: string, visibility: string, unit: string | null): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO calendar_events (id, tenant_id, title, starts_at, ends_at, organizer_id, visibility, unit_node_id, origin_site)
         VALUES ($1,$2,'Event','2026-10-20T01:00:00Z','2026-10-20T02:00:00Z',$3,$4,$5,'test')`,
        [id, tenant, user, visibility, unit],
      ),
    );
    return id;
  }
  const total = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM calendar_events`)).rows[0].n);
  const refused = async (code: string, visibility: string, unit: string | null) => {
    const before = await total();
    await expect(insertEvent(A, visibility, unit)).rejects.toMatchObject({ code });
    expect(await total(), "a refused insert stores nothing").toBe(before);
  };

  describe("the CHECKs, as the app role", () => {
    it("all three visibilities are stored; `department` carries its unit and the others carry NULL", async () => {
      const a = await insertEvent(A, "attendees", null);
      const c = await insertEvent(A, "company", null);
      const d = await insertEvent(A, "department", "d-web");
      const rows = (await adminPool().query(`SELECT id, visibility, unit_node_id FROM calendar_events WHERE id = ANY($1::uuid[])`, [[a, c, d]])).rows;
      expect(Object.fromEntries(rows.map((r) => [r.id, [r.visibility, r.unit_node_id]]))).toEqual({
        [a]: ["attendees", null], [c]: ["company", null], [d]: ["department", "d-web"],
      });
    });

    it("`department` without a unit is refused (the unit is NULL, not just wrong: the NULL trap)", async () => {
      await refused(CHECK_VIOLATION, "department", null);
    });

    it("a unit on `attendees` or on `company` is refused, and so is an empty or an over-long unit", async () => {
      await refused(CHECK_VIOLATION, "attendees", "d-web");
      await refused(CHECK_VIOLATION, "company", "d-web");
      await refused(CHECK_VIOLATION, "department", "");
      await refused(CHECK_VIOLATION, "department", "x".repeat(201));
      await expect(insertEvent(A, "department", "x".repeat(200))).resolves.toBeDefined();
    });

    it("any other visibility is still refused", async () => {
      await refused(CHECK_VIOLATION, "everyone", null);
      await refused(CHECK_VIOLATION, "private", "d-web");
    });

    it("the same node id in two companies is two rows in two tenants: RLS keeps each in its own, and nothing crosses", async () => {
      const a = await insertEvent(A, "department", "d-web");
      const b = await insertEvent(B, "department", "d-web");
      const seen = async (tenant: string) =>
        (await withTenants([tenant], (c) => c.query(`SELECT id FROM calendar_events WHERE visibility = 'department' AND unit_node_id = 'd-web'`))).rows.map((r) => r.id as string);
      expect(await seen(A)).toContain(a);
      expect(await seen(A)).not.toContain(b);
      expect(await seen(B)).toContain(b);
      expect(await seen(B)).not.toContain(a);
      // a row of A cannot be written into B
      await expect(
        withTenants([B], (c) =>
          c.query(
            `INSERT INTO calendar_events (id, tenant_id, title, starts_at, ends_at, organizer_id, visibility, unit_node_id, origin_site)
             VALUES ($1,$2,'x','2026-10-20T01:00:00Z','2026-10-20T02:00:00Z',$3,'department','d-web','test')`,
            [newId(), A, user],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("the table keeps its tenant wall: RLS enabled and FORCED, one policy, and the department index exists", async () => {
      const r = await adminPool().query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'calendar_events'`);
      expect(r.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = await adminPool().query(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'calendar_events'`);
      expect(pol.rows[0].n).toBe(1);
      const ix = await adminPool().query(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'ix_calendar_events_department'`);
      expect(ix.rows[0].n).toBe(1);
    });
  });

  describe("the IAM seed (202610160310)", () => {
    const holders = async () =>
      (
        await adminPool().query(
          `SELECT r.name, rp.self_scoped FROM role_permissions rp
             JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE r.company_id IS NULL AND p.key = $1 ORDER BY r.name`,
          [KEY],
        )
      ).rows;

    it("the key exists: grantable, core, not sensitive, ui_grantable, on org_structure / read_calendar", async () => {
      const r = await adminPool().query(`SELECT module_key, resource, action, cerbos_kind, cerbos_action, class, sensitive, ui_grantable FROM permissions WHERE key = $1`, [KEY]);
      expect(r.rows).toEqual([
        { module_key: "core", resource: "org_structure", action: "read_calendar", cerbos_kind: "org_structure", cerbos_action: "read_calendar", class: "grantable", sensitive: false, ui_grantable: true },
      ]);
    });

    it("exactly the eight holders, none self-scoped; the client, a head's own role and the module tiers hold nothing", async () => {
      const rows = await holders();
      expect(rows.map((r) => r.name)).toEqual(["company_admin", "hr_manager", "hr_staff", "manager", "member", "owner", "platform_admin", "viewer"]);
      expect(rows.every((r) => r.self_scoped === false)).toBe(true);
    });

    it("owner holds exactly what company_admin holds on the org_structure kind, in both directions", async () => {
      const keysOf = async (role: string) =>
        (
          await adminPool().query(
            `SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
              WHERE r.company_id IS NULL AND r.name = $1 AND p.cerbos_kind = 'org_structure' ORDER BY p.key`,
            [role],
          )
        ).rows.map((r) => r.key as string);
      expect(await keysOf("owner")).toEqual(await keysOf("company_admin"));
      expect(await keysOf("owner")).toContain(KEY);
    });

    it("the seed matches the committed bundle file, role by role", async () => {
      const bundles = JSON.parse(readFileSync(join(__dirname, "../rbac/role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
      const fromFile = Object.keys(bundles.roles).filter((r) => bundles.roles[r].includes(KEY)).sort();
      expect((await holders()).map((r) => r.name)).toEqual(fromFile);
    });

    it("running the seed a second time changes nothing (idempotent), and its own self-checks pass again", async () => {
      const before = await holders();
      const n = Number((await adminPool().query(`SELECT count(*)::int AS n FROM permissions`)).rows[0].n);
      await adminPool().query(sqlOf("202610160310_iam_org_structure_read_calendar.sql"));
      expect(await holders()).toEqual(before);
      expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM permissions`)).rows[0].n)).toBe(n);
    });
  });

  // MUTATES the table's constraints: keep it LAST.
  describe("the replay over the OLD shape", () => {
    it("the migration run over a table with the inline two-value CHECK, no unit column and legacy rows keeps the rows and ends with ONE visibility CHECK that names all three", async () => {
      const pool = adminPool();
      // put the table back to its pre-DW-10c shape: drop the new objects, re-add the old inline-named CHECK
      await pool.query(`
        DROP INDEX IF EXISTS ix_calendar_events_department;
        ALTER TABLE calendar_events DROP CONSTRAINT calendar_events_visibility_ck;
        ALTER TABLE calendar_events DROP CONSTRAINT calendar_events_department_unit_ck;
        ALTER TABLE calendar_events DROP CONSTRAINT calendar_events_unit_node_len_ck;
        DELETE FROM calendar_event_attendees;
        DELETE FROM calendar_events;
        ALTER TABLE calendar_events DROP COLUMN unit_node_id;
        ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_visibility_check CHECK (visibility IN ('attendees', 'company'));
      `);
      const legacy = [newId(), newId()];
      await pool.query(
        `INSERT INTO calendar_events (id, tenant_id, title, starts_at, ends_at, organizer_id, visibility, origin_site)
         VALUES ($1,$3,'Old attendees','2026-10-20T01:00:00Z','2026-10-20T02:00:00Z',$4,'attendees','test'),
                ($2,$3,'Old company','2026-10-20T01:00:00Z','2026-10-20T02:00:00Z',$4,'company','test')`,
        [legacy[0], legacy[1], A, user],
      );
      await expect(
        pool.query(
          `INSERT INTO calendar_events (id, tenant_id, title, starts_at, ends_at, organizer_id, visibility, origin_site)
           VALUES ($1,$2,'x','2026-10-20T01:00:00Z','2026-10-20T02:00:00Z',$3,'department','test')`,
          [newId(), A, user],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION }); // the old shape refuses the new value: the premise of the replay

      await pool.query(sqlOf("202610160300_calendar_events_department.sql"));

      const kept = (await pool.query(`SELECT id, visibility, unit_node_id FROM calendar_events ORDER BY title`)).rows;
      expect(kept).toEqual([
        { id: legacy[0], visibility: "attendees", unit_node_id: null },
        { id: legacy[1], visibility: "company", unit_node_id: null },
      ]);
      const checks = (
        await pool.query(
          `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'calendar_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%visibility%' AND pg_get_constraintdef(oid) NOT ILIKE '%unit_node_id%'`,
        )
      ).rows;
      expect(checks.map((c) => c.conname)).toEqual(["calendar_events_visibility_ck"]); // the old inline-named one is gone, not duplicated
      for (const v of ["attendees", "company", "department"]) expect(checks[0].def).toContain(v);
      await expect(insertEvent(A, "department", "d-web")).resolves.toBeDefined();
      await refused(CHECK_VIOLATION, "department", null);
      await expect(insertEvent(A, "company", null)).resolves.toBeDefined();
    });
  });
});
