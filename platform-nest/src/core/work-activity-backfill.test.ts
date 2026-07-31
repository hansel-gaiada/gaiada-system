// WSUX-15 — the one-shot `activities` -> `work_activity` backfill against LIVE PG. Covers: historical
// rows land correctly per entity type, tenant isolation across companies, and idempotency (a rerun
// inserts nothing new and reports 0).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "../db";
import { writeActivity } from "./http";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createProject, createUser, addMembership } from "../testing/fixtures";
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

async function createPmDoc(tenantId: string, projectId: string, title: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO pm_docs (id, tenant_id, project_id, title, body, origin_site) VALUES ($1, $2, $3, $4, '', 'central')`, [
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
  let docId: string;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Backfill Co");
    other = await createCompany("Backfill Rival Co");
    projectId = await createProject(co, "Legacy Rebrand");
    taskId = await createPmTask(co, projectId, "Draft old moodboard");
    docId = await createPmDoc(co, projectId, "Legacy Brief");

    // Pre-existing history: writeActivity rows exactly as pm.controller.ts's createTask/patchTask
    // already produce them (metadata carries a title only on the "created" verb, matching the real
    // controller's own writeActivity call shape).
    await writeActivity(co, null, "created", "pm_task", taskId, { title: "Draft old moodboard" });
    await writeActivity(co, null, "updated", "pm_task", taskId, {});
    await writeActivity(co, null, "updated", "pm_project", projectId, {});
    // TR-05: pm_doc backfill — matches pm.controller.ts's createDoc's own writeActivity(..., "pm_doc",
    // id, {title}) call shape (title carried on metadata, same as pm_task's "created" verb above).
    await writeActivity(co, null, "created", "pm_doc", docId, { title: "Legacy Brief" });
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
    expect(result.inserted).toBeGreaterThanOrEqual(4);

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

    const docRow = await adminPool().query(
      `SELECT source, object_kind, title, payload FROM work_activity WHERE tenant_id = $1 AND object_ref = $2`,
      [co, docId],
    );
    expect(docRow.rows[0]).toMatchObject({ source: "pm", object_kind: "doc", title: "Legacy Brief" });
    expect(docRow.rows[0].payload).toMatchObject({ docId, projectId });
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

  it("TR-33: backfilled activity with a known actor creates an exact person link", async () => {
    // Create a user and add them to the company
    const userId = await createUser("alice@example.com", "Alice");
    await addMembership(co, userId);

    // Create an activity WITH an actor (non-null actor_id)
    const taskId2 = await createPmTask(co, projectId, "Task with actor");
    await writeActivity(co, userId, "created", "pm_task", taskId2, { title: "Task with actor" });

    // Backfill again (should pick up the new activity)
    const result = await runWorkActivityBackfill();
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    // Verify the work_activity row exists with the correct actor_user_id
    const waRow = await adminPool().query(
      `SELECT id, actor_user_id FROM work_activity WHERE tenant_id = $1 AND object_ref = $2 AND verb = 'created'`,
      [co, taskId2],
    );
    expect(waRow.rows).toHaveLength(1);
    expect(waRow.rows[0].actor_user_id).toBe(userId);

    // Verify the work_activity_links row: target_kind='person', confidence='exact', rule='hint:actorId'
    const linkRow = await adminPool().query(
      `SELECT target_kind, target_id, confidence, rule FROM work_activity_links
       WHERE activity_id = $1 AND target_kind = 'person'`,
      [waRow.rows[0].id],
    );
    expect(linkRow.rows).toHaveLength(1);
    expect(linkRow.rows[0]).toMatchObject({
      target_kind: "person",
      target_id: userId,
      confidence: "exact",
      rule: "hint:actorId",
    });
  });

  it("TR-33: backfilled activity with NULL actor creates no person link", async () => {
    // Create an activity WITHOUT an actor (actor_id is null)
    const taskId3 = await createPmTask(co, projectId, "System task");
    await writeActivity(co, null, "created", "pm_task", taskId3, { title: "System task" });

    // Backfill again
    const result = await runWorkActivityBackfill();
    expect(result.inserted).toBeGreaterThanOrEqual(1);

    // Verify the work_activity row exists with null actor_user_id
    const waRow = await adminPool().query(
      `SELECT id, actor_user_id FROM work_activity WHERE tenant_id = $1 AND object_ref = $2 AND verb = 'created'`,
      [co, taskId3],
    );
    expect(waRow.rows).toHaveLength(1);
    expect(waRow.rows[0].actor_user_id).toBeNull();

    // Verify NO person link was created
    const linkRow = await adminPool().query(
      `SELECT 1 FROM work_activity_links
       WHERE activity_id = $1 AND target_kind = 'person'`,
      [waRow.rows[0].id],
    );
    expect(linkRow.rows).toHaveLength(0);
  });
});
