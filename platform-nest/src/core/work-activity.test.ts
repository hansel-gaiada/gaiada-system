// P1-04 — work-activity ingest/read API against live PG + RLS + Cerbos. Covers: idempotent
// ingest on (tenant,source,sourceRef), auto-linking (structured hint -> project -> department
// derivation), member-level read with deptId/projectId filters, admin-only ingest, tenant
// isolation. The outbox CONSUMER + backfill (P1-05) are out of scope — this only proves the
// synchronous ingest/read surface + the linker's DB-boundary wiring.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";
import { newId, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function createPmTask(tenantId: string, projectId: string, title: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, origin_site) VALUES ($1, $2, $3, $4, 'central')`, [
      id, tenantId, projectId, title,
    ]),
  );
  return id;
}

async function setDepartment(tenantId: string, projectId: string, departmentId: string): Promise<void> {
  await withTenants([tenantId], (c) => c.query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [projectId, departmentId]));
}

describe.skipIf(!TEST_URL)("work-activity ingest/read API (P1-04)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let member: string;
  let admin: string;
  let otherAdmin: string;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    member = await createUser("member@work-activity.test");
    admin = await createUser("admin@work-activity.test");
    otherAdmin = await createUser("admin@rival-work-activity.test");
    await addMembership(co, member);
    await addMembership(co, admin);
    await addMembership(other, otherAdmin);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(otherAdmin, await createRole("company_admin"), "company", other);
    projectId = await createProject(co, "Rebrand");
    await setDepartment(co, projectId, "d-creative");
    taskId = await createPmTask(co, projectId, "Draft moodboard");
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("a non-admin member cannot ingest (403)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/work-activity`,
      headers: asUser(member),
      payload: { source: "pm", sourceRef: "denied-1", verb: "created", objectKind: "task", objectRef: "x" },
    });
    expect(r.statusCode).toBe(403);
  });

  it("rejects a missing/invalid body (400)", async () => {
    expect((await app.inject({ method: "POST", url: `/api/${co}/work-activity`, headers: asUser(admin), payload: { source: "carrier-pigeon", sourceRef: "r", verb: "v", objectKind: "k", objectRef: "o" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/${co}/work-activity`, headers: asUser(admin), payload: { source: "pm", verb: "v", objectKind: "k", objectRef: "o" } })).statusCode).toBe(400);
  });

  let activityId: string;

  it("admin ingests an activity; structured taskId hint derives project + department links", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/work-activity`,
      headers: asUser(admin),
      payload: {
        source: "pm", sourceRef: "pm-task-done-1", verb: "completed", objectKind: "task", objectRef: taskId,
        title: "Draft moodboard", payload: { taskId },
      },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    activityId = body.id;
    expect(body.deduped).toBe(false);
    const kinds = body.links.map((l: { targetKind: string; targetId: string; confidence: string }) => `${l.targetKind}:${l.targetId}:${l.confidence}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        `pm_task:${taskId}:exact`,
        `project:${projectId}:inferred`,
        `department:d-creative:inferred`,
      ]),
    );
  });

  it("emitted work_activity.created to the outbox exactly once", async () => {
    const rows = await adminPool().query(`SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'work_activity.created'`, [activityId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("re-ingesting the same (source,sourceRef) is idempotent: dedupes, no new event, no duplicate links", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/work-activity`,
      headers: asUser(admin),
      payload: { source: "pm", sourceRef: "pm-task-done-1", verb: "completed", objectKind: "task", objectRef: taskId, payload: { taskId } },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ id: activityId, deduped: true });

    const events = await adminPool().query(`SELECT count(*)::int AS n FROM outbox_events WHERE entity_id = $1 AND event_type = 'work_activity.created'`, [activityId]);
    expect(events.rows[0].n).toBe(1);
    const links = await adminPool().query(`SELECT count(*)::int AS n FROM work_activity_links WHERE activity_id = $1 AND target_kind = 'project'`, [activityId]);
    expect(links.rows[0].n).toBe(1);
  });

  it("two different sourceRefs never collide (distinct rows)", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${co}/work-activity`,
      headers: asUser(admin),
      payload: { source: "manual", sourceRef: "manual-note-1", verb: "noted", objectKind: "deliverable", objectRef: "d1", title: "Client approved the brief" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().deduped).toBe(false);
    expect(r.json().id).not.toBe(activityId);
  });

  it("read is member-level; filters by projectId/deptId narrow the result", async () => {
    const all = await app.inject({ method: "GET", url: `/api/${co}/work-activity`, headers: asUser(member) });
    expect(all.statusCode).toBe(200);
    expect(all.json().length).toBeGreaterThanOrEqual(2);

    const byProject = await app.inject({ method: "GET", url: `/api/${co}/work-activity?projectId=${projectId}`, headers: asUser(member) });
    expect(byProject.statusCode).toBe(200);
    expect(byProject.json().map((r: { id: string }) => r.id)).toEqual([activityId]);

    const byDept = await app.inject({ method: "GET", url: `/api/${co}/work-activity?deptId=d-creative`, headers: asUser(member) });
    expect(byDept.statusCode).toBe(200);
    expect(byDept.json().map((r: { id: string }) => r.id)).toEqual([activityId]);

    const byOtherDept = await app.inject({ method: "GET", url: `/api/${co}/work-activity?deptId=d-nonexistent`, headers: asUser(member) });
    expect(byOtherDept.statusCode).toBe(200);
    expect(byOtherDept.json()).toEqual([]);
  });

  it("tenant isolation: a rival admin sees nothing and cannot ingest into this tenant", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${other}/work-activity`, headers: asUser(otherAdmin) });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    const cross = await app.inject({
      method: "POST",
      url: `/api/${co}/work-activity`,
      headers: asUser(otherAdmin),
      payload: { source: "manual", sourceRef: "rival-1", verb: "noted", objectKind: "deliverable", objectRef: "d2" },
    });
    expect(cross.statusCode).toBe(403);
  });

  it("deliverable_evidence view surfaces file/doc/deliverable activity", async () => {
    const rows = await adminPool().query(`SELECT object_kind, target_kind FROM deliverable_evidence WHERE tenant_id = $1`, [co]);
    expect(rows.rows.every((r: { object_kind: string }) => ["file", "doc", "deliverable"].includes(r.object_kind))).toBe(true);
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
  });

  // ---- WD-26: stale-tasks (wd-stale-nag's data source) + the deterministic relink sweep (LD-16) ----
  describe("WD-26: stale-tasks + relink sweep", () => {
    let staleProjectId: string;
    let staleTaskId: string;
    let staleAssignee: string;
    let projectOwner: string;

    it("seed: a stale task (assignee, backdated, no activity) under a project with an owner", async () => {
      staleAssignee = await createUser("stale-assignee@work-activity.test");
      projectOwner = await createUser("stale-owner@work-activity.test");
      await addMembership(co, staleAssignee);
      await addMembership(co, projectOwner);
      await grantRole(staleAssignee, await createRole("member"), "company", co);
      await grantRole(projectOwner, await createRole("manager"), "company", co);

      staleProjectId = await createProject(co, "Stale project");
      staleTaskId = await createPmTask(co, staleProjectId, "Forgotten task");
      await withTenants([co], (c) =>
        c.query(
          `UPDATE pm_tasks SET assignee = $2, created_at = now() - interval '30 days' WHERE id = $1`,
          [
            staleTaskId,
            JSON.stringify({ kind: "person", refId: staleAssignee, refName: "Stale Assignee", responsibleId: staleAssignee, responsibleName: "Stale Assignee" }),
          ],
        ),
      );
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO pm_project_meta (tenant_id, project_id, owner, origin_site) VALUES ($1, $2, $3, 'central')
           ON CONFLICT (tenant_id, project_id) DO UPDATE SET owner = EXCLUDED.owner`,
          [
            co, staleProjectId,
            JSON.stringify({ kind: "person", refId: projectOwner, refName: "Project Owner", responsibleId: projectOwner, responsibleName: "Project Owner" }),
          ],
        ),
      );
    });

    it("stale-tasks(days=5) surfaces it with assignee + project-owner ids, daysStale past the 2N=10 escalation line", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/work-activity/stale-tasks?days=5`, headers: asUser(member) });
      expect(r.statusCode).toBe(200);
      const row = r.json().find((t: { taskId: string }) => t.taskId === staleTaskId);
      expect(row).toBeTruthy();
      expect(row.assigneeUserId).toBe(staleAssignee);
      expect(row.projectOwnerUserId).toBe(projectOwner);
      expect(row.daysStale).toBeGreaterThanOrEqual(10); // >= 2*N: wd-stale-nag's escalation branch fires
    });

    it("a task with recent activity is NOT reported stale", async () => {
      // `taskId` (top-level fixture) has real activity ingested moments ago in this same suite.
      const r = await app.inject({ method: "GET", url: `/api/${co}/work-activity/stale-tasks?days=5`, headers: asUser(member) });
      expect(r.json().map((t: { taskId: string }) => t.taskId)).not.toContain(taskId);
    });

    it("stale-tasks is member-level, not admin-only (200 for a plain member)", async () => {
      expect((await app.inject({ method: "GET", url: `/api/${co}/work-activity/stale-tasks`, headers: asUser(member) })).statusCode).toBe(200);
    });

    it("relink sweep links a deliberately-unlinked row, and re-running is idempotent", async () => {
      // A manual activity with no structured hint and no scannable uuid in its title -> zero links.
      const post = await app.inject({
        method: "POST", url: `/api/${co}/work-activity`, headers: asUser(admin),
        payload: { source: "manual", sourceRef: "unlinked-1", verb: "noted", objectKind: "deliverable", objectRef: "d3", title: "Free text, no hints" },
      });
      expect(post.json().links).toEqual([]);
      const unlinkedId = post.json().id;

      // Retroactively give it a resolvable hint the original ingest call never carried (simulates a
      // linker miss / a payload whose linkable id only became known later).
      await adminPool().query(`UPDATE work_activity SET payload = $2 WHERE id = $1`, [unlinkedId, JSON.stringify({ taskId: staleTaskId })]);

      const relink1 = await app.inject({ method: "POST", url: `/api/${co}/work-activity/relink`, headers: asUser(admin) });
      expect(relink1.statusCode).toBe(200);
      expect(relink1.json().relinked).toBeGreaterThanOrEqual(1);

      const linkedAfter1 = await adminPool().query(`SELECT target_kind, target_id FROM work_activity_links WHERE activity_id = $1`, [unlinkedId]);
      expect(linkedAfter1.rows.map((l: { target_kind: string; target_id: string }) => `${l.target_kind}:${l.target_id}`)).toContain(`pm_task:${staleTaskId}`);
      const countAfter1 = linkedAfter1.rowCount;

      // Idempotency: the row now HAS links, so it's no longer a zero-link candidate — a second
      // sweep over the same tenant must add nothing further to it (no double-linking, no churn).
      const relink2 = await app.inject({ method: "POST", url: `/api/${co}/work-activity/relink`, headers: asUser(admin) });
      expect(relink2.statusCode).toBe(200);
      const linkedAfter2 = await adminPool().query(`SELECT count(*)::int AS n FROM work_activity_links WHERE activity_id = $1`, [unlinkedId]);
      expect(linkedAfter2.rows[0].n).toBe(countAfter1);
    });

    it("relink is admin/service-only (403 for a plain member)", async () => {
      expect((await app.inject({ method: "POST", url: `/api/${co}/work-activity/relink`, headers: asUser(member) })).statusCode).toBe(403);
    });
  });
});
