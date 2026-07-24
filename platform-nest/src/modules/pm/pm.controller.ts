// Project-management subsystem (BFF §5) — Repsona-style rich tasks over the base projects.
// Backs platform-ui lib/pm.ts + lib/pmActions.ts. Dedicated pm_* tables (migration 0018);
// task comments reuse the generic /api/:t/comments endpoint. The AI Tracker here is the
// deterministic baseline (progress-from-subtasks + status coupling); the WS8 PM specialist
// agent replaces the analysis later behind the same contract.
import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { authorize, writeActivity, notify } from "../../core/http";
import { validateCustomFields } from "../../core/custom-fields";
import { emitEvent } from "../../events/outbox.service";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";

type Assignee = {
  kind: "person" | "department" | "division";
  refId: string;
  refName: string;
  responsibleId: string;
  responsibleName: string;
} | null;

const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Closed palette (P2-01 / pm-console-ux-design-spec §6): the stored value is the slug, never a hex.
const TAG_COLORS = new Set(["bronze", "champagne", "olive", "slate", "clay", "moss", "dust", "ink"]);
const STATUS_ID_RE = /^[a-z0-9_]{1,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------- Recurring tasks (P2-06, pm-console-ux-design-spec §8) ----------------
type RecurrenceFreq = "daily" | "weekly" | "biweekly" | "monthly";
const RECURRENCE_FREQS = new Set<RecurrenceFreq>(["daily", "weekly", "biweekly", "monthly"]);
interface TaskRecurrence { freq: RecurrenceFreq; until?: string }

function validRecurrence(v: unknown): TaskRecurrence | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new BadRequestException("recurrence must be an object or null");
  const r = v as Record<string, unknown>;
  if (typeof r.freq !== "string" || !RECURRENCE_FREQS.has(r.freq as RecurrenceFreq)) {
    throw new BadRequestException("recurrence.freq must be one of daily|weekly|biweekly|monthly");
  }
  const out: TaskRecurrence = { freq: r.freq as RecurrenceFreq };
  if (r.until !== undefined && r.until !== null) {
    if (typeof r.until !== "string" || !DATE_RE.test(r.until)) throw new BadRequestException("recurrence.until must be a YYYY-MM-DD date");
    out.until = r.until;
  }
  return out;
}

// Shift a YYYY-MM-DD date forward by one occurrence of `freq`. Monthly clamps
// the day-of-month to the target month's last day (calendar-month semantics —
// Jan 31 + 1 month = Feb 28/29, never overflowing into March).
function addFreq(dateStr: string, freq: RecurrenceFreq): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  if (freq === "monthly") {
    let ny = y;
    let nm = mo + 1;
    if (nm > 12) { nm = 1; ny += 1; }
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const nd = Math.min(d, lastDay);
    return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
  }
  const days = freq === "daily" ? 1 : freq === "weekly" ? 7 : 14;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The next occurrence's dates, or null when there's nothing to spawn: no due
// date to anchor on, or the shifted due date would land after `until`. Shifts
// startDate too (preserving the original start→due offset) when the task has
// one; dueDate-only tasks shift just the due date, per the locked contract.
function computeNextOccurrence(dueDate: string | null, startDate: string | null, rec: TaskRecurrence): { startDate: string | null; dueDate: string } | null {
  if (!dueDate) return null;
  const nextDue = addFreq(dueDate, rec.freq);
  if (rec.until && nextDue > rec.until) return null;
  const nextStart = startDate ? addFreq(startDate, rec.freq) : null;
  return { startDate: nextStart, dueDate: nextDue };
}

// ---------------- Custom statuses (P2-04, pm-console-ux-design-spec §7) ----------------
// A per-project ordered status registry with is_done/is_blocked ENGINE FLAGS. done/blocked
// semantics everywhere on the BE derive from these flags, never from string-matching the id.
interface StatusRow {
  id: string; position: number; label: string; color: string;
  isDone: boolean; isBlocked: boolean; wipLimit: number | null;
}
type ProjectStatus = { id: string; label: string; color: string; isDone: boolean; isBlocked: boolean; position: number; wipLimit?: number };

// D-3: default ids ARE the legacy literals so existing pm_tasks.status values stay valid with zero
// row rewrites; labels/colors match today's platform-ui lib/pm.ts + components/ui.tsx STATUS_COLORS
// (byte-identical read-back for a project that never opens the editor).
const DEFAULT_STATUSES: readonly StatusRow[] = [
  { id: "todo", position: 0, label: "To do", color: "#6E5A43", isDone: false, isBlocked: false, wipLimit: null },
  { id: "in_progress", position: 1, label: "In progress", color: "#6E5A43", isDone: false, isBlocked: false, wipLimit: null },
  { id: "blocked", position: 2, label: "Blocked", color: "#B5622F", isDone: false, isBlocked: true, wipLimit: null },
  { id: "done", position: 3, label: "Done", color: "#4B7A5A", isDone: true, isBlocked: false, wipLimit: null },
];

function toProjectStatus(r: StatusRow): ProjectStatus {
  const out: ProjectStatus = { id: r.id, label: r.label, color: r.color, isDone: r.isDone, isBlocked: r.isBlocked, position: r.position };
  if (r.wipLimit != null) out.wipLimit = r.wipLimit;
  return out;
}

const STATUS_SELECT = `SELECT id, position, label, color, is_done AS "isDone", is_blocked AS "isBlocked", wip_limit AS "wipLimit"
  FROM pm_project_statuses WHERE project_id = $1 AND deleted_at IS NULL ORDER BY position, id`;

// Synth-on-read: materialized rows if ANY exist for the project, else the 4 synthesized defaults.
export async function effectiveStatuses(c: PoolClient, projectId: string): Promise<StatusRow[]> {
  const r = await c.query<StatusRow>(STATUS_SELECT, [projectId]);
  return r.rows.length > 0 ? r.rows : DEFAULT_STATUSES.map((s) => ({ ...s }));
}

// True once ANY status row exists for the project (incl. soft-deleted) — the "never re-synth after
// the first write" gate.
async function statusesMaterialized(c: PoolClient, projectId: string): Promise<boolean> {
  const r = await c.query(`SELECT 1 FROM pm_project_statuses WHERE project_id = $1 LIMIT 1`, [projectId]);
  return !!r.rows[0];
}

// The first status-editor write materializes the 4 defaults so the synthesized set is never
// silently lost once real rows start to exist.
async function ensureMaterialized(c: PoolClient, tenantId: string, projectId: string): Promise<void> {
  if (await statusesMaterialized(c, projectId)) return;
  for (const s of DEFAULT_STATUSES) {
    await c.query(
      `INSERT INTO pm_project_statuses (id, tenant_id, project_id, position, label, color, is_done, is_blocked, wip_limit, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id, project_id, id) DO NOTHING`,
      [s.id, tenantId, projectId, s.position, s.label, s.color, s.isDone, s.isBlocked, s.wipLimit, config.originSite],
    );
  }
}

// ---------------- Burndown snapshots (P2-07, pm-console-ux-design-spec §4, §0 D-2) ----------------
// One row per (tenant, project, day) in pm_progress_snapshots (migration 0040). The nightly job
// (burndown-job.ts) pre-warms every project; the LAZY upsert-on-read below is the correctness
// backstop — called on every burndown GET so a project the job never reached is still current.
// ON CONFLICT keeps this to exactly one row per day no matter how many times it runs that day.
export async function upsertTodaySnapshot(c: PoolClient, tenantId: string, projectId: string): Promise<void> {
  // Reuses effectiveStatuses()'s is_done FLAG derivation — never a literal status id — so a
  // renamed/custom done status (P2-04) still counts correctly.
  const statuses = await effectiveStatuses(c, projectId);
  const doneIds = statuses.filter((s) => s.isDone).map((s) => s.id);
  const agg = await c.query<{ open: string; done: string; avg: string | null }>(
    `SELECT
       COUNT(*) FILTER (WHERE NOT (status = ANY($2::text[]))) AS open,
       COUNT(*) FILTER (WHERE status = ANY($2::text[])) AS done,
       AVG(progress) AS avg
     FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL`,
    [projectId, doneIds],
  );
  const row = agg.rows[0];
  const openCount = Number(row?.open ?? 0);
  const doneCount = Number(row?.done ?? 0);
  const avgProgress = Math.round(Number(row?.avg ?? 0));
  // P3-05: per-status counts keyed by the task's raw status id (incl. any orphan id left over
  // from a since-deleted status — kept as-is, never pruned) for the flow-diagram view.
  const byStatus = await c.query<{ status: string; n: string }>(
    `SELECT status, COUNT(*) AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL GROUP BY status`,
    [projectId],
  );
  const statusCounts: Record<string, number> = {};
  for (const r of byStatus.rows) statusCounts[r.status] = Number(r.n);
  await c.query(
    `INSERT INTO pm_progress_snapshots (tenant_id, project_id, snapshot_date, open_count, done_count, avg_progress, status_counts, origin_site)
     VALUES ($1, $2, current_date, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, project_id, snapshot_date)
     DO UPDATE SET open_count = $3, done_count = $4, avg_progress = $5, status_counts = $6, updated_at = now()`,
    [tenantId, projectId, openCount, doneCount, avgProgress, JSON.stringify(statusCounts), config.originSite],
  );
}

