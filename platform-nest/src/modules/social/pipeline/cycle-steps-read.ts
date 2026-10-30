// SCP-5f, the READS of the monthly cycle's step tasks (FRONTEND-BFF-CONTRACT §63.27.4). Read only: this file never writes a task, a
// post or a cycle, and takes no row lock; the step tasks' writes and their lock order are `cycle-steps.ts`'s.
//
//   `GET cycles/:cycleId/health`   `steps` (+ `stepsReason`), from `readCycleSteps` + `composeCycleSteps`
//   `GET team`                     the needs-attention kind `cycle_step_late`, from `readLateCycleSteps` (team-data.ts) + `lateStepAttention`
//
// A step's state is its PM TASK's state (found by its link: `linked_type = 'social_cycle_step'`, `linked_id` the cycle, `linked_step` the
// step key, never by title): done when the task's status is a done status of its project, `progress` the task's, the due date the task's.
// So a step closed by hand shows as done and a reopened one as open, exactly as PM's board does. A cycle made before SCP-5f (a project, but
// no step task yet) lists the rules' steps with `taskId: null`, no due date and nothing done, so the strip can say "not made yet".
//
// WHO HOLDS A STEP. The Ball and the Responsible are the officer on every step (§63.27.3), so an open step's holder is the ROLE "officer",
// worded `HOLDER_LABELS.officer`: a role word, never a person (the section is the same for every reader, §63.19). A done step has no holder.
import type { PoolClient } from "pg";
import { effectiveStatuses } from "../../pm/pm.controller";
import { declareSocialModuleScope } from "../module-scope";
import { HOLDER_LABELS } from "./pipeline-read";
import { cycleSteps, rulesByRef, type CycleStepRule } from "./rules";
import { cycleStepTitle } from "./rules-periods";
import type { AttentionItem } from "./team";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PURE
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** A step task as the read finds it. */
export interface StepTaskFact {
  id: string;
  step: string;
  title: string;
  /** `YYYY-MM-DD`, or null (a report step for a client without a report day). */
  dueDate: string | null;
  /** 0 to 100. */
  progress: number;
  /** The task's status is a done status of its project. */
  done: boolean;
}

/** One step of the cycle, as `GET cycles/:cycleId/health` answers it (§63.27.4). */
export interface CycleStepRow {
  step: string;
  title: string;
  taskId: string | null;
  dueDate: string | null;
  done: boolean;
  progress: number;
  /** `auto`: the pipeline closes and reopens it itself; `manual`: it is made and dated, and closed by hand only. */
  autoClose: "auto" | "manual";
  /** The role holding an open step (the officer's Ball), else null. A role word, never a person. */
  holder: { role: "officer"; label: string } | null;
  /** Past its due date and not done. */
  late: boolean;
}

/** `YYYY-MM-DD` strings compare as dates: a step is late once its due date is before today and it is not done. */
export const isStepLate = (dueDate: string | null, done: boolean, today: string): boolean => !done && dueDate !== null && dueDate < today;

/** PURE. The cycle's steps in the order of its rules, each from its task (or without one: `taskId: null`). */
export function composeCycleSteps(
  steps: readonly CycleStepRule[], month: string, tasks: ReadonlyMap<string, StepTaskFact>, today: string,
): CycleStepRow[] {
  return steps.map((s): CycleStepRow => {
    const t = tasks.get(s.key);
    const done = t?.done ?? false;
    return {
      step: s.key,
      title: t?.title ?? cycleStepTitle(s, month),
      taskId: t?.id ?? null,
      dueDate: t?.dueDate ?? null,
      done,
      progress: done ? 100 : Math.max(0, Math.min(99, Math.round(t?.progress ?? 0))),
      autoClose: s.autoClose.rule === "manual" ? "manual" : "auto",
      holder: done ? null : { role: "officer", label: HOLDER_LABELS.officer },
      late: isStepLate(t?.dueDate ?? null, done, today),
    };
  });
}

/** What a late step is worth in the Team dashboard's list: the late open steps of `GET team`'s month. */
export interface LateStepRow { engagementId: string; clientName: string; cycleId: string; step: string; title: string; dueDate: string }

