// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57.1) — migration 202610152100_dept_notices.sql (the table) and 202610152110_iam_dept_notice_permissions.sql
// (the permission seed), proven against a REAL Postgres as the NOSUPERUSER NOBYPASSRLS app role: every CHECK (the scope/unit pairing
// from both sides, the title and body lengths, the withdrawn pairing), the column defaults, the FKs, the no-default `origin_site`, RLS
// (zero rows with the tenant GUC unset, nothing across tenants, FORCE on), and the IAM seed's reach.
//
// Each refusal asserts the SQLSTATE AND that nothing was stored. A CHECK that passes on NULL would let a half-built row in silently, so
// the "must be refused" cases are ones where the offending column is NULL, not just wrong.
//
// Needs DATABASE_URL_TEST (a superuser URL to a disposable Postgres): the Linux gate. Skips without it; a skip is not a pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";

const CHECK_VIOLATION = "23514";
const NOT_NULL_VIOLATION = "23502";
const FK_VIOLATION = "23503";
const RLS_VIOLATION = "42501";

describe.skipIf(!TEST_URL)("DW-10a — dept_notices schema (as the NOBYPASSRLS app role)", () => {
  let A: string;
  let B: string;
  let userA: string;
  let userB: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Notice Tenant A");
    B = await createCompany("Notice Tenant B");
    userA = await createUser("notice-a@schema.test", "Notice A");
    userB = await createUser("notice-b@schema.test", "Notice B");
    await addMembership(A, userA);
    await addMembership(B, userB);
  }, 120_000);
  afterAll(teardownTestDb);

  /** Insert a notice for `tenant`. `cols` overrides the defaults (a unit notice on d-web); returns the id. */
  async function insertNotice(tenant: string, cols: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    const row: Record<string, unknown> = {
      id, tenant_id: tenant, scope: "unit", unit_node_id: "d-web", title: `Notice ${++seq}`, body: "Body text",
      author_id: tenant === A ? userA : userB, origin_site: "test", ...cols,
    };
    const names = Object.keys(row);
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO dept_notices (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => row[n])),
    );
    return id;
  }
  const total = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM dept_notices`)).rows[0].n);
  const refused = async (code: string, tenant: string, cols: Record<string, unknown>) => {
    const before = await total();
    await expect(insertNotice(tenant, cols)).rejects.toMatchObject({ code });
    expect(await total(), "a refused insert stores nothing").toBe(before);
  };

  describe("a notice and its defaults", () => {
    it("a unit notice and a company-wide notice are both stored, with pinned false and every optional column NULL", async () => {
      const u = await insertNotice(A);
      const c = await insertNotice(A, { scope: "company", unit_node_id: null });
      for (const id of [u, c]) {
        const r = (
          await adminPool().query(`SELECT pinned, ends_on, edited_at, edited_by, withdrawn_at, withdrawn_by, created_at FROM dept_notices WHERE id = $1`, [id])
        ).rows[0];
        expect(r).toMatchObject({ pinned: false, ends_on: null, edited_at: null, edited_by: null, withdrawn_at: null, withdrawn_by: null });
        expect(r.created_at).toBeInstanceOf(Date);
      }
    });
    it("origin_site has NO default: omitting it is refused", async () => {
      const before = await total();
      await expect(
        withTenants([A], (c) =>
          c.query(`INSERT INTO dept_notices (id, tenant_id, scope, unit_node_id, title, body, author_id) VALUES ($1, $2, 'unit', 'd-web', 't', 'b', $3)`, [newId(), A, userA]),
        ),
      ).rejects.toMatchObject({ code: NOT_NULL_VIOLATION });
      expect(await total()).toBe(before);
    });
  });

  describe("the scope / unit pairing (both directions, and the NULL cases)", () => {
    it("a unit notice with NO unit is refused (a NULL unit_node_id must not slip through the CHECK)", async () => {
      await refused(CHECK_VIOLATION, A, { scope: "unit", unit_node_id: null });
    });
    it("a unit notice with an EMPTY unit is refused", async () => {
      await refused(CHECK_VIOLATION, A, { scope: "unit", unit_node_id: "" });
    });
    it("a company-wide notice WITH a unit is refused", async () => {
      await refused(CHECK_VIOLATION, A, { scope: "company", unit_node_id: "d-web" });
    });
    it("a scope outside unit / company is refused", async () => {
      await refused(CHECK_VIOLATION, A, { scope: "team" });
    });
    it("a NULL scope is refused (NOT NULL), not passed by the CHECK", async () => {
      await refused(NOT_NULL_VIOLATION, A, { scope: null });
    });
  });

  describe("title and body lengths", () => {
    it("1 to 120 title characters and 1 to 4,000 body characters are accepted at the edges", async () => {
      await insertNotice(A, { title: "x", body: "y" });
      await insertNotice(A, { title: "x".repeat(120), body: "y".repeat(4000) });
    });
    it("an empty or over-long title is refused; so is an empty or over-long body", async () => {
      await refused(CHECK_VIOLATION, A, { title: "" });
      await refused(CHECK_VIOLATION, A, { title: "x".repeat(121) });
      await refused(CHECK_VIOLATION, A, { body: "" });
      await refused(CHECK_VIOLATION, A, { body: "y".repeat(4001) });
    });
    it("a NULL title or body is refused", async () => {
      await refused(NOT_NULL_VIOLATION, A, { title: null });
      await refused(NOT_NULL_VIOLATION, A, { body: null });
    });
  });

  describe("the withdrawal pairing: withdrawn_at and withdrawn_by are set together or not at all", () => {
    it("both set is accepted; both NULL is the default", async () => {
      await insertNotice(A, { withdrawn_at: "2026-10-15T01:00:00Z", withdrawn_by: userA });
    });
    it("withdrawn_at without withdrawn_by is refused, and withdrawn_by without withdrawn_at is refused", async () => {
      await refused(CHECK_VIOLATION, A, { withdrawn_at: "2026-10-15T01:00:00Z", withdrawn_by: null });
      await refused(CHECK_VIOLATION, A, { withdrawn_at: null, withdrawn_by: userA });
    });
  });

  describe("foreign keys", () => {
    it("an unknown author, editor or withdrawer is refused", async () => {
      await refused(FK_VIOLATION, A, { author_id: newId() });
      await refused(FK_VIOLATION, A, { edited_by: newId(), edited_at: "2026-10-15T01:00:00Z" });
      await refused(FK_VIOLATION, A, { withdrawn_by: newId(), withdrawn_at: "2026-10-15T01:00:00Z" });
    });
    it("an unknown company is refused", async () => {
      const before = await total();
      await expect(
        adminPool().query(`INSERT INTO dept_notices (id, tenant_id, scope, unit_node_id, title, body, author_id, origin_site) VALUES ($1, $2, 'unit', 'd-web', 't', 'b', $3, 'test')`, [newId(), newId(), userA]),
      ).rejects.toMatchObject({ code: FK_VIOLATION });
      expect(await total()).toBe(before);
    });
  });

  describe("RLS", () => {
    it("the table is ENABLED and FORCED, with exactly one tenant_isolation policy", async () => {
      const { rows } = await adminPool().query(
        `SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname AND p.policyname = 'tenant_isolation') AS policies
           FROM pg_class c WHERE c.relname = 'dept_notices'`,
      );
      expect(rows).toEqual([{ relname: "dept_notices", rls: true, forced: true, policies: 1 }]);
    });

    it("with the tenant GUC UNSET the app role reads ZERO rows (never an error), though rows exist", async () => {
      await insertNotice(A);
      expect(await total()).toBeGreaterThan(0);
      const seen = await withGlobal((c) => c.query(`SELECT count(*)::int AS n FROM dept_notices`));
      expect(seen.rows[0].n).toBe(0);
    });

    it("another tenant's context reads none of A's rows, and cannot insert a row for A", async () => {
      const id = await insertNotice(A);
      expect((await withTenants([B], (c) => c.query(`SELECT id FROM dept_notices WHERE id = $1`, [id]))).rows).toEqual([]);
      expect((await withTenants([A], (c) => c.query(`SELECT id FROM dept_notices WHERE id = $1`, [id]))).rows.length).toBe(1);
      await expect(
        withTenants([B], (c) =>
          c.query(`INSERT INTO dept_notices (id, tenant_id, scope, unit_node_id, title, body, author_id, origin_site) VALUES ($1, $2, 'unit', 'd-web', 't', 'b', $3, 'test')`, [newId(), A, userA]),
        ),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
    });

    it("the SAME node id in two companies is two boards: each tenant reads only its own d-web notices", async () => {
      const a = await insertNotice(A, { unit_node_id: "d-same" });
      const b = await insertNotice(B, { unit_node_id: "d-same" });
      const seenByA = await withTenants([A], (c) => c.query(`SELECT id FROM dept_notices WHERE unit_node_id = 'd-same'`));
      const seenByB = await withTenants([B], (c) => c.query(`SELECT id FROM dept_notices WHERE unit_node_id = 'd-same'`));
      expect(seenByA.rows.map((r) => r.id)).toEqual([a]);
      expect(seenByB.rows.map((r) => r.id)).toEqual([b]);
    });
  });

  describe("the permission seed (202610152110)", () => {
    const bundled = async (roleName: string) =>
      (
        await adminPool().query(
          `SELECT p.key, rp.self_scoped FROM role_permissions rp JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
            WHERE r.company_id IS NULL AND r.name = $1 AND p.cerbos_kind = 'dept_notice' ORDER BY p.key`,
          [roleName],
        )
      ).rows;
    const keys = async (roleName: string) => (await bundled(roleName)).map((r) => r.key as string);

    it("four grantable, non-sensitive, ui_grantable core permissions on the dept_notice kind", async () => {
      const { rows } = await adminPool().query(
        `SELECT key, module_key, class, sensitive, ui_grantable FROM permissions WHERE cerbos_kind = 'dept_notice' ORDER BY key`,
      );
      expect(rows).toEqual(
        ["edit", "post", "read", "withdraw"].map((a) => ({ key: `core.dept_notice.${a}`, module_key: "core", class: "grantable", sensitive: false, ui_grantable: true })),
      );
    });
    it("the full-reach tier holds all four, the scope roles and the HR tier read, the head posts, edits and withdraws, nobody else holds any", async () => {
      const all = ["core.dept_notice.edit", "core.dept_notice.post", "core.dept_notice.read", "core.dept_notice.withdraw"];
      for (const role of ["platform_admin", "company_admin", "owner"]) expect(await keys(role), role).toEqual(all);
      for (const role of ["manager", "member", "viewer", "hr_staff", "hr_manager"]) expect(await keys(role), role).toEqual(["core.dept_notice.read"]);
      expect(await keys("org_unit_lead")).toEqual(["core.dept_notice.edit", "core.dept_notice.post", "core.dept_notice.withdraw"]);
      for (const role of ["client", "reports_staff", "webdev_manager"]) expect(await keys(role), role).toEqual([]);
    });
    it("no pair is self-scoped, and the bundled total is 20 (3 x 4 + 5 + 3)", async () => {
      const marked = await adminPool().query(
        `SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.cerbos_kind = 'dept_notice' AND rp.self_scoped`,
      );
      expect(marked.rows[0].n).toBe(0);
      const before = (await adminPool().query(`SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.cerbos_kind = 'dept_notice'`)).rows[0].n;
      expect(before).toBe(20);
    });
  });
});
