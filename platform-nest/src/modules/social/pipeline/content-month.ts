// SCP-1n — the CONTENT-MONTH PM task of a cycle (FRONTEND-BFF-CONTRACT §63.13), the task half. One PM task per cycle, in the engagement's project
// (`social_engagements.project_id`), found again by `pm_tasks.linked_type = 'social_cycle'` + `linked_id = <cycle>` (migration 202610271410), never
// by its title. Its progress, done and reopen are the pipeline's own write (`content-month-progress.ts`); this file makes and keeps the task.
//
// What it writes:
//   - title "<Month YYYY> content" ("March 2027 content"), `due_date` the cycle's `ready_by`, the Ball and Responsible on the engagement's officer.
//   - created through the PM module's own `createPmTaskInTx` (the seq allocation, the assignee dual-write and the `pm.task.created` event), updated
//     through its `updateLinkedTaskScheduleInTx` (the same dual-write and the assignment ledger as a PATCH). Never raw SQL on the assignee.
//   - an engagement with no project gets NO task, and the answer says why (`reason: "no_project"`; `project_not_found` when its project was deleted).
//   - re-running updates (due date, officer), never duplicates: the partial UNIQUE on (tenant_id, linked_id) for the cycle kind is the backstop, and
//     `PUT cycles` upserts the cycle row first, so two concurrent runs for one cycle queue on that row.
//
// A caller-owned `withTenants([tenantId], fn, { modules: ["social"] })` client (the engagement is a third-walled row). `pm_tasks` keeps the plain tenant wall.
import type { PoolClient } from "pg";
import { createPmTaskInTx, normalizePmTaskInput, updateLinkedTaskScheduleInTx } from "../../pm/pm.controller";
import { declareSocialModuleScope } from "../module-scope";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** PURE. "2027-03" is "March 2027 content". */
export function contentMonthTitle(month: string): string {
  const y = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  return `${MONTH_NAMES[m - 1] ?? month.slice(5, 7)} ${y} content`;
}

/** What `PUT cycles` says about one row's task: its id, or why there is none. */
export interface ContentMonthTaskResult {
  taskId: string | null;
  reason: "no_project" | "project_not_found" | null;
  created: boolean;
}

export interface ContentMonthCycle {
  tenantId: string;
  cycleId: string;
  engagementId: string;
  /** `YYYY-MM`. */
  month: string;
  deadline: string;
  readyBy: string;
  actorId: string | null;
}

/** The live content-month task of a cycle, locked, or null. */
async function findTask(c: PoolClient, tenantId: string, cycleId: string): Promise<{ id: string } | null> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM pm_tasks WHERE tenant_id = $1 AND linked_type = 'social_cycle' AND linked_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [tenantId, cycleId],
  );
  return rows[0] ?? null;
}

/**
 * Called once for every cycle `PUT cycles` writes, inside the same transaction, after the cycle row is written. Creates the content-month task, or
 * updates its due date and Ball when it exists. Never throws for "no project": it answers the reason instead.
 */
export async function syncContentMonthTask(c: PoolClient, cycle: ContentMonthCycle): Promise<ContentMonthTaskResult> {
  await declareSocialModuleScope(c);
  const eng = await c.query<{ project_id: string | null; project_live: boolean; owner_id: string | null; officer_name: string | null }>(
    `SELECT e.project_id::text AS project_id,
            EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = e.tenant_id AND p.id = e.project_id AND p.deleted_at IS NULL) AS project_live,
            e.owner_id::text AS owner_id, u.name AS officer_name
       FROM social_engagements e
       LEFT JOIN users u ON u.id = e.owner_id
      WHERE e.tenant_id = $1 AND e.id = $2 AND e.deleted_at IS NULL`,
    [cycle.tenantId, cycle.engagementId],
  );
  const e = eng.rows[0];
  if (!e || !e.project_id) return { taskId: null, reason: "no_project", created: false };
  if (!e.project_live) return { taskId: null, reason: "project_not_found", created: false };

  // The Ball and the Responsible are both the officer: the task is theirs to carry through the month.
  const assignee = e.owner_id
    ? { kind: "person" as const, refId: e.owner_id, refName: e.officer_name ?? e.owner_id, responsibleId: e.owner_id, responsibleName: e.officer_name ?? e.owner_id }
    : undefined;
  const title = contentMonthTitle(cycle.month);

  const existing = await findTask(c, cycle.tenantId, cycle.cycleId);
  if (existing) {
    await updateLinkedTaskScheduleInTx(c, cycle.tenantId, cycle.actorId, existing.id, { title, dueDate: cycle.readyBy, assignee });
    return { taskId: existing.id, reason: null, created: false };
  }
  const n = normalizePmTaskInput({ projectId: e.project_id, title, dueDate: cycle.readyBy, assignee });
  const { id } = await createPmTaskInTx(c, cycle.tenantId, cycle.actorId, { ...n, link: { type: "social_cycle", id: cycle.cycleId } });
  return { taskId: id, reason: null, created: true };
}

/**
 * The cycle's `ready_by` moved (the buffer changed, or the nightly recompute): the content-month task's due date follows. A cycle with no task
 * (its engagement has no project, or it was planned before SCP-1n) is left alone. Same transaction as the cycle row's own update.
 */
export async function pushReadyByToContentMonthTask(
  c: PoolClient, tenantId: string, cycleId: string, readyBy: string, actorId: string | null,
): Promise<void> {
  const task = await findTask(c, tenantId, cycleId);
  if (task) await updateLinkedTaskScheduleInTx(c, tenantId, actorId, task.id, { dueDate: readyBy });
}