/**
 * PURE. The needs-attention items of the late steps (§63.27.4): `{kind: 'cycle_step_late', engagementId, clientName, step, dueDate}`, with the
 * step's title and `since` the due date. Team-level: no holder, no person, no post.
 */
export const lateStepAttention = (rows: readonly LateStepRow[]): AttentionItem[] =>
  rows.map((r) => ({
    kind: "cycle_step_late" as const, engagementId: r.engagementId, clientName: r.clientName, step: r.step, dueDate: r.dueDate, title: r.title,
    since: r.dueDate,
  }));

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The data side
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export type StepsReason = "no_project" | "project_not_found";

export interface CycleStepsData {
  rules: CycleStepRule[];
  month: string;
  /** Why there are no steps for a cycle (its engagement has no project, or the project was deleted); null otherwise. */
  reason: StepsReason | null;
  tasks: Map<string, StepTaskFact>;
}

interface TaskRow { id: string; project_id: string; linked_id: string; linked_step: string; title: string; due_date: string | null; progress: number; status: string }

/** The ids of the done statuses of each project (PM's own `effectiveStatuses`, which synthesizes the defaults for a project with none). */
async function doneStatusesOf(c: PoolClient, projectIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const p of new Set(projectIds)) out.set(p, new Set((await effectiveStatuses(c, p)).filter((s) => s.isDone).map((s) => s.id)));
  return out;
}

/**
 * One cycle's steps data: its rules (the cycle's own `rules_ref`), whether its engagement has a live project, and its step tasks found by link.
 * Null when the cycle does not exist. The statements run on the caller's `withTenants` client, with the social module scope declared.
 */
export async function readCycleSteps(c: PoolClient, tenantId: string, cycleId: string): Promise<CycleStepsData | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ month: string; rules_ref: string; project_id: string | null; project_live: boolean }>(
    `SELECT to_char(cy.month, 'YYYY-MM') AS month, cy.rules_ref, e.project_id::text AS project_id,
            EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = e.tenant_id AND p.id = e.project_id AND p.deleted_at IS NULL) AS project_live
       FROM social_cycles cy
       JOIN social_engagements e ON e.id = cy.engagement_id AND e.tenant_id = cy.tenant_id
      WHERE cy.tenant_id = $1 AND cy.id = $2 AND cy.deleted_at IS NULL`,
    [tenantId, cycleId],
  );
  const r = rows[0];
  if (!r) return null;
  const rules = cycleSteps((await rulesByRef(c, tenantId, r.rules_ref)).rules);
  const reason: StepsReason | null = !r.project_id ? "no_project" : r.project_live === true ? null : "project_not_found";
  if (reason) return { rules, month: r.month, reason, tasks: new Map() };

  const t = await c.query<TaskRow>(
    `SELECT id::text AS id, project_id::text AS project_id, linked_id::text AS linked_id, linked_step, title,
            to_char(due_date, 'YYYY-MM-DD') AS due_date, progress, status
       FROM pm_tasks
      WHERE tenant_id = $1 AND linked_type = 'social_cycle_step' AND linked_id = $2 AND deleted_at IS NULL
      ORDER BY linked_step, id`,
    [tenantId, cycleId],
  );
  const done = await doneStatusesOf(c, t.rows.map((x) => x.project_id));
  const tasks = new Map<string, StepTaskFact>();
  for (const x of t.rows) {
    tasks.set(x.linked_step, {
      id: x.id, step: x.linked_step, title: x.title, dueDate: x.due_date, progress: Number(x.progress),
      done: done.get(x.project_id)?.has(x.status) === true,
    });
  }
  return { rules, month: r.month, reason: null, tasks };
}

/** Filter late rows by PM's done statuses: a task row read for the Team dashboard, before it is known whether its status is a done one. */
export interface LateCandidate extends LateStepRow { projectId: string; status: string }

/** The candidates whose status is not a done status of their project. One `effectiveStatuses` read per distinct project. */
export async function openLateSteps(c: PoolClient, candidates: readonly LateCandidate[]): Promise<LateStepRow[]> {
  const done = await doneStatusesOf(c, candidates.map((x) => x.projectId));
  return candidates
    .filter((x) => done.get(x.projectId)?.has(x.status) !== true)
    .map(({ projectId: _p, status: _s, ...row }) => row);
}
