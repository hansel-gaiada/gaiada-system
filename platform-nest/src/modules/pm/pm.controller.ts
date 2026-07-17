// Project-management subsystem (BFF §5) — Repsona-style rich tasks over the base projects.
// Backs platform-ui lib/pm.ts + lib/pmActions.ts. Dedicated pm_* tables (migration 0018);
// task comments reuse the generic /api/:t/comments endpoint. The AI Tracker here is the
// deterministic baseline (progress-from-subtasks + status coupling); the WS8 PM specialist
// agent replaces the analysis later behind the same contract.
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity, notify } from "../../core/http";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";

type Assignee = {
  kind: "person" | "department" | "division";
  refId: string;
  refName: string;
  responsibleId: string;
  responsibleName: string;
} | null;

const STATUSES = new Set(["todo", "in_progress", "blocked", "done"]);
const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Full PmTask projection (dates as YYYY-MM-DD text; loggedMinutes summed from time_entries).
const TASK_SELECT = `
  SELECT t.id, t.project_id AS "projectId", p.name AS "projectName", t.title, t.description,
         t.status, t.priority, t.progress, t.assignee, t.subtasks, t.milestone_id AS "milestoneId",
         to_char(t.start_date, 'YYYY-MM-DD') AS "startDate", to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate",
         t.estimate_minutes AS "estimateMinutes", t.depends_on AS "dependsOn", t.updated_at AS "updatedAt",
         COALESCE((SELECT SUM(minutes) FROM time_entries te WHERE te.pm_task_id = t.id AND te.deleted_at IS NULL), 0)::int AS "loggedMinutes"
  FROM pm_tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.deleted_at IS NULL`;

interface TaskRow {
  id: string; projectId: string; projectName: string; title: string; description: string;
  status: string; priority: string; progress: number; assignee: Assignee; subtasks: unknown[];
  milestoneId: string | null; startDate: string | null; dueDate: string | null;
  estimateMinutes: number | null; dependsOn: string[]; updatedAt: string | null; loggedMinutes: number;
}

function validAssignee(a: unknown): Assignee {
  if (!a || typeof a !== "object") return null;
  const r = a as Record<string, unknown>;
  const kind = r.kind as string;
  if (kind !== "person" && kind !== "department" && kind !== "division") return null;
  if (typeof r.refId !== "string" || typeof r.responsibleId !== "string" || !r.refId || !r.responsibleId) return null;
  return {
    kind,
    refId: r.refId,
    refName: typeof r.refName === "string" ? r.refName : r.refId,
    responsibleId: r.responsibleId,
    responsibleName: typeof r.responsibleName === "string" ? r.responsibleName : r.responsibleId,
  };
}

async function fetchTask(c: PoolClient, id: string): Promise<TaskRow | undefined> {
  const rows = await c.query<TaskRow>(`${TASK_SELECT} AND t.id = $1`, [id]);
  return rows.rows[0];
}

