// TR-01 — pm_task_assignees (0054): the relational assignee substrate every downstream report,
// rollup and appraisal number is derived from. Against live Postgres + real RLS, same harness style
// as pm-short-codes.test.ts.
//
// The tests are deliberately weighted toward the BACKFILL, because a wrong backfill here does not
// fail loudly — it silently mis-attributes every future number. Specifically:
//
//  * "the backfill actually writes rows under a NOBYPASSRLS role with NO ambient tenant context"
//    is the one that matters most, and it is the one the existing conventions CANNOT catch on their
//    own: initTestDb() runs migrate() as the SUPERUSER test role, which BYPASSES RLS, so a
//    migration whose backfill silently no-ops in production (the confirmed 0050_pm_short_codes.sql
//    bug) passes a normal test run with flying colours. And `npm run lint:migration-rls` doesn't
//    cover this file either — its `createdHere` carve-out skips DML whose TARGET table is created
//    in the same migration, and the no-op risk here is on the SOURCE side (pm_tasks). So this suite
//    re-executes the migration's own backfill block through the app's NOSUPERUSER NOBYPASSRLS pool,
//    with no tenant GUC set, and asserts a NON-ZERO row count plus byte-identical semantic output.
//
//  * every assertion re-runs the MIGRATION FILE'S OWN SQL, parsed straight out of
//    0054_pm_task_assignees.sql — never a re-implementation that could drift from what shipped.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, getPool } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../../migrations/0054_pm_task_assignees.sql");

/** The migration's backfill DO block, extracted verbatim. The file has exactly two DO blocks:
 *  [0] the RLS enable/force/policy block (NOT re-runnable — CREATE POLICY would collide),
 *  [1] the backfill. */
