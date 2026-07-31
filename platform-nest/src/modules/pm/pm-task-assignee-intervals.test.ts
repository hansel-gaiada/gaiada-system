// TR-34 — pm_task_assignees validity intervals (migration 0063), the ownership-axis counterpart to
// org_unit_memberships (0055)'s unit-axis history-rewrite fix. Against live Postgres + real RLS,
// same harness style as pm-task-assignees.test.ts (0054) and org-unit-memberships.test.ts (0055).
//
// Weighted toward the same two things those two files were weighted toward, per the ticket's
// standing rulings:
//   * the EXCLUDE non-overlap constraint (pm_task_assignees_no_overlap) is proven by test: an
//     overlapping OPEN owner interval for the same task is REJECTED; adjacent (transfer-shaped)
//     non-overlapping intervals are ALLOWED; an owner interval and a responsible interval covering
//     the identical dates on the SAME task do NOT compete (role is part of the equality key).
//   * the interval backfill dates owner/responsible rows from the TASK's own creation and
//     contributor rows from their OWN row's creation (0063's design judgement), and does so under a
//     NOBYPASSRLS role with NO ambient tenant context (ruling 1 — the 0050_pm_short_codes.sql bug
//     class this whole program keeps re-testing for).
//
// Every backfill assertion re-runs the MIGRATION FILE'S OWN SQL, parsed straight out of
// 0063_pm_task_assignee_intervals.sql — never a re-implementation that could drift from what shipped.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, getPool } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../../migrations/0063_pm_task_assignee_intervals.sql");

/** The migration's backfill DO block, extracted verbatim. Unlike 0054/0055, this file has exactly
 *  ONE DO block (no fresh CREATE POLICY here — RLS was already enabled on this table by 0054). */
