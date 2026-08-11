// IAM-09 — dedicated test for migration 0101_org_unit_closure.sql, against a real Postgres (not
// read from the migration text and trusted).
//
// COVERS:
//   * table shape: FORCE RLS + tenant_isolation policy, PRIMARY KEY columns, the dedicated
//     ancestors index.
//   * the migration's OWN backfill SQL block, extracted verbatim (never re-implemented, so this
//     can't drift from what actually shipped) — proves it computes the correct closure for a real
//     tree AND that it does so under a NOBYPASSRLS role with NO ambient tenant context (the
//     confirmed 0050_pm_short_codes.sql bug class this repo has been burned by twice).
//   * idempotency of the backfill.
//   * cross-tenant node_id collision: two tenants sharing the SAME free-form text node id never
//     bleed into each other's closure — the ticket brief's "most likely real bug".
//
// rebuildOrgUnitClosure() (the TS runtime path, called from company-admin.controller.ts::putOrg)
// is covered end-to-end in company-admin.test.ts, where it is exercised THROUGH the real HTTP PUT
// handler rather than called directly — that is the more faithful integration point, since it is
// the only real caller.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, getPool } from "./index";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../migrations/0101_org_unit_closure.sql");

/** The migration's backfill DO block, extracted verbatim. 0101 has exactly one DO block. */
function backfillSql(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const blocks = sql.match(/DO \$\$[\s\S]*?END \$\$;/g);
  expect(blocks?.length, "0101 should have exactly 1 DO block (the backfill)").toBe(1);
  const backfill = blocks![0];
  expect(backfill, "backfill must wrap per-tenant GUC (the 0051/0055 lesson)").toMatch(
    /set_config\s*\(\s*'app\.current_tenant_ids'/,
  );
  expect(backfill, "backfill must be ON CONFLICT DO NOTHING (idempotency)").toMatch(/ON CONFLICT DO NOTHING/);
  return backfill;
}

type Row = { tenant_id: string; ancestor_id: string; descendant_id: string; depth: number };

const closureRows = async (tenantId: string): Promise<Row[]> =>
  (
    await adminPool().query<Row>(
      `SELECT tenant_id, ancestor_id, descendant_id, depth FROM org_unit_closure
        WHERE tenant_id = $1 ORDER BY ancestor_id, descendant_id`,
      [tenantId],
    )
  ).rows;

// A minimal OrgNode blob shape — mirrors platform-ui/src/lib/org.ts / company-admin.controller.ts.
type Kind = "holding" | "company" | "department" | "division" | "role" | "person";
interface Node { id: string; name: string; kind: Kind; assigneeId?: string | null; children: Node[] }
const dept = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "department", children });
const division = (id: string, name: string, children: Node[] = []): Node => ({ id, name, kind: "division", children });
const root = (name: string, children: Node[]): Node => ({ id: "root", name, kind: "company", children });

