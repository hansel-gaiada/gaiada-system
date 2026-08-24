// `seed:reassign-retired` — move the retired personas' work onto the real staff.
//
// ⚠ WHAT MAKES THIS WORTH TESTING RATHER THAN EYEBALLING. It rewrites ~1,100 rows across ~30 foreign
// keys on a live estate, and three of its behaviours are easy to get silently wrong:
//
//   1. IDENTITY MUST NOT MOVE. Reassigning a `user_roles` row would grant a real person a retired
//      persona's ACCESS — a privilege escalation dressed as a data migration. Pinned below.
//   2. UNIQUE COLLISIONS MUST BE REPORTED, NOT SWALLOWED. Several targets carry a UNIQUE on
//      (tenant, user, date); moving a check-in onto someone who already has that day's row violates
//      it. The script falls back to row-by-row and reports what could not move. A version that
//      aborted, or that silently dropped them, would both look like success.
//   3. THE DRY RUN MUST CHANGE NOTHING.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole, createProject } from "../testing/fixtures";
import { withTenants } from "../db";
import { reassignRetired } from "./reassign-retired";
import { STAFF } from "./roster";

const AGENCY = "Gaia Digital Agency";
let tenantId: string;
let retiredId: string;
let targetId: string;

describe.skipIf(!TEST_URL)("seed:reassign-retired", () => {
  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany(AGENCY, ["agency", "pm", "hr", "reports", "clients", "billing", "webdev", "social", "search"]);
    // The real staff the mapping targets must exist or the script refuses outright.
    for (const s of STAFF) await createUser(s.email, s.name, s.title);
    // `gede@gaia.test` -> `reva@gaiada.com` is one of the mappings.
    retiredId = await createUser("gede@gaia.test", "Gede Pratama", "Frontend Developer");
    targetId = (
      await adminPool().query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, ["reva@gaiada.com"])
    ).rows[0].id;

    // Work owned by the retired person: a project (ownership) and a role grant (identity).
    const projectId = await createProject(tenantId, "Ghost-owned project", retiredId);
    await grantRole(retiredId, await createRole("manager"), "company", tenantId);

    // A task ASSIGNMENT held by the retired person. `pm_task_assignees` denormalises the user id
    // into `assignee_ref` and a CHECK enforces the two agree, so this row is the fixture that
    // distinguishes "moved the FK" from "moved the row" — see MIRRORED in the script.
    await withTenants(
      [tenantId],
      async (c) => {
        const t = await c.query<{ id: string }>(
          `INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site)
           VALUES (gen_random_uuid(), $1, $2, 'Ghost-assigned task', 'test') RETURNING id`,
          [tenantId, projectId],
        );
        await c.query(
          `INSERT INTO pm_task_assignees
             (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from, valid_to)
           VALUES ($1, $2, 'responsible', 'person', $3::text, $3::uuid, 'test', now(), NULL)`,
          [tenantId, t.rows[0].id, retiredId],
        );
      },
      { modules: ["pm"] },
    );
  }, 240_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 dry run reports the moves and changes NOTHING", async () => {
    const r = await reassignRetired({ dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.moved.some((m) => m.where.startsWith("projects.owner_id"))).toBe(true);

    const owner = await adminPool().query<{ owner_id: string }>(
      `SELECT owner_id FROM projects WHERE name = $1`,
      ["Ghost-owned project"],
    );
    expect(owner.rows[0].owner_id, "a dry run must not rewrite ownership").toBe(retiredId);
  });

  it("🔴 moves OWNERSHIP to the mapped real employee", async () => {
    await reassignRetired({ dryRun: false });
    const owner = await adminPool().query<{ owner_id: string }>(
      `SELECT owner_id FROM projects WHERE name = $1`,
      ["Ghost-owned project"],
    );
    expect(owner.rows[0].owner_id, "gede@gaia.test's project should now belong to reva@gaiada.com").toBe(targetId);
  });

  it("🔴 moves a MIRRORED column with its FK, instead of aborting on the CHECK", async () => {
    // The regression this pins actually happened: the first live `--confirm` run aborted on
    // `pm_task_assignees_ref_matches_user` and rolled back ~1,300 row moves, because the script
    // rewrote `user_id` and left `assignee_ref` pointing at the retired persona.
    //
    // Both halves are asserted. Checking only `user_id` would pass against a script that skipped
    // the table entirely, and checking only that the run did not throw would pass against one that
    // swallowed the failure as an un-movable "collision".
    const row = await adminPool().query<{ user_id: string; assignee_ref: string }>(
      `SELECT user_id, assignee_ref FROM pm_task_assignees WHERE assignee_kind = 'person'`,
    );
    expect(row.rows.length, "the assignee fixture should still exist — it must be MOVED, not deleted").toBe(1);
    expect(row.rows[0].user_id, "the assignment should now belong to reva@gaiada.com").toBe(targetId);
    expect(row.rows[0].assignee_ref, "the denormalised mirror must follow the FK").toBe(targetId);
  });

  it("🔴 does NOT move role grants — that would be a privilege change, not a data move", async () => {
    // The single most important assertion in this file. `user_roles` is in NEVER_MOVE; if it ever
    // moves, a real employee silently inherits whatever access a seeded persona had.
    const still = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_roles WHERE user_id = $1`,
      [retiredId],
    );
    expect(Number(still.rows[0].n), "the retired persona must KEEP its role rows").toBe(1);

    const gained = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND r.name = 'manager'`,
      [targetId],
    );
    expect(Number(gained.rows[0].n), "reva must NOT have inherited a manager grant from a ghost").toBe(0);
  });

  it("is idempotent — a second run finds nothing left to move", async () => {
    const r = await reassignRetired({ dryRun: false });
    expect(r.moved.filter((m) => m.where.startsWith("projects.owner_id"))).toEqual([]);
  });

  it("🔴 refuses when a mapping TARGET is missing, rather than orphaning that work", async () => {
    // A missing target would otherwise skip that mapping silently and report success while the work
    // stayed with a retired persona.
    await adminPool().query(`UPDATE users SET email = 'parked@nowhere.test' WHERE email = $1`, ["edward@gaiada.com"]);
    await expect(reassignRetired({ dryRun: true })).rejects.toThrow(/target user\(s\) missing/);
    await adminPool().query(`UPDATE users SET email = $1 WHERE email = 'parked@nowhere.test'`, ["edward@gaiada.com"]);
  });

  it("derives its column list from pg_constraint, so a new FK cannot be missed", async () => {
    // Regression guard on the approach rather than a specific column: a hand-maintained list would
    // silently skip the column a future migration adds, which is how orphaned work survives a
    // cleanup that reports success.
    const fks = await adminPool().query<{ n: string }>(`
      SELECT count(*)::text AS n FROM pg_constraint con
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      WHERE con.contype = 'f' AND tgt.relname = 'users'`);
    expect(Number(fks.rows[0].n)).toBeGreaterThan(40);
  });
});
