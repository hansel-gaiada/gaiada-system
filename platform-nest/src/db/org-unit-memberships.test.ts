// TR-03 — org_unit_memberships (0055): the time-aware person<->org-unit membership substrate
// TR-04's server-side department resolution will read as-of a date (§3.2). Against live Postgres +
// real RLS, same harness style as pm-task-assignees.test.ts (0054).
//
// Weighted toward the BACKFILL and the EXCLUDE non-overlap constraint, per the ticket's acceptance
// criteria:
//   * the EXCLUDE non-overlap constraint is proven by test: an overlapping PRIMARY membership for
//     the same (tenant, user) is rejected; a non-primary overlap is allowed; adjacent
//     non-overlapping ranges are allowed.
//   * the backfill creates exactly one open primary row per person currently placed in the org blob
//     (company_org_structure, walked for kind:'person' nodes with an assigneeId).
//   * the backfill writes rows under a NOBYPASSRLS role with NO ambient tenant context — the one
//     the existing conventions cannot catch on their own (initTestDb() runs migrate() as the
//     SUPERUSER test role, which bypasses RLS, so a migration whose backfill silently no-ops in
//     production passes a normal test run with flying colours; the confirmed 0050_pm_short_codes.sql
//     bug class, restated as a binding rule in the doc's §15 amendment log).
//
// Every assertion re-runs the MIGRATION FILE'S OWN SQL, parsed straight out of
// 0055_org_unit_memberships.sql — never a re-implementation that could drift from what shipped.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, getPool } from "./index";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../migrations/0055_org_unit_memberships.sql");

/** The migration's backfill DO block, extracted verbatim. The file has exactly two DO blocks:
 *  [0] the RLS enable/force/policy block (NOT re-runnable — CREATE POLICY would collide),
 *  [1] the backfill. */
