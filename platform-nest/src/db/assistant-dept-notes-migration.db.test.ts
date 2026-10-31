// AIP-23b (docs/PERMISSION-CONTRACT.md §59, FRONTEND-BFF-CONTRACT §67; plan docs/plans/2026-10-31-aip-23-department-notes.md §4.7) — migration
// 202610311700_assistant_dept_notes.sql (the table) and 202610311710_iam_dept_assistant_note_permissions.sql (the permission seed), proven against
// a REAL Postgres as the NOSUPERUSER NOBYPASSRLS app role: the CHECKs (body 0/1/500/501 characters in code points, the unit id, the status, the
// record pair, the decision shape, pinned only when approved, the stored names), the defaults, the FKs, ERASURE (AIP-D23: deleting the author or
// the approver NULLS the id and KEEPS the note and the stored name, waiting or approved), RLS (zero rows with the tenant GUC unset, nothing across
// tenants, FORCE on), and the IAM seed's reach (manage the owner's only, the approver keys the head's only, withdraw self-scoped, owner == company
// admin + manage).
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
const RLS_VIOLATION = "42501";

describe.skipIf(!TEST_URL)("AIP-23b — assistant_dept_notes schema (as the NOBYPASSRLS app role)", () => {
  let A: string;
  let B: string;
  let userA: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Notes Tenant A");
    B = await createCompany("Notes Tenant B");
    userA = await createUser("notes-a@schema.test", "Notes A");
    await addMembership(A, userA);
  }, 120_000);
  afterAll(teardownTestDb);

  /** Insert a note for `tenant` (as the app role, in that tenant's context). `cols` overrides the defaults; returns the id. */
  async function insertRow(tenant: string, cols: Record<string, unknown> = {}): Promise<string> {
    const row: Record<string, unknown> = { tenant_id: tenant, unit_node_id: "d-web", body: "Body text", proposed_by: userA, proposed_by_name: "Notes A", ...cols };
    const names = Object.keys(row);
    const { rows } = await withTenants([tenant], (c) =>
      c.query<{ id: string }>(
        `INSERT INTO assistant_dept_notes (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        names.map((n) => row[n]),
      ),
    );
    return rows[0].id;
  }
  const total = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM assistant_dept_notes`)).rows[0].n);
  const refused = async (code: string, tenant: string, cols: Record<string, unknown>) => {
    const before = await total();
    await expect(insertRow(tenant, cols)).rejects.toMatchObject({ code });
    expect(await total(), "a refused insert stores nothing").toBe(before);
  };
  const approvedCols = (extra: Record<string, unknown> = {}) => ({ status: "approved", decided_by: userA, decided_by_name: "Notes A", decided_at: new Date(), ...extra });

  describe("a row, its defaults and its limits", () => {
    it("a waiting note is stored with id, status 'proposed', pinned false and the timestamps defaulted", async () => {
      const id = await insertRow(A);
      const r = (await adminPool().query(`SELECT * FROM assistant_dept_notes WHERE id = $1`, [id])).rows[0];
      expect(r).toMatchObject({ status: "proposed", pinned: false, decided_by: null, decided_by_name: null, decided_at: null, record_kind: null, record_id: null });
      for (const c of ["proposed_at", "created_at", "updated_at"]) expect(r[c]).toBeInstanceOf(Date);
    });

    it("the body CHECK: 1 and 500 characters are stored; 0, 501 and NULL are refused; it counts CODE POINTS", async () => {
      await insertRow(A, { body: "x" });
      await insertRow(A, { body: "x".repeat(500) });
      await insertRow(A, { body: "\u{1F600}".repeat(500) });
      await refused(CHECK_VIOLATION, A, { body: "" });
      await refused(CHECK_VIOLATION, A, { body: "x".repeat(501) });
      await refused(CHECK_VIOLATION, A, { body: "\u{1F600}".repeat(501) });
      await refused(NOT_NULL_VIOLATION, A, { body: null });
    });

    it("the unit id: 1 to 120 characters, required", async () => {
      await insertRow(A, { unit_node_id: "d".repeat(120) });
      await refused(CHECK_VIOLATION, A, { unit_node_id: "" });
      await refused(CHECK_VIOLATION, A, { unit_node_id: "d".repeat(121) });
      await refused(NOT_NULL_VIOLATION, A, { unit_node_id: null });
    });

    it("the status is proposed or approved only (rejected and withdrawn notes are DELETED, there is no third status)", async () => {
      for (const status of ["rejected", "withdrawn", "deleted", ""]) await refused(CHECK_VIOLATION, A, { status });
    });

    it("the record link: both halves or neither", async () => {
      await insertRow(A, { record_kind: "client", record_id: "0b7c4c1e-3f7a-4a59-9f1e-6a0b2c3d4e5f" });
      await refused(CHECK_VIOLATION, A, { record_kind: "client" });
      await refused(CHECK_VIOLATION, A, { record_id: "0b7c4c1e-3f7a-4a59-9f1e-6a0b2c3d4e5f" });
      await refused(CHECK_VIOLATION, A, { record_kind: "", record_id: "0b7c4c1e-3f7a-4a59-9f1e-6a0b2c3d4e5f" });
    });

    it("the decision shape: a waiting note carries no decision; an approved one carries when and the name (the id may be null after erasure)", async () => {
      await insertRow(A, approvedCols());
      await insertRow(A, approvedCols({ decided_by: null })); // the approver was erased: the name stays
      await refused(CHECK_VIOLATION, A, { decided_at: new Date() });
      await refused(CHECK_VIOLATION, A, { decided_by_name: "Hal Head" });
      await refused(CHECK_VIOLATION, A, { decided_by: userA });
      await refused(CHECK_VIOLATION, A, approvedCols({ decided_at: null }));
      await refused(CHECK_VIOLATION, A, approvedCols({ decided_by_name: null }));
    });

    it("pinned only when approved", async () => {
      await insertRow(A, approvedCols({ pinned: true }));
      await refused(CHECK_VIOLATION, A, { pinned: true });
    });

    it("the stored names: proposed_by_name is required, 1 to 200 characters; decided_by_name 1 to 200 when set", async () => {
      await insertRow(A, { proposed_by_name: "n".repeat(200) });
      await refused(NOT_NULL_VIOLATION, A, { proposed_by_name: null });
      await refused(CHECK_VIOLATION, A, { proposed_by_name: "" });
      await refused(CHECK_VIOLATION, A, { proposed_by_name: "n".repeat(201) });
      await refused(CHECK_VIOLATION, A, approvedCols({ decided_by_name: "" }));
      await refused(CHECK_VIOLATION, A, approvedCols({ decided_by_name: "n".repeat(201) }));
    });

    it("an unknown company and an unknown author are refused", async () => {
      const before = await total();
      await expect(
        adminPool().query(`INSERT INTO assistant_dept_notes (tenant_id, unit_node_id, body, proposed_by_name) VALUES ($1, 'd-x', 'b', 'n')`, ["11111111-1111-4111-8111-111111111111"]),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
      await refused(FK_VIOLATION, A, { proposed_by: "22222222-2222-4222-8222-222222222222" });
      expect(await total()).toBe(before);
    });
  });

  describe("erasure (AIP-D23: keep the note and the name)", () => {
    it("deleting the AUTHOR of a waiting note nulls proposed_by and keeps the note, its status and the stored name", async () => {
      const author = await createUser("notes-erased-author@schema.test", "Erased Author");
      const id = await insertRow(A, { proposed_by: author, proposed_by_name: "Erased Author", body: "Two hashtags at most." });
      await adminPool().query(`DELETE FROM users WHERE id = $1`, [author]);
      const r = (await adminPool().query(`SELECT body, status, proposed_by, proposed_by_name FROM assistant_dept_notes WHERE id = $1`, [id])).rows[0];
      expect(r).toEqual({ body: "Two hashtags at most.", status: "proposed", proposed_by: null, proposed_by_name: "Erased Author" });
    });

    it("deleting the APPROVER of an approved note nulls decided_by and keeps the note and both names", async () => {
      const approver = await createUser("notes-erased-approver@schema.test", "Erased Approver");
      const id = await insertRow(A, approvedCols({ decided_by: approver, decided_by_name: "Erased Approver" }));
      await adminPool().query(`DELETE FROM users WHERE id = $1`, [approver]);
      const r = (await adminPool().query(`SELECT status, decided_by, decided_by_name, proposed_by_name FROM assistant_dept_notes WHERE id = $1`, [id])).rows[0];
      expect(r).toEqual({ status: "approved", decided_by: null, decided_by_name: "Erased Approver", proposed_by_name: "Notes A" });
    });
  });

  describe("RLS", () => {
    it("the table is ENABLED and FORCED, with exactly one tenant_isolation policy", async () => {
      const { rows } = await adminPool().query(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies,
                (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS tenant_policies
           FROM pg_class c WHERE c.relname = 'assistant_dept_notes'`,
      );
      expect(rows).toEqual([{ relname: "assistant_dept_notes", rls: true, forced: true, policies: 1, tenant_policies: 1 }]);
    });

    it("with the tenant GUC UNSET the app role reads ZERO rows (never an error), though rows exist", async () => {
      await insertRow(A);
      expect(await total()).toBeGreaterThan(0);
      const seen = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM assistant_dept_notes`));
      expect(seen.rows[0].n).toBe(0);
    });

    it("another tenant's context reads none of A's rows, and cannot insert a row for A", async () => {
      const id = await insertRow(A);
      expect((await withTenants([B], (c) => c.query(`SELECT id FROM assistant_dept_notes WHERE id = $1`, [id]))).rows).toEqual([]);
      expect((await withTenants([A], (c) => c.query(`SELECT id FROM assistant_dept_notes WHERE id = $1`, [id]))).rows.length).toBe(1);
      await expect(
        withTenants([B], (c) => c.query(`INSERT INTO assistant_dept_notes (tenant_id, unit_node_id, body, proposed_by_name) VALUES ($1, 'd-leak', 'b', 'n')`, [A])),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
    });

    it("the indexes the caps and lists use exist", async () => {
      const { rows } = await adminPool().query(`SELECT indexname FROM pg_indexes WHERE tablename = 'assistant_dept_notes' ORDER BY indexname`);
      expect(rows.map((r) => r.indexname)).toEqual(expect.arrayContaining(["ix_assistant_dept_notes_proposer", "ix_assistant_dept_notes_unit"]));
    });
  });

  describe("the permission seed (202610311710)", () => {
    const keys = async (roleName: string) =>
      (
        await adminPool().query(
          `SELECT p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE r.company_id IS NULL AND r.name = $1 AND p.cerbos_kind = 'dept_assistant_note' ORDER BY p.key`,
          [roleName],
        )
      ).rows.map((r) => r.key as string);
    const K = (a: string) => `core.dept_assistant_note.${a}`;

    it("seven grantable, non-sensitive core permissions; only manage is not UI-grantable", async () => {
      const { rows } = await adminPool().query(
        `SELECT key, module_key, class, sensitive, ui_grantable FROM permissions WHERE cerbos_kind = 'dept_assistant_note' ORDER BY key`,
      );
      expect(rows).toEqual(
        ["decide", "delete", "manage", "pin", "propose", "read", "withdraw"].map((a) => ({
          key: K(a), module_key: "core", class: "grantable", sensitive: false, ui_grantable: a !== "manage",
        })),
      );
    });

    it("the reach by role: the wildcard all seven; the staff the member-level keys; the head the approver keys; the owner company_admin's plus manage", async () => {
      expect(await keys("platform_admin")).toEqual(["decide", "delete", "manage", "pin", "propose", "read", "withdraw"].map(K));
      for (const role of ["company_admin", "manager", "member"]) expect(await keys(role), role).toEqual(["propose", "read", "withdraw"].map(K));
      expect(await keys("viewer")).toEqual(["read", "withdraw"].map(K));
      expect(await keys("org_unit_lead")).toEqual(["decide", "delete", "pin", "read"].map(K));
      expect(await keys("owner")).toEqual(["manage", "propose", "read", "withdraw"].map(K));
      for (const role of ["hr_staff", "hr_manager", "client", "reports_staff", "webdev_manager"]) expect(await keys(role), role).toEqual([]);
    });

    it("withdraw is self-scoped for exactly the four staff roles; the bundled total is 26", async () => {
      const marked = await adminPool().query(
        `SELECT r.name, p.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
          WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_assistant_note' AND rp.self_scoped ORDER BY r.name`,
      );
      expect(marked.rows).toEqual(["company_admin", "manager", "member", "viewer"].map((name) => ({ name, key: K("withdraw") })));
      const all = (
        await adminPool().query(
          `SELECT count(*)::int AS n FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE r.company_id IS NULL AND p.cerbos_kind = 'dept_assistant_note'`,
        )
      ).rows[0].n;
      expect(all).toBe(26);
    });
  });
});