function backfillSql(): string {
  const sql = readFileSync(MIGRATION, "utf8");
  const blocks = sql.match(/DO \$\$[\s\S]*?END \$\$;/g);
  expect(blocks?.length, "0063 should have exactly 1 DO block (the interval backfill)").toBe(1);
  const backfill = blocks![0];
  expect(backfill, "backfill must wrap per-tenant GUC (the 0051 lesson)").toMatch(
    /set_config\s*\(\s*'app\.current_tenant_ids'/,
  );
  return backfill;
}

describe.skipIf(!TEST_URL)("pm_task_assignees validity intervals (TR-34 / migration 0063)", () => {
  let tenant: string;
  let alice: string;
  let bob: string;
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("Tracker Interval Co", ["agency", "pm"]);
    alice = await createUser("alice-tr34@a.test", "Alice Owner");
    bob = await createUser("bob-tr34@a.test", "Bob Responsible");
    await addMembership(tenant, alice);
    await addMembership(tenant, bob);

    const pool = adminPool();
    projectId = "00000000-0000-7000-9000-0000000000c1";
    await pool.query(`INSERT INTO projects (id, tenant_id, name, origin_site) VALUES ($1, $2, 'Interval Project', 'test')`, [
      projectId,
      tenant,
    ]);
  });

  afterAll(teardownTestDb);

  // ───────────────────────── SHAPE ─────────────────────────

  it("valid_from/valid_to columns and the valid_range CHECK exist", async () => {
    const cols = await adminPool().query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'pm_task_assignees' AND column_name IN ('valid_from', 'valid_to')`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r.is_nullable]));
    expect(byName.valid_from).toBe("NO");
    expect(byName.valid_to).toBe("YES");

    const check = await adminPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'pm_task_assignees'::regclass AND conname = 'pm_task_assignees_valid_range'`,
    );
    expect(check.rows).toHaveLength(1);
  });

  it("the OLD one-row-per-role partial uniques are GONE, replaced by ONE EXCLUDE constraint", async () => {
    const idx = await adminPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'pm_task_assignees'
        AND indexname IN ('ux_pm_task_assignees_one_owner', 'ux_pm_task_assignees_one_responsible')`,
    );
    expect(idx.rows).toEqual([]);

    const excl = await adminPool().query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'pm_task_assignees'::regclass AND contype = 'x'`,
    );
    expect(excl.rows.map((r) => r.conname)).toEqual(["pm_task_assignees_no_overlap"]);
  });

  it("ux_pm_task_assignees_row was widened to include valid_from", async () => {
    const { rows } = await adminPool().query<{ pg_get_constraintdef: string }>(
      `SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'pm_task_assignees'::regclass AND conname = 'ux_pm_task_assignees_row'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pg_get_constraintdef).toContain("valid_from");
  });

  // ───────────────────────── BACKFILL: owner/responsible from TASK creation, contributor from OWN ─────────────────────────

  it("the backfill dates owner/responsible rows from the TASK's creation and contributor rows from their OWN row's creation", async () => {
    const pool = adminPool();
    const taskId = "00000000-0000-7000-9000-0000000000c2";
    // Task "created" long ago — the date owner/responsible rows must backfill to.
    await pool.query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, assignee, origin_site, created_at)
       VALUES ($1, $2, $3, 'Interval task', $4, 'test', '2020-05-15T00:00:00Z')`,
      [taskId, tenant, projectId, JSON.stringify({ kind: "person", refId: alice, refName: "Alice", responsibleId: bob, responsibleName: "Bob" })],
    );
    // Seed owner/responsible rows directly with a deliberately WRONG valid_from (garbage), exactly
    // as a pre-0063 row would look before this migration's backfill corrects it.
    await pool.query(
      `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
       VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '1999-01-01', NULL)`,
      [tenant, taskId, alice],
    );
    await pool.query(
      `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
       VALUES ($1, $2, 'responsible', 'person', $3::text, $3::uuid, 'test', '1999-01-01', NULL)`,
      [tenant, taskId, bob],
    );
    // Contributor row: its OWN created_at is what the backfill should use — deliberately DIFFERENT
    // from both the task's creation date and the garbage valid_from below.
    await pool.query(
      `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to, created_at)
       VALUES ($1, $2, 'contributor', 'person', $3::text, $3::uuid, 'test', '1999-01-01', NULL, '2021-03-01T00:00:00Z')`,
      [tenant, taskId, bob],
    );

    await pool.query(backfillSql());

    const { rows } = await pool.query<{ role: string; valid_from: string }>(
      `SELECT role, valid_from::text FROM pm_task_assignees WHERE tenant_id = $1 AND task_id = $2 ORDER BY role`,
      [tenant, taskId],
    );
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.valid_from]));
    expect(byRole.owner).toBe("2020-05-15");
    expect(byRole.responsible).toBe("2020-05-15");
    expect(byRole.contributor).toBe("2021-03-01");
  });

  it("running the backfill a SECOND time is a true no-op", async () => {
    const before = (
      await adminPool().query(
        `SELECT id, valid_from, valid_to FROM pm_task_assignees ORDER BY id`,
      )
    ).rows;
    await adminPool().query(backfillSql());
    const after = (
      await adminPool().query(`SELECT id, valid_from, valid_to FROM pm_task_assignees ORDER BY id`)
    ).rows;
    expect(after).toEqual(before);
  });

  // ─────────── THE ONE THAT MATTERS: the backfill under a NOBYPASSRLS role ───────────
  it("the backfill writes under a NOBYPASSRLS role with NO ambient tenant context", async () => {
    // Corrupt valid_from back to garbage as the SUPERUSER connection (bypasses RLS, just resetting
    // fixture state), then re-run the backfill through getPool() — platform_app_test, NOSUPERUSER
    // NOBYPASSRLS, with NO tenant GUC set. If the migration's per-tenant set_config wrapper were
    // ever removed, this is the assertion that would fail (silently zero rows touched, 0050 class).
    await adminPool().query(
      `UPDATE pm_task_assignees SET valid_from = '1999-01-01' WHERE tenant_id = $1 AND role IN ('owner', 'responsible')`,
      [tenant],
    );
    await getPool().query(backfillSql());

    const { rows } = await adminPool().query<{ role: string; valid_from: string }>(
      `SELECT role, valid_from::text FROM pm_task_assignees
        WHERE tenant_id = $1 AND role IN ('owner', 'responsible') ORDER BY role`,
      [tenant],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.valid_from, "backfill silently no-opped under NOBYPASSRLS — the 0050 bug class").not.toBe("1999-01-01");
      expect(r.valid_from).toBe("2020-05-15");
    }
  });

  // ───────────────────────── THE EXCLUDE CONSTRAINT, PROVEN BY REJECTION/ACCEPTANCE ─────────────

  it("an overlapping OPEN owner interval on the SAME task is REJECTED", async () => {
    const taskId = "00000000-0000-7000-9000-0000000000c3";
    await adminPool().query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'Overlap task', 'test')`,
      [taskId, tenant, projectId],
    );
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
         VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-01-01', NULL)`,
        [tenant, taskId, alice],
      ),
    );
    await expect(
      withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
           VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-03-01', NULL)`,
          [tenant, taskId, bob],
        ),
      ),
    ).rejects.toThrow(/pm_task_assignees_no_overlap/);
  });

  it("ADJACENT non-overlapping owner intervals are ALLOWED (a clean reassignment)", async () => {
    const taskId = "00000000-0000-7000-9000-0000000000c4";
    await adminPool().query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'Transfer task', 'test')`,
      [taskId, tenant, projectId],
    );
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
         VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-01-01', '2026-03-15')`,
        [tenant, taskId, alice],
      ),
    );
    await expect(
      withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
           VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-03-16', NULL)`,
          [tenant, taskId, bob],
        ),
      ),
    ).resolves.toBeDefined();
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM pm_task_assignees WHERE tenant_id = $1 AND task_id = $2 AND role = 'owner'`,
      [tenant, taskId],
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it("an owner interval and a responsible interval covering the SAME dates on the SAME task do not conflict", async () => {
    const taskId = "00000000-0000-7000-9000-0000000000c5";
    await adminPool().query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'Dual-role task', 'test')`,
      [taskId, tenant, projectId],
    );
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
         VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-01-01', NULL)`,
        [tenant, taskId, alice],
      ),
    );
    await expect(
      withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
           VALUES ($1, $2, 'responsible', 'person', $3::text, $3::uuid, 'test', '2026-01-01', NULL)`,
          [tenant, taskId, bob],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("a round-trip reassignment (A owns -> B owns -> A owns again) is allowed by the widened UNIQUE key", async () => {
    const taskId = "00000000-0000-7000-9000-0000000000c6";
    await adminPool().query(
      `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, 'Round-trip task', 'test')`,
      [taskId, tenant, projectId],
    );
    // Alice's FIRST (now closed) stint.
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
         VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-01-01', '2026-02-28')`,
        [tenant, taskId, alice],
      ),
    );
    // Bob's stint in between.
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
         VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-03-01', '2026-05-31')`,
        [tenant, taskId, bob],
      ),
    );
    // Alice's SECOND stint — same (tenant, task, role, kind, ref) as her first row, but a DIFFERENT
    // valid_from. The OLD ux_pm_task_assignees_row (without valid_from) would have rejected this.
    await expect(
      withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO pm_task_assignees (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
           VALUES ($1, $2, 'owner', 'person', $3::text, $3::uuid, 'test', '2026-06-01', NULL)`,
          [tenant, taskId, alice],
        ),
      ),
    ).resolves.toBeDefined();
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*) AS n FROM pm_task_assignees WHERE tenant_id = $1 AND task_id = $2 AND role = 'owner' AND assignee_ref = $3`,
      [tenant, taskId, alice],
    );
    expect(Number(rows[0].n)).toBe(2); // Alice's two, non-contiguous stints
  });
});