function backfillSql(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const blocks = sql.match(/DO \$\$[\s\S]*?END \$\$;/g);
  expect(blocks?.length, "0055 should still have exactly 2 DO blocks (RLS, then backfill)").toBe(2);
  const backfill = blocks![1];
  expect(backfill, "backfill must wrap per-tenant GUC (the 0051 lesson)").toMatch(
    /set_config\s*\(\s*'app\.current_tenant_ids'/,
  );
  expect(backfill, "backfill must be ON CONFLICT DO NOTHING (idempotency)").toMatch(/ON CONFLICT DO NOTHING/);
  return backfill;
}

type Row = {
  tenant_id: string;
  user_id: string;
  unit_node_id: string;
  is_primary: boolean;
  valid_from: string; // date, comes back as YYYY-MM-DD string via pg driver's date parsing off
  valid_to: string | null;
  source: string;
  origin_site: string;
};

// A minimal OrgNode tree builder — mirrors platform-ui/src/lib/org.ts's shape
// {id, name, kind, assigneeId, children} without importing the UI package.
type Kind = "holding" | "company" | "department" | "division" | "role" | "person";
interface Node { id: string; name: string; kind: Kind; assigneeId?: string | null; children: Node[] }
const dept = (id: string, name: string, children: Node[]): Node => ({ id, name, kind: "department", children });
const division = (id: string, name: string, children: Node[]): Node => ({ id, name, kind: "division", children });
const role = (id: string, name: string, children: Node[]): Node => ({ id, name, kind: "role", children });
const person = (id: string, name: string, assigneeId: string | null): Node => ({
  id, name, kind: "person", assigneeId, children: [],
});
const root = (name: string, children: Node[]): Node => ({ id: "root", name, kind: "company", children });

describe.skipIf(!TEST_URL)("org_unit_memberships (TR-03 / migration 0055)", () => {
  let tenantA: string;
  let tenantB: string;
  let alice: string; // dept-1 -> div-1 -> role -> person(alice) — nested unit resolution
  let bob: string; // dept-2 person directly (no division) — has an OLD work_activity row
  const carolGhostRef = "u-legacy-placeholder"; // non-uuid assigneeId (the org.ts seed-data class of ref)
  const daveGhostUuid = "00000000-0000-4000-8000-0000000000ff"; // well-formed uuid, NOT a users row
  let erin: string; // placed with NO department/division ancestor at all (directly under root)
  let frank: string; // tenant B

  const semanticRows = async (tenant: string): Promise<Row[]> => {
    const { rows } = await adminPool().query<Row>(
      `SELECT tenant_id, user_id, unit_node_id, is_primary, valid_from::text, valid_to::text, source, origin_site
         FROM org_unit_memberships WHERE tenant_id = $1
        ORDER BY unit_node_id, user_id`,
      [tenant],
    );
    return rows;
  };

  beforeAll(async () => {
    await initTestDb();

    tenantA = await createCompany("Tracker Org Co A", ["agency", "pm"]);
    tenantB = await createCompany("Tracker Org Co B", ["agency", "pm"]);
    alice = await createUser("alice-oum@a.test", "Alice Nested");
    bob = await createUser("bob-oum@a.test", "Bob Direct");
    erin = await createUser("erin-oum@a.test", "Erin Unplaced-Unit");
    frank = await createUser("frank-oum@b.test", "Frank TenantB");
    for (const u of [alice, bob, erin]) await addMembership(tenantA, u);
    await addMembership(tenantB, frank);

    const pool = adminPool();

    // tenant A's org blob:
    //  root(company)
    //    dept-1 (department)
    //      div-1 (division)
    //        role-1 (role)
    //          person(alice)              <- nearest unit ancestor = div-1, NOT dept-1
    //    dept-2 (department)
    //      person(bob)                    <- direct-under-department placement, no division
    //      person(carol, ref=carolGhostRef)  <- non-uuid ref, unrepresentable -> skipped
    //      person(dave, ref=daveGhostUuid)   <- well-formed uuid, no such users row -> skipped
    //      person(no-assignee, ref=null)     <- assigneeId null -> not walked at all
    //    person(erin) directly under root   <- NO department/division ancestor -> unit_node_id NULL -> skipped
    const treeA = root("Tracker Org Co A", [
      dept("dept-1", "Engineering", [
        division("dept-1-div-1", "Platform", [
          role("dept-1-div-1-role-1", "Senior Dev", [person("dept-1-div-1-role-1-p1", "Alice", alice)]),
        ]),
      ]),
      dept("dept-2", "Operations", [
        person("dept-2-p1", "Bob", bob),
        person("dept-2-p2", "Carol", carolGhostRef),
        person("dept-2-p3", "Dave", daveGhostUuid),
        person("dept-2-p4", "Nobody", null),
      ]),
      person("root-p1", "Erin", erin),
    ]);
    await pool.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, 'test')`,
      [tenantA, JSON.stringify({ root: treeA, updatedAt: null })],
    );

    // tenant B's org blob — a single department with Frank, to prove tenant scoping.
    const treeB = root("Tracker Org Co B", [dept("b-dept-1", "Support", [person("b-dept-1-p1", "Frank", frank)])]);
    await pool.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1, $2, 'test')`,
      [tenantB, JSON.stringify({ root: treeB, updatedAt: null })],
    );

    // Bob has an OLD work_activity row (predates the company's created_at) — proves the backfill's
    // LEAST(company.created_at, min(work_activity.occurred_at)) picks the EARLIER evidence date,
    // not just the company's own creation date. A throwaway project row satisfies work_activity's
    // schema (tenant_id/source/source_ref/verb/object_kind/object_ref/origin_site all NOT NULL).
    await pool.query(
      `INSERT INTO work_activity
         (tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
       VALUES ($1, 'manual', 'oum-test-bob-1', $2, 'created', 'task', 'ref-1', '2000-01-15', 'test')`,
      [tenantA, bob],
    );

    // migrate() already ran 0055's backfill — against an EMPTY database (no companies existed yet),
    // so it was a legitimate no-op. Run it now, over the seeded org blobs.
    await pool.query(backfillSql());
  });

  afterAll(teardownTestDb);

  // ───────────────────────── SHAPE: table, constraints, indexes ─────────────────────────

  it("the table exists with FORCE RLS and a tenant_isolation policy", async () => {
    const { rows } = await adminPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'org_unit_memberships'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);

    const pol = await adminPool().query<{ polname: string; qual: string }>(
      `SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS qual
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = 'org_unit_memberships'`,
    );
    expect(pol.rows.map((r) => r.polname)).toEqual(["tenant_isolation"]);
    expect(pol.rows[0].qual).toContain("app_current_tenants()");
    expect(pol.rows[0].qual).not.toContain("app_module_allowed");
  });

  it("btree_gist is installed and the EXCLUDE constraint exists on the table", async () => {
    const ext = await adminPool().query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(ext.rows).toHaveLength(1);
    const con = await adminPool().query<{ conname: string; contype: string }>(
      `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'org_unit_memberships'::regclass AND contype = 'x'`,
    );
    expect(con.rows.map((r) => r.conname)).toEqual(["org_unit_memberships_no_overlap"]);
  });

  // ───────────────────────── BLOB -> ROWS: the tree walk ─────────────────────────

  it("every placed person with a resolvable assignee backfills to exactly one open primary row", async () => {
    const all = await semanticRows(tenantA);
    expect(all.length, "the backfill must have written rows, not silently no-opped").toBeGreaterThan(0);

    // Alice: nested department -> division -> role -> person. The NEAREST unit ancestor is the
    // DIVISION (dept-1-div-1), not the department — proves the tree walk tracks the nearest
    // department/division ancestor, not just "the top-level department".
    const aliceRow = all.find((r) => r.user_id === alice);
    expect(aliceRow).toBeDefined();
    expect(aliceRow).toMatchObject({
      unit_node_id: "dept-1-div-1",
      is_primary: true,
      valid_to: null,
      source: "backfill",
      origin_site: "test",
    });

    // Bob: direct-under-department placement (no division) -> unit is the department itself.
    const bobRow = all.find((r) => r.user_id === bob);
    expect(bobRow).toBeDefined();
    expect(bobRow!.unit_node_id).toBe("dept-2");
    // Bob's OLD work_activity row (2000-01-15) predates the company's created_at -> LEAST picks it.
    expect(bobRow!.valid_from).toBe("2000-01-15");

    // Carol (non-uuid ref) and Dave (uuid-shaped but no such users row): unrepresentable, skipped —
    // never guessed at, never an FK violation that would abort the transaction.
    expect(all.find((r) => r.unit_node_id === "dept-2" && r.user_id === carolGhostRef)).toBeUndefined();
    expect(all.some((r) => r.user_id === daveGhostUuid)).toBe(false);

    // Erin: placed directly under root (company), no department/division ancestor at all ->
    // unit_node_id would be NULL -> unrepresentable -> skipped (NOT a NULL-unit row; the NOT NULL
    // column constraint would reject that outright, which is exactly why the backfill filters it).
    expect(all.some((r) => r.user_id === erin)).toBe(false);

    // Exactly two real rows for tenant A (Alice, Bob) — nothing invented, nothing missed.
    expect(all.map((r) => r.user_id).sort()).toEqual([alice, bob].sort());
  });

  it("a person with no work_activity evidence falls back to the company's own created_at", async () => {
    const [company] = (
      await adminPool().query<{ created_at: string }>(`SELECT created_at::date::text AS created_at FROM companies WHERE id = $1`, [tenantA])
    ).rows;
    const all = await semanticRows(tenantA);
    const aliceRow = all.find((r) => r.user_id === alice)!;
    // Alice has NO work_activity rows in this suite -> LEAST(company.created_at, NULL) = company.created_at.
    expect(aliceRow.valid_from).toBe(company.created_at);
  });

  it("the backfill scopes rows to the owning tenant (tenant B's placement is not in tenant A)", async () => {
    const b = await semanticRows(tenantB);
    expect(b).toEqual([
      expect.objectContaining({ tenant_id: tenantB, user_id: frank, unit_node_id: "b-dept-1", is_primary: true }),
    ]);
    const a = await semanticRows(tenantA);
    expect(a.some((r) => r.user_id === frank)).toBe(false);
  });

  // ───────────────────────── IDEMPOTENCY ─────────────────────────

  it("running the backfill a SECOND time produces byte-identical rows (true no-op)", async () => {
    const fullSnapshot = async () =>
      (
        await adminPool().query(
          `SELECT id, tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site, created_at
             FROM org_unit_memberships ORDER BY tenant_id, user_id`,
        )
      ).rows;

    const before = await fullSnapshot();
    expect(before.length).toBeGreaterThan(0);

    await adminPool().query(backfillSql());
    expect(await fullSnapshot()).toEqual(before);

    await adminPool().query(backfillSql());
    expect(await fullSnapshot()).toEqual(before);
  });

  // ───────────────────────── THE EXCLUDE CONSTRAINT, PROVEN BY REJECTION/ACCEPTANCE ─────────────

  it("an overlapping PRIMARY membership for the same (tenant, user) is REJECTED", async () => {
    const testUser = await createUser("overlap-primary@a.test", "Overlap Primary");
    await addMembership(tenantA, testUser);
    await withTenants([tenantA], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1, $2, 'dept-1', true, '2026-01-01', '2026-06-30', 'manual', 'test')`,
        [tenantA, testUser],
      ),
    );
    // Overlaps the existing [2026-01-01, 2026-06-30] range by one day (2026-06-30).
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'dept-2', true, '2026-06-30', NULL, 'manual', 'test')`,
          [tenantA, testUser],
        ),
      ),
    ).rejects.toThrow(/org_unit_memberships_no_overlap/);
  });

  it("a NON-PRIMARY overlap for the same (tenant, user) is ALLOWED", async () => {
    const testUser = await createUser("overlap-nonprimary@a.test", "Overlap Non-Primary");
    await addMembership(tenantA, testUser);
    // A primary membership...
    await withTenants([tenantA], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1, $2, 'dept-1', true, '2026-01-01', NULL, 'manual', 'test')`,
        [tenantA, testUser],
      ),
    );
    // ...and a SECOND, non-primary membership covering the SAME date range as the primary one, plus
    // a THIRD non-primary membership overlapping the second — none of this competes with the
    // EXCLUDE constraint, which only guards WHERE (is_primary).
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'dept-committee-1', false, '2026-01-01', NULL, 'manual', 'test')`,
          [tenantA, testUser],
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'dept-committee-2', false, '2026-01-01', NULL, 'manual', 'test')`,
          [tenantA, testUser],
        ),
      ),
    ).resolves.toBeDefined();
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantA, testUser],
    );
    expect(Number(rows[0].n)).toBe(3);
  });

  it("ADJACENT non-overlapping primary ranges are ALLOWED (a clean transfer)", async () => {
    const testUser = await createUser("adjacent-transfer@a.test", "Adjacent Transfer");
    await addMembership(tenantA, testUser);
    // Old membership closes on 2026-03-15 (inclusive)...
    await withTenants([tenantA], (c) =>
      c.query(
        `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1, $2, 'dept-1', true, '2026-01-01', '2026-03-15', 'manual', 'test')`,
        [tenantA, testUser],
      ),
    );
    // ...new membership opens the VERY NEXT day. Adjacent, zero shared days -> must succeed.
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'dept-2', true, '2026-03-16', NULL, 'manual', 'test')`,
          [tenantA, testUser],
        ),
      ),
    ).resolves.toBeDefined();
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM org_unit_memberships WHERE tenant_id = $1 AND user_id = $2 AND is_primary`,
      [tenantA, testUser],
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it("the row-shape CHECKs reject malformed rows", async () => {
    const testUser = await createUser("checks@a.test", "Checks");
    await addMembership(tenantA, testUser);
    // valid_to before valid_from
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'dept-1', true, '2026-06-01', '2026-01-01', 'manual', 'test')`,
          [tenantA, testUser],
        ),
      ),
    ).rejects.toThrow(/org_unit_memberships_valid_range/);
    // empty unit_node_id
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, '', true, '2026-01-01', NULL, 'manual', 'test')`,
          [tenantA, testUser],
        ),
      ),
    ).rejects.toThrow(/org_unit_memberships_unit_nonempty/);
    // unknown source
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'dept-1', true, '2026-01-01', NULL, 'nonsense', 'test')`,
          [tenantA, testUser],
        ),
      ),
    ).rejects.toThrow(/org_unit_memberships_source_check/);
  });

  // ───────────────────────── RLS BEHAVIOUR ─────────────────────────

  it("RLS isolates the new table by the authorized-tenant-set, and fails closed with no context", async () => {
    const a = await withTenants([tenantA], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_memberships`),
    );
    const both = await withTenants([tenantA, tenantB], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_memberships`),
    );
    expect(a.rows[0].n).toBeGreaterThan(0);
    expect(both.rows[0].n).toBeGreaterThan(a.rows[0].n); // tenant B's row becomes visible

    const none = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM org_unit_memberships`);
    expect(none.rows[0].n).toBe(0);

    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO org_unit_memberships (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
           VALUES ($1, $2, 'dept-1', true, '2026-01-01', NULL, 'manual', 'test')`,
          [tenantB, frank],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ─────────────── THE ONE THAT MATTERS: the backfill under a NOBYPASSRLS role ───────────────
  // Everything above ran the backfill through adminPool() — the SUPERUSER test connection, which
  // BYPASSES RLS. That is exactly the blind spot that let 0050_pm_short_codes.sql ship a backfill
  // that silently touched zero rows in production: migrations run as platform_owner, which is
  // NOBYPASSRLS, and company_org_structure is FORCE-RLS'd, so with no app.current_tenant_ids GUC the
  // source SELECT sees nothing, the INSERT writes nothing, no error is raised, and the ledger
  // records success.
  it("the backfill writes rows as a NOBYPASSRLS role with NO ambient tenant context", async () => {
    const expected = [...(await semanticRows(tenantA)), ...(await semanticRows(tenantB))].filter(
      (r) => r.source === "backfill",
    );
    expect(expected.length).toBeGreaterThan(0);

    await adminPool().query(`DELETE FROM org_unit_memberships WHERE source = 'backfill'`);
    const emptied = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_unit_memberships WHERE source = 'backfill'`,
    );
    expect(emptied.rows[0].n).toBe(0);

    // getPool() is the platform_app_test role (NOSUPERUSER NOBYPASSRLS, see testing/setup.ts) and
    // this query sets NO tenant GUC — the migration's own per-tenant set_config is the only reason
    // any row can be read or written here.
    await getPool().query(backfillSql());

    const total = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org_unit_memberships WHERE source = 'backfill'`,
    );
    expect(total.rows[0].n, "backfill silently no-opped under NOBYPASSRLS — the 0050 bug class").toBeGreaterThan(0);
    expect(total.rows[0].n).toBe(expected.length);

    const actual = [...(await semanticRows(tenantA)), ...(await semanticRows(tenantB))].filter(
      (r) => r.source === "backfill",
    );
    expect(actual).toEqual(expected);

    // ...and still idempotent under this privilege model too.
    await getPool().query(backfillSql());
    expect(
      [...(await semanticRows(tenantA)), ...(await semanticRows(tenantB))].filter((r) => r.source === "backfill"),
    ).toEqual(expected);
  });
});