async function projectExists(c: PoolClient, projectId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL`, [projectId]);
  return !!r.rows[0];
}

@Controller("api")
@UseGuards(AuthGuard)
export class PmController {
  // ---------------- Projects ----------------
  @Get(":tenantId/pm/projects/:projectId")
  async getProject(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], async (c) => {
      const proj = await c.query<{ name: string; status: string; dueDate: string | null }>(
        `SELECT name, status, to_char(due_date, 'YYYY-MM-DD') AS "dueDate" FROM projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (!proj.rows[0]) throw new NotFoundException("project not found");
      const meta = await c.query<{ owner: Assignee }>(`SELECT owner FROM pm_project_meta WHERE project_id = $1`, [projectId]);
      const milestones = await c.query(
        `SELECT id, project_id AS "projectId", name, to_char(due_date, 'YYYY-MM-DD') AS "dueDate", status
         FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL ORDER BY due_date NULLS LAST, created_at`,
        [projectId],
      );
      const agg = await c.query<{ task_count: string; avg_progress: string | null }>(
        `SELECT COUNT(*) AS task_count, AVG(progress) AS avg_progress FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const docs = await c.query<{ n: string }>(`SELECT COUNT(*) AS n FROM pm_docs WHERE project_id = $1 AND deleted_at IS NULL`, [projectId]);
      return {
        id: projectId,
        name: proj.rows[0].name,
        status: proj.rows[0].status,
        progress: Math.round(Number(agg.rows[0].avg_progress ?? 0)),
        owner: meta.rows[0]?.owner ?? null,
        dueDate: proj.rows[0].dueDate,
        milestones: milestones.rows,
        docCount: Number(docs.rows[0].n),
        taskCount: Number(agg.rows[0].task_count),
      };
    });
  }

  @Patch(":tenantId/pm/projects/:projectId")
  @HttpCode(200)
  async patchProject(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { owner?: unknown; status?: string; dueDate?: string | null },
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      if (b?.status !== undefined || b?.dueDate !== undefined) {
        await c.query(
          `UPDATE projects SET status = COALESCE($2, status), due_date = COALESCE($3::date, due_date), updated_at = now()
           WHERE id = $1 AND deleted_at IS NULL`,
          [projectId, b?.status ?? null, b?.dueDate ?? null],
        );
      }
      if (Object.prototype.hasOwnProperty.call(b ?? {}, "owner")) {
        const owner = validAssignee(b.owner);
        await c.query(
          `INSERT INTO pm_project_meta (tenant_id, project_id, owner, origin_site) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, project_id) DO UPDATE SET owner = $3, updated_at = now()`,
          [tenantId, projectId, owner ? JSON.stringify(owner) : null, config.originSite],
        );
      }
      await emitEvent(c, tenantId, "pm_project", projectId, "pm.project.updated", { status: b?.status ?? null });
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_project", projectId);
    return { ok: true };
  }

  @Get(":tenantId/pm/projects/:projectId/tasks")
  async projectTasks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, projectId }, "read");
    return withTenants([tenantId], (c) =>
      c.query<TaskRow>(`${TASK_SELECT} AND t.project_id = $1 ORDER BY t.created_at`, [projectId]).then((r) => r.rows),
    );
  }

  // ---------------- Tasks ----------------
  @Get(":tenantId/pm/tasks")
  async listTasks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("assignee") assignee?: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "read");
    const mine = assignee === "me";
    return withTenants([tenantId], (c) =>
      c
        .query<TaskRow>(
          `${TASK_SELECT} ${mine ? `AND (t.assignee->>'responsibleId' = $1 OR (t.assignee->>'kind' = 'person' AND t.assignee->>'refId' = $1))` : ""}
           ORDER BY t.due_date NULLS LAST, t.created_at DESC LIMIT 500`,
          mine ? [req.principal.userId] : [],
        )
        .then((r) => r.rows),
    );
  }

  @Get(":tenantId/pm/tasks/:taskId")
  async getTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    const task = await withTenants([tenantId], (c) => fetchTask(c, taskId));
    if (!task) throw new NotFoundException("task not found");
    return task;
  }

  @Post(":tenantId/pm/tasks")
  @HttpCode(201)
  async createTask(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: { projectId?: string; title?: string; priority?: string; dueDate?: string; startDate?: string; milestoneId?: string; description?: string; estimateMinutes?: number; assignee?: unknown },
  ) {
    const title = b?.title?.trim();
    if (!b?.projectId || !title) throw new BadRequestException("projectId and title required");
    if (b.priority && !PRIORITIES.has(b.priority)) throw new BadRequestException("invalid priority");
    await authorize(req.principal, { kind: "pm_task", tenantId, projectId: b.projectId }, "create");
    const assignee = validAssignee(b.assignee);
    const id = newId();
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, b.projectId!))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, priority, assignee, milestone_id, start_date, due_date, estimate_minutes, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12)`,
        [id, tenantId, b.projectId, title, b.description ?? "", b.priority ?? "normal",
         assignee ? JSON.stringify(assignee) : null, b.milestoneId || null, b.startDate || null, b.dueDate || null,
         b.estimateMinutes ?? null, config.originSite],
      );
      await emitEvent(c, tenantId, "pm_task", id, "pm.task.created", { title, projectId: b.projectId });
    });
    if (assignee?.responsibleId) {
      await notify(tenantId, assignee.responsibleId, req.principal.userId, "assignment", { entityType: "task", entityId: id, href: `/tasks/${id}` });
    }
    await writeActivity(tenantId, req.principal.userId, "created", "pm_task", id, { title });
    return { id };
  }

  @Patch(":tenantId/pm/tasks/:taskId")
  @HttpCode(200)
  async patchTask(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("taskId") taskId: string,
    @Body() b: Record<string, unknown>,
  ) {
    // Changing the assignee is the privileged operation; execution edits are member-level.
    const managing = Object.prototype.hasOwnProperty.call(b ?? {}, "assignee");
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, managing ? "manage" : "update");

    let notifyResponsible: string | null = null;
    await withTenants([tenantId], async (c) => {
      const task = await fetchTask(c, taskId);
      if (!task) throw new NotFoundException("task not found");

      // Mutable working copy of the fields the coupling rules touch.
      let subtasks = Array.isArray(task.subtasks) ? [...(task.subtasks as { id: string; title: string; done: boolean }[])] : [];
      let subtasksChanged = false;
      let progress = task.progress;
      let status = task.status;
      let dependsOn = [...(task.dependsOn ?? [])];

      // ---- subtasks ----
      if (typeof b.addSubtask === "string" && b.addSubtask.trim()) {
        subtasks.push({ id: newId(), title: b.addSubtask.trim().slice(0, 200), done: false });
        subtasksChanged = true;
      }
      if (typeof b.toggleSubtask === "string") {
        subtasks = subtasks.map((s) => (s.id === b.toggleSubtask ? { ...s, done: !s.done } : s));
        subtasksChanged = true;
      }
      if (typeof b.removeSubtask === "string") {
        subtasks = subtasks.filter((s) => s.id !== b.removeSubtask);
        subtasksChanged = true;
      }

      // ---- dependencies ----
      if (typeof b.addDependency === "string") {
        if (!UUID_RE.test(b.addDependency) || b.addDependency === taskId) throw new BadRequestException("invalid dependency");
        const dep = await c.query(`SELECT 1 FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [b.addDependency]);
        if (!dep.rows[0]) throw new BadRequestException("dependency task not found");
        if (!dependsOn.includes(b.addDependency)) dependsOn.push(b.addDependency);
      }
      if (typeof b.removeDependency === "string") dependsOn = dependsOn.filter((d) => d !== b.removeDependency);

      // ---- progress / status (explicit + coupling rules) ----
      if (typeof b.progress === "number") progress = Math.max(0, Math.min(100, Math.round(b.progress)));
      else if (subtasksChanged && subtasks.length > 0) progress = Math.round((subtasks.filter((s) => s.done).length / subtasks.length) * 100);
      if (typeof b.status === "string") {
        if (!STATUSES.has(b.status)) throw new BadRequestException("invalid status");
        status = b.status;
      }
      if (status === "done") progress = 100;
      else if (progress >= 100) status = "done";

      // ---- validated scalar meta ----
      if (b.priority !== undefined && b.priority !== null && !PRIORITIES.has(String(b.priority))) throw new BadRequestException("invalid priority");
      let assignee = task.assignee;
      if (managing) {
        assignee = validAssignee(b.assignee);
        if (assignee?.responsibleId && assignee.responsibleId !== task.assignee?.responsibleId) notifyResponsible = assignee.responsibleId;
      }

      await c.query(
        `UPDATE pm_tasks SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           priority = COALESCE($4, priority),
           status = $5,
           progress = $6,
           subtasks = $7,
           depends_on = $8,
           assignee = $9,
           milestone_id = CASE WHEN $10 THEN $11 ELSE milestone_id END,
           start_date = CASE WHEN $12 THEN $13::date ELSE start_date END,
           due_date = CASE WHEN $14 THEN $15::date ELSE due_date END,
           estimate_minutes = CASE WHEN $16 THEN $17 ELSE estimate_minutes END,
           updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL`,
        [
          taskId,
          typeof b.title === "string" ? b.title : null,
          typeof b.description === "string" ? b.description : null,
          typeof b.priority === "string" ? b.priority : null,
          status,
          progress,
          JSON.stringify(subtasks),
          dependsOn,
          assignee ? JSON.stringify(assignee) : null,
          Object.prototype.hasOwnProperty.call(b, "milestoneId"), (b.milestoneId as string) || null,
          Object.prototype.hasOwnProperty.call(b, "startDate"), (b.startDate as string) || null,
          Object.prototype.hasOwnProperty.call(b, "dueDate"), (b.dueDate as string) || null,
          Object.prototype.hasOwnProperty.call(b, "estimateMinutes"), (b.estimateMinutes as number) ?? null,
        ],
      );
      await emitEvent(c, tenantId, "pm_task", taskId, "pm.task.updated", { status });
    });
    if (notifyResponsible) {
      await notify(tenantId, notifyResponsible, req.principal.userId, "assignment", { entityType: "task", entityId: taskId, href: `/tasks/${taskId}` });
    }
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_task", taskId, {});
    return { ok: true };
  }

  @Delete(":tenantId/pm/tasks/:taskId")
  @HttpCode(200)
  async deleteTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "delete");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE pm_tasks SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [taskId]);
      if (res.rowCount === 0) throw new NotFoundException("task not found");
      // Drop this task from any other task's dependency list.
      await c.query(`UPDATE pm_tasks SET depends_on = array_remove(depends_on, $1) WHERE $1 = ANY(depends_on)`, [taskId]);
      await emitEvent(c, tenantId, "pm_task", taskId, "pm.task.deleted", {});
    });
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_task", taskId);
    return { ok: true };
  }

  // ---------------- Time logs (reuse time_entries via pm_task_id) ----------------
  @Get(":tenantId/pm/tasks/:taskId/time")
  async listTime(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT te.id, te.pm_task_id AS "taskId", te.user_id AS "userId", u.name AS "userName", te.minutes,
                  to_char(te.entry_date, 'YYYY-MM-DD') AS "spentOn", te.billable, te.notes AS note
           FROM time_entries te LEFT JOIN users u ON u.id = te.user_id
           WHERE te.pm_task_id = $1 AND te.deleted_at IS NULL ORDER BY te.entry_date DESC, te.created_at DESC`,
          [taskId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/tasks/:taskId/time")
  @HttpCode(201)
  async logTime(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("taskId") taskId: string,
    @Body() b: { minutes?: number; spentOn?: string; billable?: boolean; note?: string },
  ) {
    if (typeof b?.minutes !== "number" || !Number.isInteger(b.minutes) || b.minutes <= 0) throw new BadRequestException("minutes must be a positive integer");
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "update");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      const task = await c.query<{ project_id: string }>(`SELECT project_id FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [taskId]);
      if (!task.rows[0]) throw new NotFoundException("task not found");
      await c.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, pm_task_id, minutes, billable, entry_date, notes, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, current_date), $9, $10)`,
        [id, tenantId, req.principal.userId, task.rows[0].project_id, taskId, b.minutes, b.billable ?? false, b.spentOn || null, b.note ?? "", config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "logged", "pm_task", taskId, { minutes: b.minutes });
    return { id };
  }

  // ---------------- Milestones ----------------
  @Get(":tenantId/pm/projects/:projectId/milestones")
  async listMilestones(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT id, project_id AS "projectId", name, to_char(due_date, 'YYYY-MM-DD') AS "dueDate", status
           FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL ORDER BY due_date NULLS LAST, created_at`,
          [projectId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/projects/:projectId/milestones")
  @HttpCode(201)
  async createMilestone(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Body() b: { name?: string; dueDate?: string | null }) {
    const name = b?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, origin_site) VALUES ($1, $2, $3, $4, $5::date, $6)`,
        [id, tenantId, projectId, name, b.dueDate || null, config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_milestone", id, { name });
    return { id };
  }

  @Patch(":tenantId/pm/projects/:projectId/milestones/:milestoneId")
  @HttpCode(200)
  async patchMilestone(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Param("milestoneId") milestoneId: string, @Body() b: { name?: string; dueDate?: string | null; status?: string }) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(
        `UPDATE pm_milestones SET name = COALESCE($3, name),
           due_date = CASE WHEN $4 THEN $5::date ELSE due_date END, status = COALESCE($6, status), updated_at = now()
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [milestoneId, projectId, b?.name ?? null, Object.prototype.hasOwnProperty.call(b ?? {}, "dueDate"), b?.dueDate || null, b?.status ?? null],
      );
      if (res.rowCount === 0) throw new NotFoundException("milestone not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_milestone", milestoneId);
    return { ok: true };
  }

  // ---------------- Docs ----------------
  @Get(":tenantId/pm/projects/:projectId/docs")
  async listDocs(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT d.id, d.project_id AS "projectId", d.title, d.body, u.name AS author, d.updated_at AS "updatedAt"
           FROM pm_docs d LEFT JOIN users u ON u.id = d.author_id
           WHERE d.project_id = $1 AND d.deleted_at IS NULL ORDER BY d.updated_at DESC`,
          [projectId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/projects/:projectId/docs")
  @HttpCode(201)
  async createDoc(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Body() b: { title?: string; body?: string }) {
    const title = b?.title?.trim();
    if (!title) throw new BadRequestException("title required");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_docs (id, tenant_id, project_id, title, body, author_id, origin_site) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, projectId, title, b.body ?? "", req.principal.userId, config.originSite],
      );
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_doc", id, { title });
    return { id };
  }

  @Get(":tenantId/pm/projects/:projectId/docs/:docId")
  async getDoc(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Param("docId") docId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT d.id, d.project_id AS "projectId", d.title, d.body, u.name AS author, d.updated_at AS "updatedAt"
         FROM pm_docs d LEFT JOIN users u ON u.id = d.author_id WHERE d.id = $1 AND d.project_id = $2 AND d.deleted_at IS NULL`,
        [docId, projectId],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("doc not found");
    return rows.rows[0];
  }

  @Patch(":tenantId/pm/projects/:projectId/docs/:docId")
  @HttpCode(200)
  async patchDoc(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Param("docId") docId: string, @Body() b: { title?: string; body?: string }) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(
        `UPDATE pm_docs SET title = COALESCE($3, title), body = COALESCE($4, body), updated_at = now()
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [docId, projectId, b?.title ?? null, b?.body ?? null],
      );
      if (res.rowCount === 0) throw new NotFoundException("doc not found");
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_doc", docId);
    return { ok: true };
  }

  // ---------------- AI Tracker ----------------
  @Get(":tenantId/pm/tasks/:taskId/suggestions")
  async listSuggestions(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT id, task_id AS "taskId", kind, proposed, rationale, docs, status, created_at AS "createdAt"
           FROM pm_suggestions WHERE task_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [taskId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/tasks/:taskId/tracker/run")
  @HttpCode(200)
  async runTracker(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "update");
    const result = await withTenants([tenantId], async (c) => {
      const task = await fetchTask(c, taskId);
      if (!task) throw new NotFoundException("task not found");
      const subtasks = (task.subtasks as { done: boolean }[]) ?? [];
      const done = subtasks.filter((s) => s.done).length;
      const computedProgress = subtasks.length > 0 ? Math.round((done / subtasks.length) * 100) : task.progress;
      let computedStatus = task.status;
      if (computedProgress >= 100) computedStatus = "done";
      else if (computedProgress > 0 && task.status === "todo") computedStatus = "in_progress";
      const rationale =
        subtasks.length > 0
          ? `${done}/${subtasks.length} subtasks complete → ${computedProgress}% progress${computedStatus !== task.status ? `, move to “${computedStatus}”` : ""}.`
          : `No subtasks to measure; holding at ${computedProgress}%. Add a checklist for finer tracking.`;

      // Deliver the project's docs as reference material (WS8 agent will source from Knowledge/D9).
      const docs = await c.query<{ id: string; title: string }>(
        `SELECT id, title FROM pm_docs WHERE project_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 3`,
        [task.projectId],
      );
      const delivered = docs.rows.map((d) => ({ title: d.title, ref: `/projects/${task.projectId}?doc=${d.id}` }));

      const suggestions: { id: string; taskId: string; kind: string; proposed: string; rationale: string; docs: unknown[]; status: string; createdAt: string }[] = [];
      const insertSuggestion = async (kind: "progress" | "status", proposed: string) => {
        const sid = newId();
        const row = await c.query<{ created_at: string }>(
          `INSERT INTO pm_suggestions (id, tenant_id, task_id, kind, proposed, rationale, docs, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING created_at`,
          [sid, tenantId, taskId, kind, proposed, rationale, JSON.stringify(delivered), config.originSite],
        );
        suggestions.push({ id: sid, taskId, kind, proposed, rationale, docs: delivered, status: "pending", createdAt: row.rows[0].created_at });
      };
      if (computedProgress !== task.progress) await insertSuggestion("progress", String(computedProgress));
      if (computedStatus !== task.status) await insertSuggestion("status", computedStatus);

      // AI-authored comment (author_id null = system/AI) delivered onto the task thread.
      await c.query(
        `INSERT INTO comments (id, tenant_id, author_id, target_entity_type, target_entity_id, body, origin_site)
         VALUES ($1, $2, NULL, 'task', $3, $4, $5)`,
        [newId(), tenantId, taskId, `AI Tracker: ${rationale}`, config.originSite],
      );
      await emitEvent(c, tenantId, "pm_task", taskId, "pm.tracker.run", { suggestions: suggestions.length });
      return { suggestions, delivered, responsibleId: task.assignee?.responsibleId ?? null };
    });
    // Notify the person in charge that the tracker delivered an update.
    if (result.responsibleId) {
      await notify(tenantId, result.responsibleId, req.principal.userId, "tracker", { entityType: "task", entityId: taskId, href: `/tasks/${taskId}` });
    }
    await writeActivity(tenantId, req.principal.userId, "tracker.run", "pm_task", taskId, { suggestions: result.suggestions.length });
    return { suggestions: result.suggestions, delivered: result.delivered };
  }

  @Post(":tenantId/pm/suggestions/:suggestionId/confirm")
  @HttpCode(200)
  async confirmSuggestion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("suggestionId") suggestionId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    await withTenants([tenantId], async (c) => {
      const sug = await c.query<{ task_id: string; kind: string; proposed: string; status: string }>(
        `SELECT task_id, kind, proposed, status FROM pm_suggestions WHERE id = $1`,
        [suggestionId],
      );
      const s = sug.rows[0];
      if (!s) throw new NotFoundException("suggestion not found");
      if (s.status !== "pending") throw new BadRequestException("suggestion already resolved");
      // Apply the proposal, honouring the same done↔100 coupling as PATCH.
      if (s.kind === "progress") {
        const p = Math.max(0, Math.min(100, Math.round(Number(s.proposed) || 0)));
        await c.query(
          `UPDATE pm_tasks SET progress = $2, status = CASE WHEN $2 >= 100 THEN 'done' ELSE status END, updated_at = now() WHERE id = $1`,
          [s.task_id, p],
        );
      } else {
        if (!STATUSES.has(s.proposed)) throw new BadRequestException("suggestion has invalid status");
        await c.query(
          `UPDATE pm_tasks SET status = $2, progress = CASE WHEN $2 = 'done' THEN 100 ELSE progress END, updated_at = now() WHERE id = $1`,
          [s.task_id, s.proposed],
        );
      }
      await c.query(`UPDATE pm_suggestions SET status = 'applied', updated_at = now() WHERE id = $1`, [suggestionId]);
      await emitEvent(c, tenantId, "pm_task", s.task_id, "pm.suggestion.confirmed", { suggestionId, kind: s.kind });
    });
    await writeActivity(tenantId, req.principal.userId, "suggestion.confirmed", "pm_suggestion", suggestionId);
    return { ok: true };
  }

  @Post(":tenantId/pm/suggestions/:suggestionId/dismiss")
  @HttpCode(200)
  async dismissSuggestion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("suggestionId") suggestionId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE pm_suggestions SET status = 'dismissed', updated_at = now() WHERE id = $1 AND status = 'pending'`, [suggestionId]);
      if (res.rowCount === 0) throw new NotFoundException("suggestion not found or already resolved");
    });
    await writeActivity(tenantId, req.principal.userId, "suggestion.dismissed", "pm_suggestion", suggestionId);
    return { ok: true };
  }
}