function slugifyStatusId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "status";
}

function uniqueStatusId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 37)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 30)}_${Date.now().toString(36)}`;
}

// ---------------- Templates (P3-01) ----------------
// Tenant-scoped (not project-scoped — templates outlive/precede any one project) registry of two
// payload kinds. Payload shape is validated app-side (never trusted from the client past this
// gate); `kind` is immutable once created (PATCH only ever validates against the EXISTING row's
// kind, read from the DB, never from the request body).
type TemplateKind = "task" | "doc";
const TEMPLATE_KINDS = new Set<TemplateKind>(["task", "doc"]);

interface TaskTemplatePayload {
  title: string; description?: string; priority?: string; estimateMinutes?: number;
  subtasks?: string[]; tagLabels?: string[];
}
interface DocTemplatePayload { title: string; body: string }

function validateTemplatePayload(kind: string, payload: unknown): TaskTemplatePayload | DocTemplatePayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new BadRequestException("payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  if (!title) throw new BadRequestException("payload.title required");

  if (kind === "doc") {
    if (typeof p.body !== "string") throw new BadRequestException("payload.body must be a string");
    return { title, body: p.body };
  }
  if (kind === "task") {
    const out: TaskTemplatePayload = { title };
    if (p.description !== undefined) {
      if (typeof p.description !== "string") throw new BadRequestException("payload.description must be a string");
      out.description = p.description;
    }
    if (p.priority !== undefined) {
      if (typeof p.priority !== "string" || !PRIORITIES.has(p.priority)) throw new BadRequestException("payload.priority invalid");
      out.priority = p.priority;
    }
    if (p.estimateMinutes !== undefined) {
      if (typeof p.estimateMinutes !== "number" || !Number.isInteger(p.estimateMinutes) || p.estimateMinutes <= 0) {
        throw new BadRequestException("payload.estimateMinutes must be a positive integer");
      }
      out.estimateMinutes = p.estimateMinutes;
    }
    if (p.subtasks !== undefined) {
      if (!Array.isArray(p.subtasks) || !p.subtasks.every((s) => typeof s === "string")) {
        throw new BadRequestException("payload.subtasks must be an array of strings");
      }
      out.subtasks = (p.subtasks as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    if (p.tagLabels !== undefined) {
      if (!Array.isArray(p.tagLabels) || !p.tagLabels.every((s) => typeof s === "string")) {
        throw new BadRequestException("payload.tagLabels must be an array of strings");
      }
      out.tagLabels = (p.tagLabels as string[]).map((s) => s.trim()).filter((s) => s.length > 0);
    }
    return out;
  }
  // Unreachable when called after the TEMPLATE_KINDS.has() gate at the call sites, but kept
  // fail-closed in case this is ever called with an unvalidated kind.
  throw new BadRequestException("invalid kind");
}

function validWipLimit(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new BadRequestException("wipLimit must be a positive integer or null");
  }
  return v;
}

// Full PmTask projection (dates as YYYY-MM-DD text; loggedMinutes summed from time_entries).
const TASK_SELECT = `
  SELECT t.id, t.project_id AS "projectId", p.name AS "projectName", t.title, t.description,
         t.status, t.priority, t.progress, t.assignee, t.subtasks, t.milestone_id AS "milestoneId",
         to_char(t.start_date, 'YYYY-MM-DD') AS "startDate", to_char(t.due_date, 'YYYY-MM-DD') AS "dueDate",
         t.estimate_minutes AS "estimateMinutes", t.depends_on AS "dependsOn", t.tags, t.custom_fields AS "customFields", t.updated_at AS "updatedAt",
         t.recurrence,
         COALESCE((SELECT SUM(minutes) FROM time_entries te WHERE te.pm_task_id = t.id AND te.deleted_at IS NULL), 0)::int AS "loggedMinutes"
  FROM pm_tasks t JOIN projects p ON p.id = t.project_id
  WHERE t.deleted_at IS NULL`;

interface TaskRow {
  id: string; projectId: string; projectName: string; title: string; description: string;
  status: string; priority: string; progress: number; assignee: Assignee; subtasks: unknown[];
  milestoneId: string | null; startDate: string | null; dueDate: string | null;
  estimateMinutes: number | null; dependsOn: string[]; tags: string[]; customFields: Record<string, unknown>; updatedAt: string | null; loggedMinutes: number;
  recurrence: TaskRecurrence | null;
}

interface TagRow { id: string; label: string; color: string; }

async function fetchProjectTag(c: PoolClient, projectId: string, tagId: string): Promise<TagRow | undefined> {
  const r = await c.query<TagRow>(
    `SELECT id, label, color FROM pm_project_tags WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
    [tagId, projectId],
  );
  return r.rows[0];
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

// ---------------- Doc versions (P3-10) ----------------
// Append-only history for pm_docs. The doc row itself stays "latest"; every version that ever
// changed title/body lives here, never mutated once written.
const VERSION_RE = /^\d+$/;

function parseVersion(v: string): number {
  if (!VERSION_RE.test(v)) throw new BadRequestException("version must be a positive integer");
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException("version must be a positive integer");
  return n;
}

// Inserts the next append-only history row for `docId`. Pass an explicit `version` (only ever 1,
// from createDoc) or null to have it computed as MAX(version)+1 — callers computing MAX(version)+1
// MUST already hold the pm_docs row lock (SELECT ... FOR UPDATE) so concurrent writers serialize
// through it and can never race to the same next version number (UNIQUE(tenant_id, doc_id,
// version) is the hard backstop if that invariant is ever violated).
async function appendDocVersion(
  c: PoolClient,
  tenantId: string,
  docId: string,
  version: number | null,
  title: string,
  body: string,
  authorId: string | null,
): Promise<void> {
  let v = version;
  if (v === null) {
    const next = await c.query<{ next: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM pm_doc_versions WHERE tenant_id = $1 AND doc_id = $2`,
      [tenantId, docId],
    );
    v = next.rows[0].next;
  }
  await c.query(
    `INSERT INTO pm_doc_versions (id, tenant_id, doc_id, version, title, body, author_id, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), tenantId, docId, v, title, body, authorId, config.originSite],
  );
}