function backfillSql(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const blocks = sql.match(/DO \$\$[\s\S]*?END \$\$;/g);
  expect(blocks?.length, "0054 should still have exactly 2 DO blocks (RLS, then backfill)").toBe(2);
  const backfill = blocks![1];
  // Sanity-pin the two properties the whole ticket rests on, so a future edit that removes either
  // one fails HERE with a clear message rather than silently degrading attribution.
  expect(backfill, "backfill must wrap per-tenant GUC (the 0051 lesson)").toMatch(
    /set_config\s*\(\s*'app\.current_tenant_ids'/,
  );
  expect(backfill, "backfill must be ON CONFLICT DO NOTHING (idempotency)").toMatch(/ON CONFLICT DO NOTHING/);
  return backfill;
}

type Row = {
  task_id: string;
  role: string;
  assignee_kind: string;
  assignee_ref: string;
  user_id: string | null;
  origin_site: string;
};

describe.skipIf(!TEST_URL)("pm_task_assignees (TR-01 / migration 0054)", () => {
  let tenantA: string;
  let tenantB: string;
  let alice: string;
  let bob: string;
  let carol: string;
  let dave: string;
  const ghost = "00000000-0000-4000-8000-0000000000ff"; // well-formed uuid, NOT a users row

  // Fixed task ids so assertions read clearly.
  const T = {
    personSelf: "00000000-0000-7000-8000-0000000000a1", // person owner, responsible = same person
    personOther: "00000000-0000-7000-8000-0000000000a2", // person owner, responsible = someone else
    dept: "00000000-0000-7000-8000-0000000000a3", // department owner + responsible
    division: "00000000-0000-7000-8000-0000000000a4", // division owner, NO responsible
    noAssignee: "00000000-0000-7000-8000-0000000000a5", // assignee IS NULL
    badPersonRef: "00000000-0000-7000-8000-0000000000a6", // person refId is not a uuid
    ghostPersonRef: "00000000-0000-7000-8000-0000000000a7", // person refId is a uuid but no such user
    softDeleted: "00000000-0000-7000-8000-0000000000a8", // soft-deleted task, person owner
    otherTenant: "00000000-0000-7000-8000-0000000000a9", // lives in tenant B
  };

  const semanticRows = async (tenant: string): Promise<Row[]> => {
    const { rows } = await adminPool().query<Row>(
      `SELECT task_id, role, assignee_kind, assignee_ref, user_id, origin_site
         FROM pm_task_assignees WHERE tenant_id = $1
        ORDER BY task_id, role, assignee_ref`,
      [tenant],
    );
    return rows;
  };

  const rowsFor = (all: Row[], taskId: string) => all.filter((r) => r.task_id === taskId);

  beforeAll(async () => {
    await initTestDb();

    tenantA = await createCompany("Tracker Co A", ["agency", "pm"]);
    // MON-00b: `withTenants` now REFUSES a tenant set spanning two root company trees
    // (CrossRootTenantSetError), so two independently-created companies can no longer be authorized
    // together — which is what every "management path sees {A,B}" case below does. B is therefore a
    // SUBSIDIARY of A rather than an unrelated company: one root, two tenants.
    //
    // This does not weaken what these suites test. RLS isolation is keyed on `tenant_id`, not on the
    // root, so B remains a fully distinct tenant that A must not see; if anything it is the stronger
    // case, since isolation now has to hold for two companies that DO share a root. Cross-root
    // refusal is a separate guarantee, pinned in cross-root-boundary.db.test.ts.
    tenantB = await createCompany("Tracker Co B", ["agency", "pm"], tenantA);
    alice = await createUser("alice-tr01@a.test", "Alice Owner");
    bob = await createUser("bob-tr01@a.test", "Bob Responsible");
    carol = await createUser("carol-tr01@a.test", "Carol Responsible");
    dave = await createUser("dave-tr01@b.test", "Dave Rival");
    for (const u of [alice, bob, carol]) await addMembership(tenantA, u);
    await addMembership(tenantB, dave);

    // Seed "legacy" (pre-0054) rows DIRECTLY, bypassing the controller: TR-01 is schema-only, the
    // dual-write is TR-02, so the controller cannot be the source of these fixtures.
    const pool = adminPool();
    const projA = "00000000-0000-7000-8000-0000000000b1";
    const projB = "00000000-0000-7000-8000-0000000000b2";
    await pool.query(`INSERT INTO projects (id, tenant_id, name, origin_site) VALUES ($1, $2, 'Tracker Project A', 'test')`, [projA, tenantA]);
    await pool.query(`INSERT INTO projects (id, tenant_id, name, origin_site) VALUES ($1, $2, 'Tracker Project B', 'test')`, [projB, tenantB]);

    const task = async (
      id: string,
      tenant: string,
      project: string,
      title: string,
      assignee: unknown,
      deleted = false,
    ) =>
      pool.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, assignee, origin_site, deleted_at)
         VALUES ($1, $2, $3, $4, $5, 'test', $6)`,
        [id, tenant, project, title, assignee === null ? null : JSON.stringify(assignee), deleted ? new Date() : null],
      );

    const A = (kind: string, refId: string, responsibleId: string) => ({
      kind,
      refId,
      refName: `${kind}:${refId}`,
      responsibleId,
      responsibleName: `resp:${responsibleId}`,
    });

    await task(T.personSelf, tenantA, projA, "Alice owns and is responsible", A("person", alice, alice));
    await task(T.personOther, tenantA, projA, "Alice owns, Bob responsible", A("person", alice, bob));
    await task(T.dept, tenantA, projA, "Engineering dept owns, Carol responsible", A("department", "dept-engineering", carol));
    // Division owner with NO responsible at all — the §3.1 "owner = unit, no responsible" case.
    // Written WITHOUT a responsibleId key on purpose (validAssignee would reject it today, but
    // pre-validation and imported rows exist): person grain must simply exclude it, never invent
    // a person.
    await task(T.division, tenantA, projA, "Frontend division owns, nobody responsible", {
      kind: "division",
      refId: "div-frontend",
      refName: "Frontend",
    });
    await task(T.noAssignee, tenantA, projA, "Unassigned task", null);
    // refId is not a uuid at all (validAssignee only checks it is a non-empty string).
    await task(T.badPersonRef, tenantA, projA, "Person owner with a junk ref", A("person", "user-42", bob));
    // refId is a well-formed uuid that is not a users row -> would be an FK violation if inserted.
    await task(T.ghostPersonRef, tenantA, projA, "Person owner who does not exist", A("person", ghost, ghost));
    await task(T.softDeleted, tenantA, projA, "Soft-deleted but still attributable", A("person", bob, bob), true);
    await task(T.otherTenant, tenantB, projB, "Dave's task in tenant B", A("person", dave, dave));

    // migrate() already ran 0054's backfill — against an EMPTY database (no companies existed yet),
    // so it was a legitimate no-op. Run it now, over the seeded legacy rows.
    await pool.query(backfillSql());
  });

  afterAll(teardownTestDb);

  // ───────────────────────── SHAPE: table, constraints, indexes ─────────────────────────

  it("the table exists with FORCE RLS and a tenant_isolation policy", async () => {
    const { rows } = await adminPool().query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'pm_task_assignees'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].relrowsecurity).toBe(true);
    expect(rows[0].relforcerowsecurity).toBe(true);

    const pol = await adminPool().query<{ polname: string; qual: string }>(
      `SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS qual
         FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        WHERE c.relname = 'pm_task_assignees'`,
    );
    expect(pol.rows.map((r) => r.polname)).toEqual(["tenant_isolation"]);
    // The PLAIN tenant wall off the 0025 helper — NOT the app_module_allowed() third wall, which is
    // reserved for the report_* tables. Pinned so a later edit can't quietly change the wall.
    expect(pol.rows[0].qual).toContain("app_current_tenants()");
    expect(pol.rows[0].qual).not.toContain("app_module_allowed");
  });

  // TR-34 (migration 0063) SUPERSEDES this invariant's mechanism: once owner/responsible rows carry
  // validity intervals (closed historical rows coexist beside the current open one), "at most one
  // row per role, ever" is no longer the right rule — a reassigned task legitimately has more than
  // one owner row, just not more than one OPEN one at a time. 0063 drops these two partial uniques
  // and replaces them with a single EXCLUDE constraint that encodes the correct invariant (no two
  // intervals for the same (tenant, task, role) may overlap in time, which yields "at most one open"
  // as a free corollary — see 0063's header and pm-task-assignee-intervals.test.ts for the full
  // rejection/acceptance proof). This test now pins their ABSENCE plus the replacement's presence.
  it("TR-34 (0063): the one-row-per-role partial uniques are GONE, replaced by the EXCLUDE constraint", async () => {
    const { rows } = await adminPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'pm_task_assignees'
          AND indexname IN ('ux_pm_task_assignees_one_owner', 'ux_pm_task_assignees_one_responsible')`,
    );
    expect(rows).toEqual([]);

    const excl = await adminPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'pm_task_assignees'::regclass AND contype = 'x'`,
    );
    expect(excl.rows.map((r) => r.conname)).toEqual(["pm_task_assignees_no_overlap"]);
  });

  // ───────────────────────── BLOB -> ROWS ROUND-TRIP (§3.1) ─────────────────────────

  it("every seeded assignee blob round-trips to the correct owner/responsible rows", async () => {
    const all = await semanticRows(tenantA);
    expect(all.length, "the backfill must have written rows, not silently no-opped").toBeGreaterThan(0);

    // Case 1 — owner = person, responsible = THE SAME person: one owner row only. The doc's
    // "responsible row when responsibleId differs from a person-owner's ref" rule.
    expect(rowsFor(all, T.personSelf)).toEqual([
      { task_id: T.personSelf, role: "owner", assignee_kind: "person", assignee_ref: alice, user_id: alice, origin_site: "test" },
    ]);

    // Case 2 — owner = person, responsible = someone else: both rows.
    expect(rowsFor(all, T.personOther)).toEqual([
      { task_id: T.personOther, role: "owner", assignee_kind: "person", assignee_ref: alice, user_id: alice, origin_site: "test" },
      { task_id: T.personOther, role: "responsible", assignee_kind: "person", assignee_ref: bob, user_id: bob, origin_site: "test" },
    ]);

    // Case 3 — owner = DEPARTMENT: the owner row carries the org-node id with user_id NULL. NO
    // person is invented for the owner; the responsible person is a SEPARATE row, which is how
    // §3.1's attribution table row 2 credits a person for unit-owned work.
    expect(rowsFor(all, T.dept)).toEqual([
      { task_id: T.dept, role: "owner", assignee_kind: "department", assignee_ref: "dept-engineering", user_id: null, origin_site: "test" },
      { task_id: T.dept, role: "responsible", assignee_kind: "person", assignee_ref: carol, user_id: carol, origin_site: "test" },
    ]);

    // Case 4 — owner = DIVISION with no responsible: exactly ONE row, no person anywhere.
    // §3.1 attribution table row 3: "person grain simply excludes it".
    expect(rowsFor(all, T.division)).toEqual([
      { task_id: T.division, role: "owner", assignee_kind: "division", assignee_ref: "div-frontend", user_id: null, origin_site: "test" },
    ]);
    expect(rowsFor(all, T.division).every((r) => r.user_id === null)).toBe(true);

    // Case 5 — no blob at all: no rows (§3.1 "no assignee" -> unit-grain fallback, resolved at
    // fact time from projects.department_id, never materialised here).
    expect(rowsFor(all, T.noAssignee)).toEqual([]);

    // Case 6 — person refId that is not a uuid: the OWNER is skipped (unrepresentable, never
    // guessed), but the resolvable responsible is still captured. This is the case that would
    // ABORT the whole migration if the doc's DDL were implemented literally.
    expect(rowsFor(all, T.badPersonRef)).toEqual([
      { task_id: T.badPersonRef, role: "responsible", assignee_kind: "person", assignee_ref: bob, user_id: bob, origin_site: "test" },
    ]);

    // Case 7 — uuid-shaped refs that reference no user: nothing at all, and critically NO FK
    // violation (which would have rolled back the entire migration).
    expect(rowsFor(all, T.ghostPersonRef)).toEqual([]);

    // Case 8 — a SOFT-DELETED task still backfills. Deliberate: attribution history for work that
    // was done must survive the task being archived, and a restore must not come back with its
    // assignee rows missing. Reporting filters on pm_tasks.deleted_at at query time.
    expect(rowsFor(all, T.softDeleted)).toEqual([
      { task_id: T.softDeleted, role: "owner", assignee_kind: "person", assignee_ref: bob, user_id: bob, origin_site: "test" },
    ]);

    // origin_site is inherited from the parent task, not hardcoded to the 'central' column default,
    // so a site-originated task's assignee rows carry that site's provenance for the sync engine.
    expect(all.every((r) => r.origin_site === "test")).toBe(true);
  });

  it("the backfill scopes rows to the owning tenant (tenant B's task is not in tenant A)", async () => {
    const b = await semanticRows(tenantB);
    expect(b).toEqual([
      { task_id: T.otherTenant, role: "owner", assignee_kind: "person", assignee_ref: dave, user_id: dave, origin_site: "test" },
    ]);
    const a = await semanticRows(tenantA);
    expect(a.some((r) => r.task_id === T.otherTenant)).toBe(false);
  });

  // ───────────────────────── IDEMPOTENCY (the ticket's highest-risk criterion) ─────────────────────────

  it("running the backfill a SECOND time produces byte-identical rows (true no-op)", async () => {
    const fullSnapshot = async () =>
      (
        await adminPool().query(
          `SELECT id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, created_by,
                  origin_site, created_at, updated_at
             FROM pm_task_assignees ORDER BY tenant_id, task_id, role, assignee_ref`,
        )
      ).rows;

    const before = await fullSnapshot();
    expect(before.length).toBeGreaterThan(0);

    await adminPool().query(backfillSql());
    const afterTwo = await fullSnapshot();
    // Identical INCLUDING ids and timestamps — proves nothing was re-inserted, re-numbered or
    // touched, not merely that the row COUNT happens to match.
    expect(afterTwo).toEqual(before);

    // And a third pass, because "idempotent" must mean idempotent, not "stable on the second run".
    await adminPool().query(backfillSql());
    expect(await fullSnapshot()).toEqual(before);

    // No task ever acquired a second owner or a second responsible across the three passes.
    const dupes = await adminPool().query(
      `SELECT tenant_id, task_id, role, count(*) FROM pm_task_assignees
        WHERE role IN ('owner','responsible')
        GROUP BY tenant_id, task_id, role HAVING count(*) > 1`,
    );
    expect(dupes.rows).toEqual([]);
  });

  // ───────────────────────── THE INVARIANTS, PROVEN BY REJECTION ─────────────────────────

  // TR-34 (0063): the rejection mechanism is now the EXCLUDE constraint (both new rows below
  // default to an OPEN interval starting today, which overlaps the existing open row) — see
  // pm-task-assignee-intervals.test.ts for the full interval-shaped rejection/acceptance matrix.
  it("a second CONCURRENT owner on the same task is rejected (EXCLUDE non-overlap)", async () => {
    // T.dept already has a DEPARTMENT owner (open interval); try to add a PERSON owner with no
    // stated interval (defaults to open-starting-today, which overlaps). ux_pm_task_assignees_row
    // would happily allow this (different assignee_kind/ref) — only the EXCLUDE constraint stops it.
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
           VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test')`,
          [tenantA, T.dept, alice],
        ),
      ),
    ).rejects.toThrow(/pm_task_assignees_no_overlap/);
  });

  it("a second CONCURRENT responsible on the same task is rejected (EXCLUDE non-overlap)", async () => {
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
           VALUES ($1, $2, 'responsible', 'person', $3::text, $3::uuid, 'test')`,
          [tenantA, T.dept, alice],
        ),
      ),
    ).rejects.toThrow(/pm_task_assignees_no_overlap/);
  });

  it("multiple CONTRIBUTORS on one task are allowed (the new capability), but not the same one twice", async () => {
    const add = (userId: string) =>
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
           VALUES ($1, $2, 'contributor', 'person', $3::text, $3::uuid, 'test')`,
          [tenantA, T.personSelf, userId],
        ),
      );
    await add(bob);
    await add(carol);
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM pm_task_assignees WHERE task_id = $1 AND role = 'contributor'`,
      [T.personSelf],
    );
    expect(Number(rows[0].n)).toBe(2);
    await expect(add(bob)).rejects.toThrow(/ux_pm_task_assignees_row/);
    // Clean up so the idempotency snapshot above stays the authority on backfill output.
    await adminPool().query(`DELETE FROM pm_task_assignees WHERE role = 'contributor'`);
  });

  it("the row-shape CHECKs reject every malformed combination", async () => {
    // Run as superuser so RLS cannot be mistaken for the constraint doing the work. T.noAssignee
    // has no backfilled rows, so it is a free slate.
    const ins = (cols: string, vals: unknown[]) =>
      adminPool().query(
        `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
         VALUES ${cols}`,
        vals,
      );

    // person kind without a resolved user
    await expect(
      ins(`($1, $2, 'owner', 'person', 'somebody', NULL, 'test')`, [tenantA, T.noAssignee]),
    ).rejects.toThrow(/pm_task_assignees_person_user/);

    // unit kind WITH a user (the mirror half of the same CHECK)
    await expect(
      ins(`($1, $2, 'owner', 'department', 'dept-x', $3, 'test')`, [tenantA, T.noAssignee, alice]),
    ).rejects.toThrow(/pm_task_assignees_person_user/);

    // responsible must be a person, never a unit
    await expect(
      ins(`($1, $2, 'responsible', 'department', 'dept-x', NULL, 'test')`, [tenantA, T.noAssignee]),
    ).rejects.toThrow(/pm_task_assignees_person_role/);

    // contributor must be a person, never a unit
    await expect(
      ins(`($1, $2, 'contributor', 'division', 'div-x', NULL, 'test')`, [tenantA, T.noAssignee]),
    ).rejects.toThrow(/pm_task_assignees_person_role/);

    // a person row whose assignee_ref disagrees with its user_id (the dual-representation drift
    // this table exists to eliminate)
    await expect(
      ins(`($1, $2, 'owner', 'person', $3, $4, 'test')`, [tenantA, T.noAssignee, bob, alice]),
    ).rejects.toThrow(/pm_task_assignees_ref_matches_user/);

    // empty unit ref
    await expect(
      ins(`($1, $2, 'owner', 'department', '', NULL, 'test')`, [tenantA, T.noAssignee]),
    ).rejects.toThrow(/pm_task_assignees_ref_nonempty/);

    // unknown role / unknown kind
    await expect(
      ins(`($1, $2, 'reviewer', 'person', $3::text, $3::uuid, 'test')`, [tenantA, T.noAssignee, alice]),
    ).rejects.toThrow(/role/);
    await expect(
      ins(`($1, $2, 'owner', 'team', 'team-x', NULL, 'test')`, [tenantA, T.noAssignee]),
    ).rejects.toThrow(/assignee_kind/);

    // nothing above leaked a row through
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM pm_task_assignees WHERE task_id = $1`,
      [T.noAssignee],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("SECURITY: an assignee row cannot point at a task in another tenant (composite FK guard)", async () => {
    // The doc's DDL declared `task_id uuid REFERENCES pm_tasks(id)` — existence only. FK checks
    // bypass row security on the referenced table, so that form would ACCEPT this row and no
    // RLS-scoped SELECT could ever surface it. The composite FK (task_id, tenant_id) ->
    // pm_tasks(id, tenant_id) makes the database itself refuse, from any session.
    await expect(
      adminPool().query(
        `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
         VALUES ($1, $2, 'contributor', 'person', $3::text, $3::uuid, 'test')`,
        [tenantA, T.otherTenant, alice],
      ),
    ).rejects.toThrow(/fk_pm_task_assignees_task_tenant/);
  });

  // ───────────────────────── RLS BEHAVIOUR ─────────────────────────

  it("RLS isolates the new table by the authorized-tenant-set, and fails closed with no context", async () => {
    const a = await withTenants([tenantA], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pm_task_assignees`),
    );
    const both = await withTenants([tenantA, tenantB], (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pm_task_assignees`),
    );
    expect(a.rows[0].n).toBeGreaterThan(0);
    expect(both.rows[0].n).toBeGreaterThan(a.rows[0].n); // tenant B's row becomes visible

    // No tenant context -> zero rows, never an error and never a leak.
    const none = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pm_task_assignees`);
    expect(none.rows[0].n).toBe(0);

    // WITH CHECK: cannot write into a tenant outside the authorized set.
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
           VALUES ($1, $2, 'contributor', 'person', $3::text, $3::uuid, 'test')`,
          [tenantB, T.otherTenant, dave],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  // ─────────────── THE ONE THAT MATTERS: the backfill under a NOBYPASSRLS role ───────────────
  // Everything above ran the backfill through adminPool() — the SUPERUSER test connection, which
  // BYPASSES RLS. That is exactly the blind spot that let 0050_pm_short_codes.sql ship a backfill
  // that silently touched zero rows in production: migrations run as platform_owner, which is
  // NOBYPASSRLS, and pm_tasks is FORCE-RLS'd, so with no app.current_tenant_ids GUC the source
  // SELECT sees nothing, the INSERT...SELECT writes nothing, no error is raised, and the ledger
  // records success.
  //
  // This test reproduces production privilege exactly: it wipes the table and re-runs the SAME
  // backfill block through the app's NOSUPERUSER NOBYPASSRLS pool with NO ambient tenant context,
  // then asserts a NON-ZERO row count and semantic equality with the superuser run. If the
  // migration's per-tenant set_config wrapper were ever removed, THIS is the assertion that fails.
  it("the backfill writes rows as a NOBYPASSRLS role with NO ambient tenant context", async () => {
    const expected = [...(await semanticRows(tenantA)), ...(await semanticRows(tenantB))];
    expect(expected.length).toBeGreaterThan(0);

    await adminPool().query(`DELETE FROM pm_task_assignees`);
    const emptied = await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pm_task_assignees`);
    expect(emptied.rows[0].n).toBe(0);

    // getPool() is the platform_app_test role (NOSUPERUSER NOBYPASSRLS, see testing/setup.ts) and
    // this query sets NO tenant GUC — the migration's own per-tenant set_config is the only reason
    // any row can be read or written here.
    await getPool().query(backfillSql());

    const total = await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM pm_task_assignees`);
    expect(total.rows[0].n, "backfill silently no-opped under NOBYPASSRLS — the 0050 bug class").toBeGreaterThan(0);
    expect(total.rows[0].n).toBe(expected.length);

    // Not merely non-zero: the SAME rows the privileged run produced.
    const actual = [...(await semanticRows(tenantA)), ...(await semanticRows(tenantB))];
    expect(actual).toEqual(expected);

    // ...and still idempotent under this privilege model too.
    await getPool().query(backfillSql());
    expect([...(await semanticRows(tenantA)), ...(await semanticRows(tenantB))]).toEqual(expected);
  });
});
