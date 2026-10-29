// AIP-13b (docs/PERMISSION-CONTRACT.md §56, FRONTEND-BFF-CONTRACT §65) — migration 202610291500_assistant_dept_preambles.sql (the table) and
// 202610291510_iam_dept_assistant_preamble_permissions.sql (the permission seed), proven against a REAL Postgres as the NOSUPERUSER
// NOBYPASSRLS app role: the body CHECK (0, 1, 1000, 1001 characters, NULL), the primary key, the defaults, the FKs, erasure (deleting the
// last editor NULLS `updated_by` and keeps the text), RLS (zero rows with the tenant GUC unset, nothing across tenants, FORCE on), and the IAM
// seed's reach (including that a department head does NOT hold `manage`, and the owner mirrors company_admin).
//
// Each refusal asserts the SQLSTATE AND that nothing was stored.
//
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const FK_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const RLS_VIOLATION = "42501";

describe.skipIf(!TEST_URL)("AIP-13b — assistant_dept_preambles schema (as the NOBYPASSRLS app role)", () => {
  let A: string;
  let B: string;
  let userA: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Preamble Tenant A");
    B = await createCompany("Preamble Tenant B");
    userA = await createUser("preamble-a@schema.test", "Preamble A");
    await addMembership(A, userA);
  }, 120_000);
  afterAll(teardownTestDb);

  /** Insert a preamble row for `tenant` (as the app role, in that tenant's context). `cols` overrides the defaults; returns the unit id. */
  async function insertRow(tenant: string, cols: Record<string, unknown> = {}): Promise<string> {
    const row: Record<string, unknown> = { tenant_id: tenant, unit_node_id: `d-unit-${++seq}`, body: "Body text", updated_by: userA, ...cols };
    const names = Object.keys(row);
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO assistant_dept_preambles (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => row[n])),
    );
    return row.unit_node_id as string;
  }
  const total = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM assistant_dept_preambles`)).rows[0].n);
  const refused = async (code: string, tenant: string, cols: Record<string, unknown>) => {
    const before = await total();
    await expect(insertRow(tenant, cols)).rejects.toMatchObject({ code });
    expect(await total(), "a refused insert stores nothing").toBe(before);
  };

  describe("a row, its defaults and its limits", () => {
    it("a row is stored with created_at and updated_at defaulted, and updated_by optional", async () => {
      const unit = await insertRow(A, { updated_by: null });
      const r = (await adminPool().query(`SELECT created_at, updated_at, updated_by FROM assistant_dept_preambles WHERE tenant_id = $1 AND unit_node_id = $2`, [A, unit])).rows[0];
      expect(r.created_at).toBeInstanceOf(Date);
      expect(r.updated_at).toBeInstanceOf(Date);
      expect(r.updated_by).toBeNull();
    });

    it("the body CHECK: 1 and 1,000 characters are stored; 0, 1,001 and NULL are refused", async () => {
      await insertRow(A, { body: "x" });
      await insertRow(A, { body: "x".repeat(1000) });
      await refused(CHECK_VIOLATION, A, { body: "" });
      await refused(CHECK_VIOLATION, A, { body: "x".repeat(1001) });
      await refused(NOT_NULL_VIOLATION, A, { body: null });
    });

    it("the CHECK counts CODE POINTS (char_length), as the service does: 1,000 astral characters pass, 1,001 do not", async () => {
      await insertRow(A, { body: "\u{1F600}".repeat(1000) });
      await refused(CHECK_VIOLATION, A, { body: "\u{1F600}".repeat(1001) });
    });

    it("unit_node_id is required", async () => {
      await refused(NOT_NULL_VIOLATION, A, { unit_node_id: null });
    });

    it("the primary key is (tenant_id, unit_node_id): one row per unit per company, and the same unit id in ANOTHER company is a different row", async () => {
      const unit = await insertRow(A, { unit_node_id: "d-pk" });
      await refused(UNIQUE_VIOLATION, A, { unit_node_id: unit });
      await insertRow(B, { unit_node_id: "d-pk", updated_by: null });
      expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM assistant_dept_preambles WHERE unit_node_id = 'd-pk'`)).rows[0].n)).toBe(2);
    });

    it("an unknown company and an unknown updated_by are refused", async () => {
      const before = await total();
      await expect(
        adminPool().query(`INSERT INTO assistant_dept_preambles (tenant_id, unit_node_id, body) VALUES ($1, 'd-x', 'b')`, ["11111111-1111-4111-8111-111111111111"]),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
      await refused(FK_VIOLATION, A, { updated_by: "22222222-2222-4222-8222-222222222222" });
      expect(await total()).toBe(before);
    });
  });

  describe("erasure", () => {
    it("deleting the last editor NULLS updated_by and KEEPS the text (the text is the company's, not the person's)", async () => {
      const editor = await createUser("preamble-erased@schema.test", "Erased Editor");
      const unit = await insertRow(A, { updated_by: editor, body: "The head's rule." });
      await adminPool().query(`DELETE FROM users WHERE id = $1`, [editor]);
      const r = (await adminPool().query(`SELECT body, updated_by FROM assistant_dept_preambles WHERE tenant_id = $1 AND unit_node_id = $2`, [A, unit])).rows[0];
      expect(r).toEqual({ body: "The head's rule.", updated_by: null });
    });
  });

  describe("RLS", () => {
    it("the table is ENABLED and FORCED, with exactly one tenant_isolation policy", async () => {
      const { rows } = await adminPool().query(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
           FROM pg_class c WHERE c.relname = 'assistant_dept_preambles'`,
      );
      expect(rows).toEqual([{ relname: "assistant_dept_preambles", rls: true, forced: true, policies: 1 }]);
    });

    it("with the tenant GUC UNSET the app role reads ZERO rows (never an error), though rows exist", async () => {
      await insertRow(A);
      expect(await total()).toBeGreaterThan(0);
      const seen = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM assistant_dept_preambles`));
      expect(seen.rows[0].n).toBe(0);
    });

    it("another tenant's context reads none of A's rows, and cannot insert a row for A", async () => {
      const unit = await insertRow(A);
      expect((await withTenants([B], (c) => c.query(`SELECT unit_node_id FROM assistant_dept_preambles WHERE unit_node_id = $1`, [unit]))).rows).toEqual([]);
      expect((await withTenants([A], (c) => c.query(`SELECT unit_node_id FROM assistant_dept_preambles WHERE unit_node_id = $1`, [unit]))).rows.length).toBe(1);
      await expect(
        withTenants([B], (c) => c.query(`INSERT INTO assistant_dept_preambles (tenant_id, unit_node_id, body) VALUES ($1, 'd-leak', 'b')`, [A])),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
    });

    it("the SAME node id in two companies is two preambles: each tenant reads only its own", async () => {
      await insertRow(A, { unit_node_id: "d-same", body: "A text", updated_by: null });
      await insertRow(B, { unit_node_id: "d-same", body: "B text", updated_by: null });
      const seenByA = await withTenants([A], (c) => c.query(`SELECT body FROM assistant_dept_preambles WHERE unit_node_id = 'd-same'`));
      const seenByB = await withTenants([B], (c) => c.query(`SELECT body FROM assistant_dept_preambles WHERE unit_node_id = 'd-same'`));
      expect(seenByA.rows).toEqual([{ body: "A text" }]);
      expect(seenByB.rows).toEqual([{ body: "B text" }]);
    });
  });

  describe("the permission seed (202610291510)", () => {
    const keys = async (roleName: string) =>
      (
        await adminPool().query(
          `SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE r.company_id IS NULL AND r.name = $1 AND p.cerbos_kind = 'dept_assistant_preamble' ORDER BY p.key`,
          [roleName],
        )
      ).rows.map((r) => r.key as string);

    it("three grantable, non-sensitive, ui_grantable core permissions on the dept_assistant_preamble kind", async () => {
      const { rows } = await adminPool().query(
        `SELECT key, module_key, class, sensitive, ui_grantable FROM permissions WHERE cerbos_kind = 'dept_assistant_preamble' ORDER BY key`,
      );
      expect(rows).toEqual(
        ["edit", "manage", "read"].map((a) => ({ key: `core.dept_assistant_preamble.${a}`, module_key: "core", class: "grantable", sensitive: false, ui_grantable: true })),
      );
    });

    it("the full-reach tier holds all three, the head holds read and edit and NOT manage, nobody else holds any", async () => {
      const all = ["core.dept_assistant_preamble.edit", "core.dept_assistant_preamble.manage", "core.dept_assistant_preamble.read"];
      for (const role of ["platform_admin", "company_admin", "owner"]) expect(await keys(role), role).toEqual(all);
      expect(await keys("org_unit_lead")).toEqual(["core.dept_assistant_preamble.edit", "core.dept_assistant_preamble.read"]);
      for (const role of ["manager", "member", "viewer", "hr_staff", "hr_manager", "client", "reports_staff", "webdev_manager"]) expect(await keys(role), role).toEqual([]);
    });

    it("owner mirrors company_admin on the kind, no pair is self-scoped, and the bundled total is 11 (3 x 3 + 2)", async () => {
      expect(await keys("owner")).toEqual(await keys("company_admin"));
      const marked = await adminPool().query(
        `SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.cerbos_kind = 'dept_assistant_preamble' AND rp.self_scoped`,
      );
      expect(marked.rows[0].n).toBe(0);
      const all = (
        await adminPool().query(
          `SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_assistant_preamble'`,
        )
      ).rows[0].n;
      expect(all).toBe(11);
    });
  });
});
