// WSUX-15 — the one-shot `activities` -> `work_activity` backfill against LIVE PG. Covers: historical
// rows land correctly per entity type, tenant isolation across companies, and idempotency (a rerun
// inserts nothing new and reports 0).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "../db";
import { writeActivity } from "./http";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createProject } from "../testing/fixtures";
import { runWorkActivityBackfill } from "./work-activity-backfill";

async function createPmTask(tenantId: string, projectId: string, title: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, $4, 'central')`, [
      id, tenantId, projectId, title,
    ]),
  );
  return id;
}

describe.skipIf(!TEST_URL)("work-activity backfill from `activities` (WSUX-15)", () => {
  let co: string;
  let other: string;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Backfill Co");
    other = await createCompany("Backfill Rival Co");
    projectId = await createProject(co, "Legacy Rebrand");
    taskId = await createPmTask(co, projectId, "Draft old moodboard");

    // Pre-existing history: writeActivity rows exactly as pm.controller.ts's createTask/patchTask
    // already produce them (metadata carries a title only on the "created" verb, matching the real
    // controller's own writeActivity call shape).
    await writeActivity(co, null, "created", "pm_task", taskId, { title: "Draft old moodboard" });
    await writeActivity(co, null, "updated", "pm_task", taskId, {});
    await writeActivity(co, null, "updated", "pm_project", projectId, {});
    // A row on the OTHER tenant must never leak into `co`'s backfilled set.
    const rivalProjectId = await createProject(other, "Rival Legacy Project");
    await writeActivity(other, null, "updated", "pm_project", rivalProjectId, {});
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("backfills historical pm_task/pm_project activities rows into work_activity, per tenant", async () => {
    const result = await runWorkActivityBackfill();
    expect(result.tenants).toBeGreaterThanOrEqual(2);
    expect(result.inserted).toBeGreaterThanOrEqual(3);

    const taskRows = await adminPool().query(
      `SELECT tenant_id, source, verb, object_kind, title FROM work_activity WHERE tenant_id = $1 AND object_ref = $2 ORDER BY created_at`,
      [co, taskId],
    );
    // Two `activities` rows on this task (created, updated) -> two distinct work_activity rows,
    // each keyed on its OWN activities.id, so they do not collide.
    expect(taskRows.rows).toHaveLength(2);
    expect(taskRows.rows.every((r: { tenant_id: string; source: string }) => r.tenant_id === co && r.source === "pm")).toBe(true);
    expect(taskRows.rows[0].title).toBe("Draft old moodboard");

    const projectRow = await adminPool().query(
      `SELECT source, object_kind, title FROM work_activity WHERE tenant_id = $1 AND object_ref = $2`,
      [co, projectId],
    );
    // No metadata.title on the "updated" verb -> the fallback DB lookup fills in the project's name.
    expect(projectRow.rows[0]).toMatchObject({ source: "pm", object_kind: "project", title: "Legacy Rebrand" });
  });

  it("a rerun is idempotent: reports 0 new inserts and creates no duplicate rows", async () => {
    const before = await adminPool().query(`SELECT count(*)::int AS n FROM work_activity WHERE tenant_id = $1`, [co]);
    const result = await runWorkActivityBackfill();
    expect(result.inserted).toBe(0);
    const after = await adminPool().query(`SELECT count(*)::int AS n FROM work_activity WHERE tenant_id = $1`, [co]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("tenant isolation: the rival company's backfilled row is scoped to its own tenant, not `co`", async () => {
    const rivalRows = await adminPool().query(
      `SELECT tenant_id, title FROM work_activity WHERE title = 'Rival Legacy Project'`,
    );
    expect(rivalRows.rows).toHaveLength(1);
    expect(rivalRows.rows[0].tenant_id).toBe(other);

    const leaked = await adminPool().query(
      `SELECT 1 FROM work_activity WHERE tenant_id = $1 AND title = 'Rival Legacy Project'`,
      [co],
    );
    expect(leaked.rows).toHaveLength(0);
  });
});