// Resolves a doc-scoped route's projectId for authz (kind: "pm_project" needs a project id) from
// the doc row itself — the doc-scoped version endpoints never take projectId as a route param.
// Tenant-scoped (RLS), so a doc belonging to another tenant or a soft-deleted doc reads as absent
// -> the caller 404s, exactly like every other cross-tenant/forged-id probe in this file.
async function resolveDocProjectId(tenantId: string, docId: string): Promise<string> {
  const projectId = await withTenants([tenantId], async (c) => {
    const r = await c.query<{ projectId: string }>(`SELECT project_id AS "projectId" FROM pm_docs WHERE id = $1 AND deleted_at IS NULL`, [docId]);
    return r.rows[0]?.projectId;
  });
  if (!projectId) throw new NotFoundException("doc not found");
  return projectId;
}

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("pm"))
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
      const statuses = (await effectiveStatuses(c, projectId)).map(toProjectStatus);
      return {
        id: projectId,
        name: proj.rows[0].name,
        status: proj.rows[0].status,
        progress: Math.round(Number(agg.rows[0].avg_progress ?? 0)),
        owner: meta.rows[0]?.owner ?? null,
        dueDate: proj.rows[0].dueDate,
        milestones: milestones.rows,
        statuses,
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
    @Body() b: { projectId?: string; title?: string; status?: string; priority?: string; dueDate?: string; startDate?: string; milestoneId?: string; description?: string; estimateMinutes?: number; assignee?: unknown; customFields?: Record<string, unknown>; recurrence?: unknown; subtasks?: unknown; tags?: unknown },
  ) {
    const title = b?.title?.trim();
    if (!b?.projectId || !title) throw new BadRequestException("projectId and title required");
    if (b.priority && !PRIORITIES.has(b.priority)) throw new BadRequestException("invalid priority");
    // ---- subtasks (P3-01): string[] -> [{id,title,done:false}] ----
    if (b.subtasks !== undefined && (!Array.isArray(b.subtasks) || !b.subtasks.every((s) => typeof s === "string"))) {
      throw new BadRequestException("subtasks must be an array of strings");
    }
    const subtasks = Array.isArray(b.subtasks)
      ? (b.subtasks as string[]).map((t) => t.trim()).filter((t) => t.length > 0).map((t) => ({ id: newId(), title: t.slice(0, 200), done: false }))
      : [];
    // ---- tags (P3-01): same cross-project-id validation as patchTask ----
    if (b.tags !== undefined && !Array.isArray(b.tags)) throw new BadRequestException("tags must be an array of tag ids");
    const tagIds = Array.isArray(b.tags) ? (b.tags as unknown[]) : [];
    if (!tagIds.every((tg) => typeof tg === "string" && UUID_RE.test(tg))) throw new BadRequestException("tags must be an array of tag ids");
    const uniqTags = Array.from(new Set(tagIds as string[]));
    await authorize(req.principal, { kind: "pm_task", tenantId, projectId: b.projectId }, "create");
    const assignee = validAssignee(b.assignee);
    const customFields = b.customFields ?? {};
    const recurrence = validRecurrence(b.recurrence);
    const id = newId();
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, b.projectId!))) throw new NotFoundException("project not found");
      // Validate status against the project's EFFECTIVE status set (synthesized or materialized).
      // When not supplied, default to the first status by position (= 'todo' for the common
      // unedited project → byte-identical, but never orphaned if the editor removed/reordered it).
      const statuses = await effectiveStatuses(c, b.projectId!);
      let status = [...statuses].sort((a, z) => a.position - z.position)[0]?.id ?? "todo";
      if (typeof b.status === "string") {
        if (!statuses.some((s) => s.id === b.status)) throw new BadRequestException("invalid status");
        status = b.status;
      }
      // Same flag-driven done-coupling as patchTask: resolve via effectiveStatuses' isDone flag,
      // never the literal id, so a renamed/custom is_done status still forces progress = 100
      // when a task is created directly into it.
      const chosenIsDone = statuses.find((s) => s.id === status)?.isDone ?? false;
      const progress = chosenIsDone ? 100 : 0;
      const cfError = await validateCustomFields(c, tenantId, "pm_task", customFields);
      if (cfError) throw new BadRequestException(cfError);
      if (uniqTags.length > 0) {
        const valid = await c.query<{ id: string }>(
          `SELECT id FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
          [b.projectId, uniqTags],
        );
        if (valid.rows.length !== uniqTags.length) throw new BadRequestException("one or more tag ids are not in this task's project tag registry");
      }
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, progress, assignee, milestone_id, start_date, due_date, estimate_minutes, custom_fields, recurrence, subtasks, tags, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::date, $13, $14, $15, $16, $17, $18)`,
        [id, tenantId, b.projectId, title, b.description ?? "", status, b.priority ?? "normal", progress,
         assignee ? JSON.stringify(assignee) : null, b.milestoneId || null, b.startDate || null, b.dueDate || null,
         b.estimateMinutes ?? null, JSON.stringify(customFields), recurrence ? JSON.stringify(recurrence) : null,
         JSON.stringify(subtasks), uniqTags, config.originSite],
      );
      await emitEvent(c, tenantId, "pm_task", id, "pm.task.created", { title, projectId: b.projectId });
    });
    if (assignee?.responsibleId) {
      await notify(tenantId, assignee.responsibleId, req.principal.userId, "assignment", {
        title: "You were assigned a task", severity: "info", entityType: "task", entityId: id, href: `/tasks/${id}`,
      });
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

    // Both reassigned inside the transaction closure and returned at the end,
    // rather than mutating outer `let`s — read via the awaited return value
    // instead (TS's closure-narrowing can't soundly track outer mutations).
    let notifyResponsible: string | null = null;
    const { spawned, statusChanged, newStatusLabel, taskTitle } = await withTenants([tenantId], async (c) => {
      let spawnedResult: { id: string; dueDate: string } | null = null;
      // Row-lock FIRST (before reading the "old" status the done-transition/spawn
      // guard depends on): a second concurrent PATCH completing the same task blocks
      // here until this transaction commits, then observes the row ALREADY done —
      // so its own not-done→done edge never fires and it can never double-spawn.
      const lock = await c.query(`SELECT 1 FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [taskId]);
      if (!lock.rows[0]) throw new NotFoundException("task not found");
      const task = await fetchTask(c, taskId);
      if (!task) throw new NotFoundException("task not found");

      // Mutable working copy of the fields the coupling rules touch.
      let subtasks = Array.isArray(task.subtasks) ? [...(task.subtasks as { id: string; title: string; done: boolean }[])] : [];
      let subtasksChanged = false;
      let progress = task.progress;
      let status = task.status;
      let dependsOn = [...(task.dependsOn ?? [])];
      let tags = [...(task.tags ?? [])];

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

      // ---- tags (P2-01): every id must belong to THIS TASK'S PROJECT'S tag registry ----
      if (Array.isArray(b.tags)) {
        const incoming = b.tags as unknown[];
        if (!incoming.every((tg) => typeof tg === "string" && UUID_RE.test(tg))) {
          throw new BadRequestException("tags must be an array of tag ids");
        }
        const uniq = Array.from(new Set(incoming as string[]));
        if (uniq.length > 0) {
          const valid = await c.query<{ id: string }>(
            `SELECT id FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])`,
            [task.projectId, uniq],
          );
          if (valid.rows.length !== uniq.length) {
            throw new BadRequestException("one or more tag ids are not in this task's project tag registry");
          }
        }
        tags = uniq;
      }

      // ---- custom fields (P2-03, D17 framework reuse) ----
      let customFields = task.customFields ?? {};
      if (b.customFields !== undefined) {
        if (typeof b.customFields !== "object" || b.customFields === null || Array.isArray(b.customFields)) {
          throw new BadRequestException("customFields must be an object");
        }
        const cfError = await validateCustomFields(c, tenantId, "pm_task", b.customFields as Record<string, unknown>);
        if (cfError) throw new BadRequestException(cfError);
        customFields = b.customFields as Record<string, unknown>;
      }

      // ---- recurrence (P2-06, design spec §8) ----
      let recurrence = task.recurrence;
      const hasRecurrenceField = Object.prototype.hasOwnProperty.call(b, "recurrence");
      if (hasRecurrenceField) recurrence = validRecurrence(b.recurrence);

      // ---- progress / status (explicit + FLAG-DRIVEN coupling) ----
      // Status is validated against the project's effective set; done coupling derives from the
      // is_done FLAG, never from string-matching the id (a renamed done status still couples).
      const statuses = await effectiveStatuses(c, task.projectId);
      const byStatusId = new Map(statuses.map((s) => [s.id, s]));
      const doneStatus = [...statuses].sort((a, z) => a.position - z.position).find((s) => s.isDone);
      if (typeof b.progress === "number") progress = Math.max(0, Math.min(100, Math.round(b.progress)));
      else if (subtasksChanged && subtasks.length > 0) progress = Math.round((subtasks.filter((s) => s.done).length / subtasks.length) * 100);
      if (typeof b.status === "string") {
        if (!byStatusId.has(b.status)) throw new BadRequestException("invalid status");
        status = b.status;
      }
      if (byStatusId.get(status)?.isDone) progress = 100;
      else if (progress >= 100 && doneStatus) status = doneStatus.id;

      // P2-06: the recurrence spawn trigger is the not-done→done EDGE, resolved
      // against the project's is_done FLAGS (never a literal id) — computed from
      // the task's status BEFORE this patch (task.status, untouched by the mutable
      // `status` working copy above) vs. its FINAL status after this patch.
      const wasDone = byStatusId.get(task.status)?.isDone ?? false;
      const isDoneNow = byStatusId.get(status)?.isDone ?? false;
      const completingNow = !wasDone && isDoneNow;

      // ---- validated scalar meta ----
      if (b.priority !== undefined && b.priority !== null && !PRIORITIES.has(String(b.priority))) throw new BadRequestException("invalid priority");
      let assignee = task.assignee;
      if (managing) {
        assignee = validAssignee(b.assignee);
        if (assignee?.responsibleId && assignee.responsibleId !== task.assignee?.responsibleId) notifyResponsible = assignee.responsibleId;
      }

      // Final (post-patch) scalar values — reused below when spawning the next
      // recurrence occurrence, so the clone carries whatever THIS patch just set
      // (e.g. completing a task and editing its title in the same call).
      const finalTitle = typeof b.title === "string" ? b.title : task.title;
      const finalDescription = typeof b.description === "string" ? b.description : task.description;
      const finalPriority = typeof b.priority === "string" ? b.priority : task.priority;
      const finalMilestoneId = Object.prototype.hasOwnProperty.call(b, "milestoneId") ? ((b.milestoneId as string) || null) : task.milestoneId;
      const finalEstimateMinutes = Object.prototype.hasOwnProperty.call(b, "estimateMinutes") ? ((b.estimateMinutes as number) ?? null) : task.estimateMinutes;

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
           tags = $18,
           custom_fields = $19,
           recurrence = CASE WHEN $20 THEN $21 ELSE recurrence END,
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
          tags,
          JSON.stringify(customFields),
          hasRecurrenceField, recurrence ? JSON.stringify(recurrence) : null,
        ],
      );
      await emitEvent(c, tenantId, "pm_task", taskId, "pm.task.updated", { status });

      // ---- recurring-task spawn (P2-06, design spec §8) ----
      // Fires ONLY on the not-done→done edge, so re-PATCHing an already-done task
      // (e.g. re-submitting the same completion) never spawns a second child — the
      // edge is false the second time because `task.status` (read under the row
      // lock above) is already the done status. A defensive second check (no
      // existing non-deleted child already spawned from this parent for the same
      // computed next due date) guards the same invariant independent of the edge,
      // in case this handler is ever called with a stale/replayed old-status read.
      if (completingNow && recurrence) {
        const next = computeNextOccurrence(task.dueDate, task.startDate, recurrence);
        if (next) {
          const existing = await c.query(
            `SELECT id FROM pm_tasks WHERE recurrence_spawned_from = $1 AND due_date = $2::date AND deleted_at IS NULL`,
            [taskId, next.dueDate],
          );
          if (!existing.rows[0]) {
            const childId = newId();
            const orderedStatuses = [...statuses].sort((a, z) => a.position - z.position);
            const firstNonDone = orderedStatuses.find((s) => !s.isDone) ?? orderedStatuses[0];
            const resetSubtasks = subtasks.map((s) => ({ ...s, done: false }));
            await c.query(
              `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, assignee, milestone_id, start_date, due_date, estimate_minutes, subtasks, tags, custom_fields, recurrence, recurrence_spawned_from, origin_site)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,$15,$16,$17,$18)`,
              [
                childId, tenantId, task.projectId, finalTitle, finalDescription,
                firstNonDone?.id ?? "todo", finalPriority,
                assignee ? JSON.stringify(assignee) : null, finalMilestoneId,
                next.startDate, next.dueDate, finalEstimateMinutes,
                JSON.stringify(resetSubtasks), tags, JSON.stringify(customFields),
                JSON.stringify(recurrence), taskId, config.originSite,
              ],
            );
            await emitEvent(c, tenantId, "pm_task", childId, "pm.task.spawned", { parentId: taskId, dueDate: next.dueDate });
            spawnedResult = { id: childId, dueDate: next.dueDate };
          }
        }
      }
      // P3-08: fan-out inputs for the follower notify below — computed under the same row
      // lock/read as everything else, but the notify() calls themselves happen AFTER commit
      // (below), matching every other notify-after-writeTenants call site in this file.
      return {
        spawned: spawnedResult,
        statusChanged: status !== task.status,
        newStatusLabel: byStatusId.get(status)?.label ?? status,
        taskTitle: finalTitle,
      };
    });
    // P3-08 fan-out dedup: assignee (this patch's reassignment) and followers (on a real
    // status change) are collected into ONE "already notified" set so a follower who is ALSO
    // the newly-reassigned responsible in this same PATCH gets exactly one notification, never
    // two. notify() itself auto-skips the actor (recipientId === actorId, verified in core/http.ts)
    // so there is no separate actor-skip needed here.
    const alreadyNotified = new Set<string>();
    if (notifyResponsible) {
      alreadyNotified.add(notifyResponsible);
      await notify(tenantId, notifyResponsible, req.principal.userId, "assignment", {
        title: "You were assigned a task", severity: "info", entityType: "task", entityId: taskId, href: `/tasks/${taskId}`,
      });
    }
    if (statusChanged) {
      const followers = await withTenants([tenantId], (c) =>
        c.query<{ user_id: string }>(`SELECT user_id FROM pm_task_followers WHERE task_id = $1`, [taskId]),
      );
      for (const { user_id: followerId } of followers.rows) {
        if (alreadyNotified.has(followerId)) continue;
        alreadyNotified.add(followerId);
        await notify(tenantId, followerId, req.principal.userId, "task_update", {
          title: `“${taskTitle}” moved to “${newStatusLabel}”`, severity: "info", entityType: "task", entityId: taskId, href: `/tasks/${taskId}`,
        });
      }
    }
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_task", taskId, {});
    if (spawned) await writeActivity(tenantId, req.principal.userId, "created", "pm_task", spawned.id, { recurrenceParentId: taskId });
    return { ok: true, spawned };
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

  // ---------------- Followers (P3-08) ----------------
  // Following is a SELF-SCOPED preference, never a client-supplied assignment: every write below
  // parameterizes user_id from req.principal.userId ONLY — the request body/params can never name
  // a different user to (un)follow on someone else's behalf. Gated on task READ (not manage/update)
  // because opting into your own notifications isn't a privileged action.
  @Get(":tenantId/pm/tasks/:taskId/followers")
  async listFollowers(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    return withTenants([tenantId], async (c) => {
      if (!(await fetchTask(c, taskId))) throw new NotFoundException("task not found");
      const rows = await c.query<{ id: string; name: string }>(
        `SELECT u.id, u.name FROM pm_task_followers f JOIN users u ON u.id = f.user_id
         WHERE f.task_id = $1 ORDER BY u.name`,
        [taskId],
      );
      return rows.rows;
    });
  }

  @Post(":tenantId/pm/tasks/:taskId/follow")
  @HttpCode(200)
  async followTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    await withTenants([tenantId], async (c) => {
      if (!(await fetchTask(c, taskId))) throw new NotFoundException("task not found");
      await c.query(
        `INSERT INTO pm_task_followers (tenant_id, task_id, user_id, origin_site) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, task_id, user_id) DO NOTHING`,
        [tenantId, taskId, req.principal.userId, config.originSite],
      );
    });
    return { ok: true };
  }

  @Delete(":tenantId/pm/tasks/:taskId/follow")
  @HttpCode(200)
  async unfollowTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "read");
    await withTenants([tenantId], async (c) => {
      if (!(await fetchTask(c, taskId))) throw new NotFoundException("task not found");
      await c.query(
        `DELETE FROM pm_task_followers WHERE tenant_id = $1 AND task_id = $2 AND user_id = $3`,
        [tenantId, taskId, req.principal.userId],
      );
    });
    return { ok: true };
  }

  // ---------------- Duplicate (P3-01) ----------------
  @Post(":tenantId/pm/tasks/:taskId/duplicate")
  @HttpCode(201)
  async duplicateTask(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("taskId") taskId: string) {
    // Gated like createTask (this IS a task creation) — the source projectId is read from the
    // DB below, never trusted from a client-supplied param, so there is nothing to authorize
    // against here beyond the source task's own tenant/id.
    await authorize(req.principal, { kind: "pm_task", tenantId, id: taskId }, "create");
    const id = newId();
    const source = await withTenants([tenantId], async (c) => {
      const task = await fetchTask(c, taskId);
      if (!task) throw new NotFoundException("task not found");
      // Reset status to the project's first-by-position NON-done status — via effectiveStatuses'
      // isDone FLAG, exactly like the recurrence-spawn path above — NEVER the literal "todo".
      const statuses = [...(await effectiveStatuses(c, task.projectId))].sort((a, z) => a.position - z.position);
      const firstNonDone = statuses.find((s) => !s.isDone) ?? statuses[0];
      const resetSubtasks = (Array.isArray(task.subtasks) ? (task.subtasks as { title: string }[]) : [])
        .map((s) => ({ id: newId(), title: s.title, done: false }));
      await c.query(
        `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, progress, assignee, milestone_id, start_date, due_date, estimate_minutes, custom_fields, recurrence, subtasks, tags, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::date, $12::date, $13, $14, $15, $16, $17, $18)`,
        [
          id, tenantId, task.projectId, `${task.title} (copy)`, task.description,
          firstNonDone?.id ?? "todo", task.priority, 0,
          task.assignee ? JSON.stringify(task.assignee) : null, task.milestoneId,
          task.startDate, task.dueDate, task.estimateMinutes,
          JSON.stringify(task.customFields ?? {}), task.recurrence ? JSON.stringify(task.recurrence) : null,
          JSON.stringify(resetSubtasks), task.tags ?? [], config.originSite,
        ],
      );
      // Comments/time/suggestions/dependsOn are deliberately dropped: not copied, not referenced
      // (depends_on defaults to '{}' — the INSERT above never sets it).
      await emitEvent(c, tenantId, "pm_task", id, "pm.task.duplicated", { sourceTaskId: taskId, projectId: task.projectId });
      return task;
    });
    if (source.assignee?.responsibleId) {
      await notify(tenantId, source.assignee.responsibleId, req.principal.userId, "assignment", {
        title: "You were assigned a task", severity: "info", entityType: "task", entityId: id, href: `/tasks/${id}`,
      });
    }
    await writeActivity(tenantId, req.principal.userId, "created", "pm_task", id, { duplicatedFrom: taskId });
    return { id };
  }

  // ---------------- Duplicate project (P3-02) ----------------
  // Clones a project + its per-project structure (statuses, tags, milestones, docs) and EVERY task
  // into a brand-new project in ONE tenant-scoped transaction. Correctness hinges on THREE id-remap
  // maps built while copying — tag old→new, milestone old→new, task old→new — so that NO source-project
  // id ever survives into the copy: each task's tags are rewritten through the tag map, its milestone_id
  // through the milestone map, and (in a SECOND pass, once every new task id is known) its depends_on
  // through the task map with any id that didn't copy DROPPED. Owner/pm_project_meta, task assignees,
  // comments, time logs and tracker suggestions are deliberately NOT carried.
  @Post(":tenantId/pm/projects/:projectId/duplicate")
  @HttpCode(201)
  async duplicateProject(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { name?: string },
  ) {
    const name = b?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const newProjectId = newId();
    await withTenants([tenantId], async (c) => {
      // Source project. RLS scopes to this tenant, so a foreign/forged id reads as absent → 404,
      // never a cross-tenant read or write (the cross-tenant probe relies on exactly this).
      const src = await c.query<{ clientId: string | null; isInternal: boolean; departmentId: string | null; customFields: Record<string, unknown> }>(
        `SELECT client_id AS "clientId", is_internal AS "isInternal", department_id AS "departmentId", custom_fields AS "customFields"
         FROM projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      if (!src.rows[0]) throw new NotFoundException("project not found");
      const s = src.rows[0];

      // 1) Base project row: name from input, status reset to 'active', NO due date, owner NOT copied.
      //    Structural identity (client, internal flag, department, D17 custom-field values) is kept —
      //    none of those are source-PROJECT ids, so carrying them leaks nothing. (`projects` has no
      //    description column in this schema; department_id is the only descriptive field to carry.)
      await c.query(
        `INSERT INTO projects (id, tenant_id, client_id, is_internal, name, status, department_id, custom_fields, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
        [newProjectId, tenantId, s.clientId, s.isInternal, name, s.departmentId, JSON.stringify(s.customFields ?? {}), config.originSite],
      );

      // 2) Statuses — copied VERBATIM (same slug ids; per-project scoped, so reuse is safe). Only
      //    MATERIALIZED rows exist to copy; an unmaterialized (default) project copies ZERO rows and
      //    the clone reads the same 4 synthesized defaults, so boards render identically either way.
      await c.query(
        `INSERT INTO pm_project_statuses (id, tenant_id, project_id, position, label, color, is_done, is_blocked, wip_limit, origin_site)
         SELECT id, tenant_id, $2, position, label, color, is_done, is_blocked, wip_limit, $3
         FROM pm_project_statuses WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId, newProjectId, config.originSite],
      );

      // 3) Tags — NEW uuids; build old-id→new-id (and label→new-id) maps for task-tag remapping.
      const tagMap = new Map<string, string>();
      const tagLabelMap = new Map<string, string>();
      const srcTags = await c.query<TagRow>(
        `SELECT id, label, color FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
        [projectId],
      );
      for (const t of srcTags.rows) {
        const nid = newId();
        tagMap.set(t.id, nid);
        tagLabelMap.set(t.label, nid);
        await c.query(
          `INSERT INTO pm_project_tags (id, tenant_id, project_id, label, color, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
          [nid, tenantId, newProjectId, t.label, t.color, config.originSite],
        );
      }

      // 4) Milestones — NEW ids (map old→new); status reset to 'open', dates preserved.
      const msMap = new Map<string, string>();
      const srcMs = await c.query<{ id: string; name: string; dueDate: string | null }>(
        `SELECT id, name, to_char(due_date, 'YYYY-MM-DD') AS "dueDate" FROM pm_milestones WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      for (const m of srcMs.rows) {
        const nid = newId();
        msMap.set(m.id, nid);
        await c.query(
          `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site) VALUES ($1, $2, $3, $4, $5::date, 'open', $6)`,
          [nid, tenantId, newProjectId, m.name, m.dueDate, config.originSite],
        );
      }

      // 5) Docs — author is the duplicating user (this is a fresh copy authored now). Set-based
      //    insert with server-generated uuids; no source id survives.
      await c.query(
        `INSERT INTO pm_docs (id, tenant_id, project_id, title, body, author_id, origin_site)
         SELECT gen_random_uuid(), tenant_id, $2, title, body, $3, $4
         FROM pm_docs WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId, newProjectId, req.principal.userId, config.originSite],
      );

      // 6) Tasks — pass 1: copy each task, building the old→new task-id map. Per P3-01 copy semantics
      //    EXCEPT: assignee/owner CLEARED, status reset to the clone's first-by-position NON-done
      //    status (via effectiveStatuses' isDone FLAG, never a literal id), progress 0, subtasks reset
      //    (fresh ids, done=false), tags remapped through the tag map, milestone_id through the
      //    milestone map. depends_on is left empty here and rewritten in pass 2. Comments/time/
      //    suggestions are not copied; recurrence_spawned_from is NOT carried (it would be a
      //    source-project task id). Task titles are kept VERBATIM — the PROJECT is the "(copy)", so
      //    suffixing every task title (as the single-task P3-01 duplicate does) would be wrong here.
      const statuses = [...(await effectiveStatuses(c, newProjectId))].sort((a, z) => a.position - z.position);
      const firstNonDone = statuses.find((st) => !st.isDone) ?? statuses[0];
      const taskMap = new Map<string, string>();
      const srcTasks = await c.query<TaskRow>(`${TASK_SELECT} AND t.project_id = $1 ORDER BY t.created_at`, [projectId]);
      for (const t of srcTasks.rows) {
        const nid = newId();
        taskMap.set(t.id, nid);
        const resetSubtasks = (Array.isArray(t.subtasks) ? (t.subtasks as { title: string }[]) : [])
          .map((sub) => ({ id: newId(), title: sub.title, done: false }));
        const remappedTags = (t.tags ?? []).map((tg) => tagMap.get(tg)).filter((x): x is string => !!x);
        const remappedMilestone = t.milestoneId ? (msMap.get(t.milestoneId) ?? null) : null;
        await c.query(
          `INSERT INTO pm_tasks (id, tenant_id, project_id, title, description, status, priority, progress, assignee, milestone_id, start_date, due_date, estimate_minutes, custom_fields, recurrence, subtasks, tags, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, $8, $9::date, $10::date, $11, $12, $13, $14, $15, $16)`,
          [
            nid, tenantId, newProjectId, t.title, t.description,
            firstNonDone?.id ?? "todo", t.priority, remappedMilestone,
            t.startDate, t.dueDate, t.estimateMinutes,
            JSON.stringify(t.customFields ?? {}), t.recurrence ? JSON.stringify(t.recurrence) : null,
            JSON.stringify(resetSubtasks), remappedTags, config.originSite,
          ],
        );
      }

      // 7) Pass 2 — rewrite depends_on now that every new task id is known: map each source dep id
      //    through the task map, DROPPING any that didn't copy (a dep on a task outside this project,
      //    or a soft-deleted one). Guarantees no source-project task id survives in the copy.
      for (const t of srcTasks.rows) {
        const remappedDeps = (t.dependsOn ?? []).map((d) => taskMap.get(d)).filter((x): x is string => !!x);
        if (remappedDeps.length > 0) {
          await c.query(`UPDATE pm_tasks SET depends_on = $2 WHERE id = $1`, [taskMap.get(t.id), remappedDeps]);
        }
      }

      await emitEvent(c, tenantId, "pm_project", newProjectId, "pm.project.duplicated", { sourceProjectId: projectId, name });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_project", newProjectId, { duplicatedFrom: projectId, name });
    return { id: newProjectId };
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

  // ---------------- Tags (P2-01) ----------------
  @Get(":tenantId/pm/projects/:projectId/tags")
  async listTags(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query<TagRow>(
          `SELECT id, label, color FROM pm_project_tags WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
          [projectId],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/projects/:projectId/tags")
  @HttpCode(201)
  async createTag(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { label?: string; color?: string },
  ) {
    const label = b?.label?.trim();
    if (!label) throw new BadRequestException("label required");
    if (!b?.color || !TAG_COLORS.has(b.color)) throw new BadRequestException("invalid color");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_project_tags (id, tenant_id, project_id, label, color, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, projectId, label, b.color, config.originSite],
      );
      await emitEvent(c, tenantId, "pm_project_tag", id, "pm.tag.created", { projectId, label, color: b.color });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_project_tag", id, { label });
    return { id, label, color: b.color };
  }

  @Patch(":tenantId/pm/projects/:projectId/tags/:tagId")
  @HttpCode(200)
  async patchTag(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("tagId") tagId: string,
    @Body() b: { label?: string; color?: string },
  ) {
    if (b?.color !== undefined && !TAG_COLORS.has(b.color)) throw new BadRequestException("invalid color");
    if (b?.label !== undefined && !b.label.trim()) throw new BadRequestException("label cannot be empty");
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const updated = await withTenants([tenantId], async (c) => {
      const res = await c.query<TagRow>(
        `UPDATE pm_project_tags SET label = COALESCE($3, label), color = COALESCE($4, color), updated_at = now()
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL RETURNING id, label, color`,
        [tagId, projectId, b?.label?.trim() || null, b?.color ?? null],
      );
      if (!res.rows[0]) throw new NotFoundException("tag not found");
      await emitEvent(c, tenantId, "pm_project_tag", tagId, "pm.tag.updated", { projectId });
      return res.rows[0];
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_project_tag", tagId);
    return updated;
  }

  @Delete(":tenantId/pm/projects/:projectId/tags/:tagId")
  async deleteTag(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("tagId") tagId: string,
    @Query("force") force?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const result = await withTenants([tenantId], async (c) => {
      const tag = await fetchProjectTag(c, projectId, tagId);
      if (!tag) throw new NotFoundException("tag not found");
      const usage = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL AND $2 = ANY(tags)`,
        [projectId, tagId],
      );
      const inUse = Number(usage.rows[0].n);
      if (inUse > 0 && force !== "1") return { blocked: true as const, inUse };
      if (inUse > 0) {
        await c.query(
          `UPDATE pm_tasks SET tags = array_remove(tags, $1), updated_at = now()
           WHERE project_id = $2 AND deleted_at IS NULL AND $1 = ANY(tags)`,
          [tagId, projectId],
        );
      }
      await c.query(`UPDATE pm_project_tags SET deleted_at = now() WHERE id = $1`, [tagId]);
      await emitEvent(c, tenantId, "pm_project_tag", tagId, "pm.tag.deleted", { projectId, strippedFrom: inUse });
      return { blocked: false as const, inUse };
    });
    if (result.blocked) {
      reply.status(409).send({ inUse: result.inUse });
      return;
    }
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_project_tag", tagId, { strippedFrom: result.inUse });
    reply.status(200).send({ ok: true });
  }

  // ---------------- Statuses (P2-04, pm-console-ux-design-spec §7) ----------------
  @Get(":tenantId/pm/projects/:projectId/statuses")
  async listStatuses(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      return (await effectiveStatuses(c, projectId)).map(toProjectStatus);
    });
  }

  @Post(":tenantId/pm/projects/:projectId/statuses")
  @HttpCode(201)
  async createStatus(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Body() b: { label?: string; color?: string; isDone?: boolean; isBlocked?: boolean; wipLimit?: number | null },
  ) {
    const label = b?.label?.trim();
    if (!label) throw new BadRequestException("label required");
    const color = typeof b?.color === "string" ? b.color.trim() : "";
    if (!color) throw new BadRequestException("color required");
    const isDone = !!b?.isDone;
    const isBlocked = !!b?.isBlocked;
    const wipLimit = validWipLimit(b?.wipLimit);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const created = await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      // First editor write for the project materializes the 4 defaults so the synthesized set is kept.
      await ensureMaterialized(c, tenantId, projectId);
      const taken = new Set(
        (await c.query<{ id: string }>(`SELECT id FROM pm_project_statuses WHERE project_id = $1`, [projectId])).rows.map((r) => r.id),
      );
      const id = uniqueStatusId(slugifyStatusId(label), taken);
      const posRow = await c.query<{ max: number | null }>(
        `SELECT MAX(position) AS max FROM pm_project_statuses WHERE project_id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const position = (posRow.rows[0].max ?? -1) + 1;
      await c.query(
        `INSERT INTO pm_project_statuses (id, tenant_id, project_id, position, label, color, is_done, is_blocked, wip_limit, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, tenantId, projectId, position, label, color, isDone, isBlocked, wipLimit, config.originSite],
      );
      await emitEvent(c, tenantId, "pm_project_status", projectId, "pm.status.created", { statusId: id, label });
      return { id, position, label, color, isDone, isBlocked, wipLimit } as StatusRow;
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_project_status", projectId, { statusId: created.id, label });
    return toProjectStatus(created);
  }

  @Patch(":tenantId/pm/projects/:projectId/statuses/:sid")
  @HttpCode(200)
  async patchStatus(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("sid") sid: string,
    @Body() b: { label?: string; color?: string; isDone?: boolean; isBlocked?: boolean; wipLimit?: number | null; position?: number },
  ) {
    const label = b?.label !== undefined ? String(b.label).trim() : null;
    if (b?.label !== undefined && !label) throw new BadRequestException("label cannot be empty");
    const color = b?.color !== undefined ? String(b.color).trim() : null;
    if (b?.color !== undefined && !color) throw new BadRequestException("color cannot be empty");
    const isDone = Object.prototype.hasOwnProperty.call(b ?? {}, "isDone") ? !!b.isDone : null;
    const isBlocked = Object.prototype.hasOwnProperty.call(b ?? {}, "isBlocked") ? !!b.isBlocked : null;
    const hasWip = Object.prototype.hasOwnProperty.call(b ?? {}, "wipLimit");
    const wipLimit = hasWip ? validWipLimit(b.wipLimit) : null;
    const position = typeof b?.position === "number" && Number.isInteger(b.position) && b.position >= 0 ? b.position : null;
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const updated = await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await ensureMaterialized(c, tenantId, projectId);
      const res = await c.query<StatusRow>(
        `UPDATE pm_project_statuses SET
           label = COALESCE($3, label),
           color = COALESCE($4, color),
           is_done = COALESCE($5, is_done),
           is_blocked = COALESCE($6, is_blocked),
           wip_limit = CASE WHEN $7 THEN $8 ELSE wip_limit END,
           position = COALESCE($9, position),
           updated_at = now()
         WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL
         RETURNING id, position, label, color, is_done AS "isDone", is_blocked AS "isBlocked", wip_limit AS "wipLimit"`,
        [sid, projectId, label, color, isDone, isBlocked, hasWip, wipLimit, position],
      );
      if (!res.rows[0]) throw new NotFoundException("status not found");
      await emitEvent(c, tenantId, "pm_project_status", projectId, "pm.status.updated", { statusId: sid });
      return res.rows[0];
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_project_status", projectId, { statusId: sid });
    return toProjectStatus(updated);
  }

  @Delete(":tenantId/pm/projects/:projectId/statuses/:sid")
  async deleteStatus(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Param("sid") sid: string,
    @Query("moveTo") moveTo?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    const result = await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await ensureMaterialized(c, tenantId, projectId);
      const target = await c.query(`SELECT 1 FROM pm_project_statuses WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`, [sid, projectId]);
      if (!target.rows[0]) throw new NotFoundException("status not found");
      const usage = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM pm_tasks WHERE project_id = $1 AND deleted_at IS NULL AND status = $2`,
        [projectId, sid],
      );
      const inUse = Number(usage.rows[0].n);
      if (inUse > 0) {
        if (!moveTo) return { blocked: true as const, inUse };
        if (moveTo === sid) throw new BadRequestException("moveTo must be a different status");
        const dest = await c.query(`SELECT 1 FROM pm_project_statuses WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`, [moveTo, projectId]);
        if (!dest.rows[0]) throw new BadRequestException("moveTo status not found");
        await c.query(
          `UPDATE pm_tasks SET status = $1, updated_at = now() WHERE project_id = $2 AND deleted_at IS NULL AND status = $3`,
          [moveTo, projectId, sid],
        );
      }
      await c.query(`UPDATE pm_project_statuses SET deleted_at = now() WHERE id = $1 AND project_id = $2`, [sid, projectId]);
      await emitEvent(c, tenantId, "pm_project_status", projectId, "pm.status.deleted", { statusId: sid, movedTo: moveTo ?? null, reassigned: inUse });
      return { blocked: false as const, inUse };
    });
    if (result.blocked) {
      reply.status(400).send({ inUse: result.inUse });
      return;
    }
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_project_status", projectId, { statusId: sid, reassigned: result.inUse });
    reply.status(200).send({ ok: true });
  }

  // ---------------- Burndown (P2-07, pm-console-ux-design-spec §4, §0 D-2) ----------------
  @Get(":tenantId/pm/projects/:projectId/burndown")
  async getBurndown(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    if (from !== undefined && !DATE_RE.test(from)) throw new BadRequestException("from must be a YYYY-MM-DD date");
    if (to !== undefined && !DATE_RE.test(to)) throw new BadRequestException("to must be a YYYY-MM-DD date");
    return withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      // Lazy idempotent upsert-on-read (D-2): every read keeps TODAY's row current, so the
      // series is never stale even if the nightly job hasn't reached this project yet.
      await upsertTodaySnapshot(c, tenantId, projectId);
      const rows = await c.query<{ date: string; open: number; done: number; avgProgress: number }>(
        `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, open_count AS open, done_count AS done,
                avg_progress AS "avgProgress"
         FROM pm_progress_snapshots
         WHERE project_id = $1
           AND ($2::date IS NULL OR snapshot_date >= $2::date)
           AND ($3::date IS NULL OR snapshot_date <= $3::date)
         ORDER BY snapshot_date ASC`,
        [projectId, from || null, to || null],
      );
      // Empty series (no snapshots in range) returns [], never an error.
      return rows.rows;
    });
  }

  // ---------------- Flow (P3-05) ----------------
  // Byte-parallel to getBurndown above: same read-gate, same lazy upsert-on-read, same
  // from/to validation and empty-range behavior — just projects status_counts instead of
  // open/done/avgProgress off the same snapshot row.
  @Get(":tenantId/pm/projects/:projectId/flow")
  async getFlow(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("projectId") projectId: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    if (from !== undefined && !DATE_RE.test(from)) throw new BadRequestException("from must be a YYYY-MM-DD date");
    if (to !== undefined && !DATE_RE.test(to)) throw new BadRequestException("to must be a YYYY-MM-DD date");
    return withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      // Lazy idempotent upsert-on-read (D-2, mirrored from burndown): keeps TODAY's row current.
      await upsertTodaySnapshot(c, tenantId, projectId);
      const rows = await c.query<{ date: string; counts: Record<string, number> }>(
        `SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS date, status_counts AS counts
         FROM pm_progress_snapshots
         WHERE project_id = $1
           AND ($2::date IS NULL OR snapshot_date >= $2::date)
           AND ($3::date IS NULL OR snapshot_date <= $3::date)
         ORDER BY snapshot_date ASC`,
        [projectId, from || null, to || null],
      );
      // Empty series (no snapshots in range) returns [], never an error.
      return rows.rows;
    });
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
  // "version" on every doc projection below is the current/max row in pm_doc_versions (P3-10),
  // COALESCEd to 1 for a doc with no version rows yet (any doc written before this migration —
  // synth-on-read, same spirit as effectiveStatuses(), rather than a backfill DML: a pre-existing
  // doc's CURRENT content IS its version 1 in every observable sense).
  @Get(":tenantId/pm/projects/:projectId/docs")
  async listDocs(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT d.id, d.project_id AS "projectId", d.title, d.body, u.name AS author, d.updated_at AS "updatedAt",
                  COALESCE((SELECT MAX(version) FROM pm_doc_versions WHERE doc_id = d.id), 1) AS version
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
    const body = b.body ?? "";
    await withTenants([tenantId], async (c) => {
      if (!(await projectExists(c, projectId))) throw new NotFoundException("project not found");
      await c.query(
        `INSERT INTO pm_docs (id, tenant_id, project_id, title, body, author_id, origin_site) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, projectId, title, body, req.principal.userId, config.originSite],
      );
      // P3-10: the creation write IS version 1 — every doc's history starts here.
      await appendDocVersion(c, tenantId, id, 1, title, body, req.principal.userId);
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_doc", id, { title });
    return { id };
  }

  @Get(":tenantId/pm/projects/:projectId/docs/:docId")
  async getDoc(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("projectId") projectId: string, @Param("docId") docId: string) {
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT d.id, d.project_id AS "projectId", d.title, d.body, u.name AS author, d.updated_at AS "updatedAt",
                COALESCE((SELECT MAX(version) FROM pm_doc_versions WHERE doc_id = d.id), 1) AS version
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
      // Row-lock FIRST (P3-10): a second concurrent PATCH on the SAME doc blocks here until this
      // transaction commits its version append, then computes MAX(version)+1 against the
      // already-committed row — so two racing PATCHes can never both compute the same next
      // version number (the UNIQUE(tenant_id, doc_id, version) constraint is the hard backstop).
      const lock = await c.query<{ title: string; body: string }>(
        `SELECT title, body FROM pm_docs WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [docId, projectId],
      );
      const current = lock.rows[0];
      if (!current) throw new NotFoundException("doc not found");
      const nextTitle = typeof b?.title === "string" ? b.title : current.title;
      const nextBody = typeof b?.body === "string" ? b.body : current.body;
      // A true no-op PATCH (both title and body unchanged, whether omitted or resubmitted
      // identical) appends NOTHING to history — just returns, per the P3-10 contract.
      if (nextTitle === current.title && nextBody === current.body) return;
      await c.query(
        `UPDATE pm_docs SET title = $3, body = $4, updated_at = now() WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [docId, projectId, nextTitle, nextBody],
      );
      await appendDocVersion(c, tenantId, docId, null, nextTitle, nextBody, req.principal.userId);
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_doc", docId);
    return { ok: true };
  }

  // ---------------- Doc versions (P3-10) ----------------
  @Get(":tenantId/pm/docs/:docId/versions")
  async listDocVersions(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("docId") docId: string) {
    const projectId = await resolveDocProjectId(tenantId, docId);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    return withTenants([tenantId], (c) =>
      c
        .query(
          `SELECT v.version, v.author_id AS "authorId", u.name AS "authorName", v.created_at AS "createdAt"
           FROM pm_doc_versions v LEFT JOIN users u ON u.id = v.author_id
           WHERE v.doc_id = $1 ORDER BY v.version ASC`,
          [docId],
        )
        .then((r) => r.rows),
    );
  }

  @Get(":tenantId/pm/docs/:docId/versions/:v")
  async getDocVersion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("docId") docId: string, @Param("v") v: string) {
    const version = parseVersion(v);
    const projectId = await resolveDocProjectId(tenantId, docId);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query(
        `SELECT v.version, v.title, v.body, u.name AS "authorName", v.created_at AS "createdAt"
         FROM pm_doc_versions v LEFT JOIN users u ON u.id = v.author_id WHERE v.doc_id = $1 AND v.version = $2`,
        [docId, version],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("doc version not found");
    return rows.rows[0];
  }

  @Post(":tenantId/pm/docs/:docId/versions/:v/restore")
  @HttpCode(200)
  async restoreDocVersion(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("docId") docId: string, @Param("v") v: string) {
    const version = parseVersion(v);
    const projectId = await resolveDocProjectId(tenantId, docId);
    await authorize(req.principal, { kind: "pm_project", tenantId, id: projectId }, "manage");
    await withTenants([tenantId], async (c) => {
      // Same row-lock pattern as patchDoc — serializes against any concurrent patch/restore on
      // this doc so the appended version number can never collide.
      const lock = await c.query(`SELECT 1 FROM pm_docs WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL FOR UPDATE`, [docId, projectId]);
      if (!lock.rows[0]) throw new NotFoundException("doc not found");
      const target = await c.query<{ title: string; body: string }>(
        `SELECT title, body FROM pm_doc_versions WHERE doc_id = $1 AND version = $2`,
        [docId, version],
      );
      if (!target.rows[0]) throw new NotFoundException("doc version not found");
      const { title, body } = target.rows[0];
      // History is APPEND-ONLY: this never rewrites version `v` (or any other row) — it sets the
      // doc row to v's content and appends a BRAND-NEW version authored by the restorer.
      await c.query(
        `UPDATE pm_docs SET title = $3, body = $4, updated_at = now() WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [docId, projectId, title, body],
      );
      await appendDocVersion(c, tenantId, docId, null, title, body, req.principal.userId);
    });
    await writeActivity(tenantId, req.principal.userId, "restored", "pm_doc", docId, { toVersion: version });
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
      // FLAG-DRIVEN: the "complete" target is the first is_done status; the "in-flight" target is
      // the first non-done/non-blocked status past the initial column. No literal id string-match.
      const trackerStatuses = [...(await effectiveStatuses(c, task.projectId))].sort((a, z) => a.position - z.position);
      const doneTarget = trackerStatuses.find((s) => s.isDone);
      const firstStatus = trackerStatuses[0];
      const inFlightTarget = trackerStatuses.find((s) => !s.isDone && !s.isBlocked && s.id !== firstStatus?.id);
      let computedStatus = task.status;
      if (computedProgress >= 100 && doneTarget) computedStatus = doneTarget.id;
      else if (computedProgress > 0 && task.status === firstStatus?.id && inFlightTarget) computedStatus = inFlightTarget.id;
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
      await notify(tenantId, result.responsibleId, req.principal.userId, "tracker", {
        title: "AI Tracker updated your task", severity: "info", entityType: "task", entityId: taskId, href: `/tasks/${taskId}`,
      });
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
      // Apply the proposal, honouring the same FLAG-DRIVEN done↔100 coupling as PATCH.
      const task = await c.query<{ project_id: string }>(`SELECT project_id FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`, [s.task_id]);
      if (!task.rows[0]) throw new NotFoundException("task not found");
      const statuses = await effectiveStatuses(c, task.rows[0].project_id);
      const doneStatus = [...statuses].sort((a, z) => a.position - z.position).find((x) => x.isDone);
      if (s.kind === "progress") {
        const p = Math.max(0, Math.min(100, Math.round(Number(s.proposed) || 0)));
        const setDone = p >= 100 && !!doneStatus;
        await c.query(
          `UPDATE pm_tasks SET progress = $2, status = CASE WHEN $3 THEN $4 ELSE status END, updated_at = now() WHERE id = $1`,
          [s.task_id, p, setDone, doneStatus?.id ?? null],
        );
      } else {
        const proposed = statuses.find((x) => x.id === s.proposed);
        if (!proposed) throw new BadRequestException("suggestion has invalid status");
        await c.query(
          `UPDATE pm_tasks SET status = $2, progress = CASE WHEN $3 THEN 100 ELSE progress END, updated_at = now() WHERE id = $1`,
          [s.task_id, s.proposed, proposed.isDone],
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

  // ---------------- Templates (P3-01) ----------------
  // Tenant-scoped (not project-scoped), manage-gated like milestones/docs/tags. `kind` is
  // immutable post-creation — PATCH validates `payload` against the EXISTING row's kind, read
  // from the DB, never re-derived from the request body.
  @Get(":tenantId/pm/templates")
  async listTemplates(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("kind") kind?: string) {
    if (kind !== undefined && !TEMPLATE_KINDS.has(kind as TemplateKind)) throw new BadRequestException("invalid kind");
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    return withTenants([tenantId], (c) =>
      c
        .query<{ id: string; kind: string; name: string; payload: unknown; updatedAt: string }>(
          `SELECT id, kind, name, payload, updated_at AS "updatedAt" FROM pm_templates
           WHERE deleted_at IS NULL ${kind ? "AND kind = $1" : ""} ORDER BY name`,
          kind ? [kind] : [],
        )
        .then((r) => r.rows),
    );
  }

  @Post(":tenantId/pm/templates")
  @HttpCode(201)
  async createTemplate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() b: { kind?: string; name?: string; payload?: unknown },
  ) {
    if (typeof b?.kind !== "string" || !TEMPLATE_KINDS.has(b.kind as TemplateKind)) throw new BadRequestException("invalid kind");
    const name = b?.name?.trim();
    if (!name) throw new BadRequestException("name required");
    const payload = validateTemplatePayload(b.kind, b.payload);
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    const id = newId();
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO pm_templates (id, tenant_id, kind, name, payload, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, tenantId, b.kind, name, JSON.stringify(payload), config.originSite],
      );
      await emitEvent(c, tenantId, "pm_template", id, "pm.template.created", { kind: b.kind, name });
    });
    await writeActivity(tenantId, req.principal.userId, "created", "pm_template", id, { kind: b.kind, name });
    return { id, kind: b.kind, name, payload };
  }

  @Patch(":tenantId/pm/templates/:id")
  @HttpCode(200)
  async patchTemplate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() b: { name?: string; payload?: unknown },
  ) {
    if (b?.name !== undefined && !b.name.trim()) throw new BadRequestException("name cannot be empty");
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    const updated = await withTenants([tenantId], async (c) => {
      const existing = await c.query<{ kind: string }>(`SELECT kind FROM pm_templates WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!existing.rows[0]) throw new NotFoundException("template not found");
      let payloadJson: string | null = null;
      if (b?.payload !== undefined) {
        const payload = validateTemplatePayload(existing.rows[0].kind, b.payload);
        payloadJson = JSON.stringify(payload);
      }
      const res = await c.query<{ id: string; kind: string; name: string; payload: unknown }>(
        `UPDATE pm_templates SET name = COALESCE($2, name), payload = COALESCE($3::jsonb, payload), updated_at = now()
         WHERE id = $1 AND deleted_at IS NULL RETURNING id, kind, name, payload`,
        [id, b?.name?.trim() || null, payloadJson],
      );
      await emitEvent(c, tenantId, "pm_template", id, "pm.template.updated", {});
      return res.rows[0];
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "pm_template", id);
    return updated;
  }

  @Delete(":tenantId/pm/templates/:id")
  @HttpCode(200)
  async deleteTemplate(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "manage");
    await withTenants([tenantId], async (c) => {
      const res = await c.query(`UPDATE pm_templates SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (res.rowCount === 0) throw new NotFoundException("template not found");
      await emitEvent(c, tenantId, "pm_template", id, "pm.template.deleted", {});
    });
    await writeActivity(tenantId, req.principal.userId, "deleted", "pm_template", id);
    return { ok: true };
  }
}