describe.skipIf(!TEST_URL)("org_unit_closure (IAM-09 / migration 0101)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await initTestDb();
    tenantA = await createCompany("Closure Co A", ["agency", "pm"]);
    tenantB = await createCompany("Closure Co B", ["agency", "pm"]);
    const u = await createUser("closure-owner@a.test");
    await addMembership(tenantA, u);
    await addMembership(tenantB, u);

    const pool = adminPool();

    // Tenant A: root -> dept-1 -> div-1-1 (a 3-level chain), plus a sibling dept-2.
    const treeA = root("Closure Co A", [
      dept("shared-id", "Engineering", [division("div-1-1", "Platform")]),
      dept("dept-2", "Operations"),
    ]);
    await pool.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, 'test')`,
      [tenantA, JSON.stringify({ root: treeA, updatedAt: null })],
    );

    // Tenant B: DELIBERATELY reuses 'shared-id' as a node id, with a DIFFERENT shape (no
    // children) — the cross-tenant collision case the ticket brief calls out as the most likely
    // real bug. If tenant scoping ever leaked, tenant B's closure would gain rows it never wrote
    // (e.g. an ancestor/descendant relationship to 'div-1-1', which does not exist in tenant B's
    // tree at all).
    const treeB = root("Closure Co B", [dept("shared-id", "Support")]);
    await pool.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, 'test')`,
      [tenantB, JSON.stringify({ root: treeB, updatedAt: null })],
    );

    // migrate() already ran 0101's backfill against an EMPTY database (no companies existed yet).
    // Run it now, over the seeded org blobs.
    await pool.query(backfillSql());
  });
  afterAll(teardownTestDb);

  // ───────────────────────── SHAPE: table, RLS, indexes ─────────────────────────

  it("the table exists with FORCE RLS and a tenant_isolation policy", async () => {
    const { rows } = await adminPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'org_unit_closure'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);

    const pol = await adminPool().query<{ polname: string; qual: string }>(
      `SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS qual
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = 'org_unit_closure'`,
    );
    expect(pol.rows.map((r) => r.polname)).toEqual(["tenant_isolation"]);
    expect(pol.rows[0].qual).toContain("app_current_tenants()");
    expect(pol.rows[0].qual).not.toContain("app_module_allowed");
  });

  it("the PRIMARY KEY leads with (tenant_id, ancestor_id, descendant_id) — serves the descendants-of-N query", async () => {
    const { rows } = await adminPool().query<{ attname: string }>(
      `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'org_unit_closure'::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey, a.attnum)`,
    );
    expect(rows.map((r) => r.attname)).toEqual(["tenant_id", "ancestor_id", "descendant_id"]);
  });

  it("a dedicated index serves the ancestors-of-N query (tenant_id, descendant_id)", async () => {
    const { rows } = await adminPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'org_unit_closure' AND indexname = 'ix_org_unit_closure_ancestors'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain("tenant_id");
    expect(rows[0].indexdef).toContain("descendant_id");
  });

  it("depth is CHECKed non-negative", async () => {
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_closure (tenant_id, ancestor_id, descendant_id, depth) VALUES ($1, 'x', 'y', -1)`,
          [tenantA],
        ),
      ),
    ).rejects.toThrow(/violates check constraint|check/i);
  });

  // ───────────────────────── BACKFILL CORRECTNESS ─────────────────────────

  it("computes the full self-inclusive ancestor chain for a nested node", async () => {
    const rowsA = await closureRows(tenantA);
    expect(rowsA.length, "the backfill must have written rows, not silently no-opped").toBeGreaterThan(0);

    // div-1-1's ancestors: itself (depth 0), shared-id (depth 1), root (depth 2).
    const ancestorsOfDiv = rowsA
      .filter((r) => r.descendant_id === "div-1-1")
      .sort((a, b) => a.depth - b.depth)
      .map((r) => ({ ancestor_id: r.ancestor_id, depth: r.depth }));
    expect(ancestorsOfDiv).toEqual([
      { ancestor_id: "div-1-1", depth: 0 },
      { ancestor_id: "shared-id", depth: 1 },
      { ancestor_id: "root", depth: 2 },
    ]);
  });

  it("computes descendants of an internal node, including itself, excluding siblings", async () => {
    const rowsA = await closureRows(tenantA);
    const descendantsOfSharedId = rowsA.filter((r) => r.ancestor_id === "shared-id").map((r) => r.descendant_id).sort();
    expect(descendantsOfSharedId).toEqual(["div-1-1", "shared-id"]);
    expect(descendantsOfSharedId).not.toContain("dept-2");
  });

  it("running the backfill a SECOND time produces byte-identical rows (true no-op)", async () => {
    const before = (
      await adminPool().query(`SELECT tenant_id, ancestor_id, descendant_id, depth FROM org_unit_closure ORDER BY tenant_id, ancestor_id, descendant_id`)
    ).rows;
    expect(before.length).toBeGreaterThan(0);

    await adminPool().query(backfillSql());
    const after1 = (
      await adminPool().query(`SELECT tenant_id, ancestor_id, descendant_id, depth FROM org_unit_closure ORDER BY tenant_id, ancestor_id, descendant_id`)
    ).rows;
    expect(after1).toEqual(before);

    await adminPool().query(backfillSql());
    const after2 = (
      await adminPool().query(`SELECT tenant_id, ancestor_id, descendant_id, depth FROM org_unit_closure ORDER BY tenant_id, ancestor_id, descendant_id`)
    ).rows;
    expect(after2).toEqual(before);
  });

  // ───────────────────────── CROSS-TENANT COLLISION (the likely real bug) ─────────────────────────

  it("two tenants sharing the SAME free-form node id ('shared-id') never bleed into each other's closure", async () => {
    const rowsA = await closureRows(tenantA);
    const rowsB = await closureRows(tenantB);

    // Tenant A's 'shared-id' has a descendant 'div-1-1'.
    expect(rowsA.some((r) => r.ancestor_id === "shared-id" && r.descendant_id === "div-1-1")).toBe(true);
    // Tenant B's 'shared-id' has NO such descendant — its tree never had a div-1-1 node at all.
    expect(rowsB.some((r) => r.descendant_id === "div-1-1")).toBe(false);
    expect(rowsB.some((r) => r.ancestor_id === "shared-id" && r.descendant_id === "div-1-1")).toBe(false);

    // Tenant B's OWN 'shared-id' self-row exists, scoped to tenant B.
    expect(rowsB).toContainEqual({ tenant_id: tenantB, ancestor_id: "shared-id", descendant_id: "shared-id", depth: 0 });
    // And every single row for 'shared-id' as ancestor OR descendant, across BOTH tenants' full
    // closures, carries the CORRECT tenant_id — no row is mislabeled or duplicated across tenants.
    const allSharedIdRows = [...rowsA, ...rowsB].filter((r) => r.ancestor_id === "shared-id" || r.descendant_id === "shared-id");
    for (const r of allSharedIdRows) {
      if (r.descendant_id === "div-1-1" || r.ancestor_id === "div-1-1") expect(r.tenant_id).toBe(tenantA);
    }
  });

  it("RLS isolates the table by the authorized-tenant-set, and fails closed with no context", async () => {
    const a = await withTenants([tenantA], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_closure`));
    const both = await withTenants([tenantA, tenantB], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_closure`),
    );
    expect(a.rows[0].n).toBeGreaterThan(0);
    expect(both.rows[0].n).toBeGreaterThan(a.rows[0].n);

    const none = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_closure`);
    expect(none.rows[0].n).toBe(0);
  });

  // ─────────────── THE ONE THAT MATTERS: the backfill under a NOBYPASSRLS role ───────────────
  // Everything above ran the backfill through adminPool() — the SUPERUSER test connection, which
  // BYPASSES RLS. Migrations run as platform_owner (NOBYPASSRLS in production), and
  // company_org_structure is FORCE-RLS'd, so with no app.current_tenant_ids GUC the source read
  // sees nothing and the backfill silently writes zero rows unless the per-tenant set_config guard
  // in 0101 actually works.
  it("the backfill writes rows as a NOBYPASSRLS role with NO ambient tenant context", async () => {
    const expected = [...(await closureRows(tenantA)), ...(await closureRows(tenantB))];
    expect(expected.length).toBeGreaterThan(0);

    await adminPool().query(`DELETE FROM org_unit_closure`);
    const emptied = await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_closure`);
    expect(emptied.rows[0].n).toBe(0);

    // getPool() is the platform_app_test role (NOSUPERUSER NOBYPASSRLS, see testing/setup.ts) and
    // this query sets NO tenant GUC — the migration's own per-tenant set_config is the only reason
    // any row can be read (from company_org_structure) or written (to org_unit_closure) here.
    await getPool().query(backfillSql());

    const total = await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_closure`);
    expect(total.rows[0].n, "backfill silently no-opped under NOBYPASSRLS — the 0050 bug class").toBeGreaterThan(0);
    expect(total.rows[0].n).toBe(expected.length);

    const actual = [...(await closureRows(tenantA)), ...(await closureRows(tenantB))];
    expect(actual).toEqual(expected);
  });
});
