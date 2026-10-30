// SCP-5f — the monthly cycle's STEP TASKS (FRONTEND-BFF-CONTRACT §63.27; plan §4.5, SCP-D4, SCP-Q31). One PM task per step of the
// company's rules (`cycle.steps`, §63.30.1, read through A0's `rulesByRef` with the CYCLE's own `rules_ref`, so a rules change reaches
// new cycles only), in the engagement's project beside the content-month task (§63.13). Still no task per post. PM's task system, not
// a second one: every write goes through the PM module's own functions (`createPmTaskInTx`, `updateLinkedTaskScheduleInTx`,
// `setLinkedTaskProgressInTx`), and a step task is found again by its link (`linked_type = 'social_cycle_step'`, `linked_id` the cycle,
// `linked_step` the step key: migration 202610301310), never by its title.
//
// WHO WRITES THEM (§63.27.3). Only the pipeline, inside actions that are already authorized: no route and no Cerbos action of its own.
//   made and re-dated   `syncCycleStepTasks(create: true)` from `writeCycleInTx` (PUT cycles, the sheet import's cycles);
//                       `syncCycleStepTasks(create: false)` (re-date only) from `recomputeOpenReadyBy` (PUT settings, the nightly
//                       `social-cycle-ready-by` job) and `redateEngagementCycleSteps` (PATCH allocation: estimates, report day, officer).
//   closed and reopened `syncCycleStepProgress`, from the stage action's transaction (the fixture effect `cycle_steps`, after
//                       `content_month_progress`), the create, the sheet import, a change after the client and the simulation purge.
//                       A step whose `autoClose` is `manual` is made and dated, and never closed or reopened here.
//   the report step     `closeReportStepsOnDelivery`, from `POST reports/:id/deliver`, for the cycles whose report step names that period.
//
// THE LOCK ORDER (§63.27.3, one direction only). In a stage action: the POST (the action's own `FOR UPDATE`), then the cycle's
// CONTENT-MONTH task (`syncContentMonthProgress`, the effect before this one), then the cycle's STEP TASKS in the order of the
// cycle's rules (`lockStepTasks`: one `SELECT … ORDER BY array_position(<rule keys>, linked_step) FOR UPDATE`, which locks rows in
// that order). The report's delivery takes only its step task. Where several cycles are touched in one transaction (the nightly job,
// PUT settings, the allocation), they go in cycle-id order and each cycle's rows in the order above. Nothing here locks a post or a
// cycle row, and nothing reads a task to decide on a post: moving a step task never moves a post.
//
// The posts are read AFTER the step tasks are locked, so two stage actions on posts of one cycle queue on the tasks and the second
// recomputes from what the first committed (READ COMMITTED: each statement sees the commits before it started).
//
// A caller-owned `withTenants([tenantId], fn, { modules: ["social"] })` client: the cycle, engagement and posts are third-walled rows;
// `pm_tasks` keeps the plain tenant wall.
import type { PoolClient } from "pg";
import {
  createPmTaskInTx, effectiveStatuses, normalizePmTaskInput, setLinkedTaskProgressInTx, updateLinkedTaskScheduleInTx,
} from "../../pm/pm.controller";
import type { WorkingCalendar } from "../../hr/working-days";
import { declareSocialModuleScope } from "../module-scope";
import { readCyclePosts } from "./cycles-data";
import { changeCaseOf } from "./machine";
import { cycleSteps, rulesByRef, type CycleAutoClose, type CycleStepRule } from "./rules";
import { cycleStepDueDate, cycleStepTitle, monthPlus } from "./rules-periods";
import { parseStepEstimates, type CountedPost, type StepEstimates } from "./schedule-health";

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PURE: the plan of a cycle's steps, and each step's figures
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface PlannedStep {
  key: string;
  title: string;
  /** `YYYY-MM-DD`, or null (a report step for a client without a report day, or a `none` due rule). */
  dueDate: string | null;
  autoClose: CycleAutoClose;
}

/** PURE. The steps of content month `month` under `steps` (the cycle's rules), in the rules' order: title and due date (rules-periods.ts). */
export function planCycleSteps(
  steps: readonly CycleStepRule[], month: string,
  ctx: { readyBy: string; estimates: StepEstimates; reportDueDay: number | null; calendar: WorkingCalendar },
): PlannedStep[] {
  return steps.map((s) => ({ key: s.key, title: cycleStepTitle(s, month), dueDate: cycleStepDueDate(s, month, ctx), autoClose: s.autoClose }));
}

/** A post as the step conditions read it: a cycle post (`readCyclePosts`). */
export type StepPost = CountedPost;

export interface StepFigures {
  /** 0 to 99 until done, 100 when done (100 is what done means in PM). */
  progress: number;
  done: boolean;
}

/** The statuses that have passed the HoD approval (§63.27.2 `copy_lock`), and the change cases that keep that (a design change). */
const PAST_COPY: ReadonlySet<string> = new Set(["design", "final", "client", "approved", "scheduled", "live"]);
const PAST_COPY_CASES: ReadonlySet<string> = new Set(["final_design", "client_design"]);
/** The statuses that have left Creative (`artwork`), and the change cases that keep that (a copy change after design). */
const PAST_ART: ReadonlySet<string> = new Set(["final", "client", "approved", "scheduled", "live"]);
const PAST_ART_CASES: ReadonlySet<string> = new Set(["final_copy", "client_copy"]);
const PAST_CLIENT: ReadonlySet<string> = new Set(["approved", "scheduled", "live"]);
const SCHEDULED: ReadonlySet<string> = new Set(["scheduled", "live"]);
const UNPLANNED: ReadonlySet<string> = new Set(["planned", "drafting"]);

/** A post the target counts: not a story, not an extra post (plan §4.4 "Counting"; `tallyCounts`' own rule). */
export const isCountedPost = (p: Pick<StepPost, "isExtra" | "format">): boolean => !p.isExtra && p.format !== "story";

/** The status a step reads: a blocked post counts from `blocked_from` (its change case is kept with it, `keep_change_case`). */
function stepStatusOf(p: StepPost): string {
  return p.status === "blocked" ? (p.blockedFrom ?? "blocked") : p.status;
}

function changeCaseSafe(p: StepPost): string | null {
  try {
    return changeCaseOf({ changeBy: p.changeBy ?? null, changeKind: p.changeKind ?? null, returnTo: p.returnTo ?? null } as Parameters<typeof changeCaseOf>[0]);
  } catch {
    return null; // unreachable: the database CHECK admits the fixture's six cases only
  }
}

/** PURE. Whether one counted post meets a post condition (§63.27.2's "closes itself when" column). */
export function postMeets(rule: Exclude<CycleAutoClose["rule"], "manual" | "report_delivered">, p: StepPost): boolean {
  const st = stepStatusOf(p);
  const cc = st === "changes" ? changeCaseSafe(p) : null;
  switch (rule) {
    case "plan_laid_out": return !UNPLANNED.has(st);
    case "copy_locked": return PAST_COPY.has(st) || (cc !== null && PAST_COPY_CASES.has(cc));
    // A client copy change re-proofs only the copy (`changed_only`): the design is final, so the post has not gone back to Creative.
    case "artwork_done": return PAST_ART.has(st) || (cc !== null && PAST_ART_CASES.has(cc)) || (st === "proofread" && p.changedOnly === true);
    case "client_approved": return PAST_CLIENT.has(st);
    case "all_scheduled": return SCHEDULED.has(st);
  }
}

/**
 * PURE. A step's figures (§63.27.2): done by its condition; progress the share of counted posts meeting it, 0 to 99 until done.
 * `manual` answers null: the pipeline never closes or reopens it. `report_delivered` is done when the report was delivered, else 0.
 *   plan_laid_out    the target met (counted ≥ target; at least one counted post without a target) and every counted post past drafting
 *   copy_locked      at least one counted post, and every counted post past the HoD approval
 *   artwork_done     at least one counted post, and every counted post out of Creative
 *   client_approved  63.13's content-month rule: every counted post approved, scheduled or live, and the target met
 *   all_scheduled    every counted post scheduled or live, and the target met
 */
export function stepFigures(autoClose: CycleAutoClose, posts: readonly StepPost[], target: number | null, reportDelivered: boolean): StepFigures | null {
  if (autoClose.rule === "manual") return null;
  if (autoClose.rule === "report_delivered") return reportDelivered ? { progress: 100, done: true } : { progress: 0, done: false };
  const rule = autoClose.rule;
  const counted = posts.filter(isCountedPost);
  const meeting = counted.filter((p) => postMeets(rule, p)).length;
  const all = counted.length > 0 && meeting === counted.length;
  const goal = target !== null && target > 0 ? target : null;
  const targetMet = goal === null ? counted.length >= 1 : counted.length >= goal;
  const done = rule === "copy_locked" || rule === "artwork_done" ? all : all && targetMet;
  if (done) return { progress: 100, done: true };
  const share = counted.length > 0 ? Math.round((meeting / counted.length) * 100) : 0;
  return { progress: Math.min(99, share), done: false };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The data side
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface CycleFacts {
  id: string;
  engagementId: string;
  month: string;
  readyBy: string;
  rulesRef: string;
  projectId: string | null;
  projectLive: boolean;
  ownerId: string | null;
  officerName: string | null;
  estimates: StepEstimates;
  reportDueDay: number | null;
  target: number | null;
}

/** The cycle and what its steps read of the engagement. No lock: a caller that writes the cycle row holds it already. */
async function readCycleFacts(c: PoolClient, tenantId: string, cycleId: string): Promise<CycleFacts | null> {
  const { rows } = await c.query<{
    id: string; engagement_id: string; month: string; ready_by: string; rules_ref: string; project_id: string | null; project_live: boolean;
    owner_id: string | null; officer_name: string | null; step_estimates: unknown; report_due_day: number | null; posts_per_cycle: number | null;
  }>(
    `SELECT cy.id::text AS id, cy.engagement_id::text AS engagement_id, to_char(cy.month, 'YYYY-MM') AS month,
            to_char(cy.ready_by, 'YYYY-MM-DD') AS ready_by, cy.rules_ref,
            e.project_id::text AS project_id,
            EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = e.tenant_id AND p.id = e.project_id AND p.deleted_at IS NULL) AS project_live,
            e.owner_id::text AS owner_id, u.name AS officer_name, e.step_estimates, e.report_due_day, e.posts_per_cycle
       FROM social_cycles cy
       JOIN social_engagements e ON e.id = cy.engagement_id AND e.tenant_id = cy.tenant_id
       LEFT JOIN users u ON u.id = e.owner_id
      WHERE cy.tenant_id = $1 AND cy.id = $2 AND cy.deleted_at IS NULL`,
    [tenantId, cycleId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, engagementId: r.engagement_id, month: r.month, readyBy: r.ready_by, rulesRef: r.rules_ref, projectId: r.project_id,
    projectLive: r.project_live === true, ownerId: r.owner_id, officerName: r.officer_name, estimates: parseStepEstimates(r.step_estimates),
    reportDueDay: r.report_due_day === null ? null : Number(r.report_due_day), target: r.posts_per_cycle === null ? null : Number(r.posts_per_cycle),
  };
}

interface LockedStepTask { id: string; step: string; projectId: string; status: string }

/**
 * Lock the live step tasks of a cycle, in the order of `order` (the cycle's rule keys), in ONE statement: the row locks are taken as the
 * sorted rows are emitted, so every caller takes them in the same order. `only` narrows to some steps (the order is kept).
 */
async function lockStepTasks(c: PoolClient, tenantId: string, cycleId: string, order: readonly string[], only?: readonly string[]): Promise<LockedStepTask[]> {
  const { rows } = await c.query<LockedStepTask>(
    `SELECT id::text AS id, linked_step AS step, project_id::text AS "projectId", status
       FROM pm_tasks
      WHERE tenant_id = $1 AND linked_type = 'social_cycle_step' AND linked_id = $2 AND deleted_at IS NULL
        AND ($4::text[] IS NULL OR linked_step = ANY($4::text[]))
      ORDER BY COALESCE(array_position($3::text[], linked_step), 2147483647), linked_step, id
      FOR UPDATE`,
    [tenantId, cycleId, [...order], only ? [...only] : null],
  );
  return rows;
}

/** What `PUT cycles` says about one row's step tasks (`stepTasks`, §63.27.3): how many this call made, or why there are none. */
export interface CycleStepTasksResult {
  created: number;
  reason: "no_project" | "project_not_found" | null;
}

/**
 * Make (with `create`) and re-date a cycle's step tasks from its own rules, in the caller's transaction, after the cycle row was written:
 * the title, the due date and, on a step that is not done, the Ball and the Responsible (the officer). A step that is done keeps its
 * assignee (a new officer takes the Ball of every OPEN step). Re-dating never touches status or progress; newly made tasks then get their
 * state from `syncCycleStepProgress`. Never throws for "no project": it answers the reason.
 */
export async function syncCycleStepTasks(
  c: PoolClient,
  a: { tenantId: string; cycleId: string; actorId: string | null; calendar: WorkingCalendar; create: boolean },
): Promise<CycleStepTasksResult> {
  await declareSocialModuleScope(c);
  const f = await readCycleFacts(c, a.tenantId, a.cycleId);
  if (!f) return { created: 0, reason: null };
  if (!f.projectId) return { created: 0, reason: "no_project" };
  if (!f.projectLive) return { created: 0, reason: "project_not_found" };

  const steps = cycleSteps((await rulesByRef(c, a.tenantId, f.rulesRef)).rules);
  const plan = planCycleSteps(steps, f.month, { readyBy: f.readyBy, estimates: f.estimates, reportDueDay: f.reportDueDay, calendar: a.calendar });
  const assignee = f.ownerId
    ? { kind: "person" as const, refId: f.ownerId, refName: f.officerName ?? f.ownerId, responsibleId: f.ownerId, responsibleName: f.officerName ?? f.ownerId }
    : undefined;

  const locked = await lockStepTasks(c, a.tenantId, a.cycleId, plan.map((s) => s.key));
  const byStep = new Map(locked.map((t) => [t.step, t]));
  const doneIds = new Map<string, Set<string>>();
  const isDone = async (t: LockedStepTask): Promise<boolean> => {
    let set = doneIds.get(t.projectId);
    if (!set) {
      set = new Set((await effectiveStatuses(c, t.projectId)).filter((s) => s.isDone).map((s) => s.id));
      doneIds.set(t.projectId, set);
    }
    return set.has(t.status);
  };

  let created = 0;
  for (const s of plan) {
    const t = byStep.get(s.key);
    if (t) {
      const open = !(await isDone(t));
      await updateLinkedTaskScheduleInTx(c, a.tenantId, a.actorId, t.id, { title: s.title, dueDate: s.dueDate, assignee: open ? assignee : undefined });
      continue;
    }
    if (!a.create) continue;
    const n = normalizePmTaskInput({ projectId: f.projectId, title: s.title, dueDate: s.dueDate ?? undefined, assignee });
    await createPmTaskInTx(c, a.tenantId, a.actorId, { ...n, link: { type: "social_cycle_step", id: a.cycleId, step: s.key } });
    created += 1;
  }
  if (created > 0) await syncCycleStepProgress(c, a.tenantId, a.cycleId, a.actorId);
  return { created, reason: null };
}

/** Whether the client's monthly report for `period` (`YYYY-MM`) was delivered. */
async function monthlyReportDelivered(c: PoolClient, tenantId: string, engagementId: string, period: string): Promise<boolean> {
  const { rows } = await c.query(
    `SELECT 1 FROM social_reports
      WHERE tenant_id = $1 AND engagement_id = $2 AND kind = 'monthly' AND period = $3 AND status = 'delivered' AND deleted_at IS NULL
      LIMIT 1`,
    [tenantId, engagementId, period],
  );
  return rows.length > 0;
}

/**
 * Close and reopen a cycle's step tasks by their auto-close conditions, in the caller's transaction (the lock order in the header). A step
 * set to `manual` is not touched; a cycle with no step task (no project, or made before SCP-5f) is a no-op that reads no post. Answers
 * what PM did per step.
 */
export async function syncCycleStepProgress(
  c: PoolClient, tenantId: string, cycleId: string, actorId: string | null,
): Promise<Record<string, string>> {
  await declareSocialModuleScope(c);
  const f = await readCycleFacts(c, tenantId, cycleId);
  if (!f) return {};
  const steps = cycleSteps((await rulesByRef(c, tenantId, f.rulesRef)).rules);
  const auto = steps.filter((s) => s.autoClose.rule !== "manual");
  if (auto.length === 0) return {};
  const locked = await lockStepTasks(c, tenantId, cycleId, steps.map((s) => s.key), auto.map((s) => s.key));
  if (locked.length === 0) return {};
  // Read under the locks (the header): the posts as the last committed action left them, plus this transaction's own write.
  const posts = await readCyclePosts(c, tenantId, [cycleId]);
  const byStep = new Map(locked.map((t) => [t.step, t]));
  const out: Record<string, string> = {};
  for (const s of auto) {
    const t = byStep.get(s.key);
    if (!t) continue;
    const delivered = s.autoClose.rule === "report_delivered"
      ? await monthlyReportDelivered(c, tenantId, f.engagementId, monthPlus(f.month, s.autoClose.reportMonthOffset))
      : false;
    const fig = stepFigures(s.autoClose, posts, f.target, delivered);
    if (!fig) continue;
    out[s.key] = (await setLinkedTaskProgressInTx(c, tenantId, actorId, t.id, fig)).outcome;
  }
  return out;
}

/**
 * `POST reports/:id/deliver` (§63.27.3): the delivered monthly report for `period` closes the `report_delivered` step of each cycle of
 * the engagement whose rules name that period (M + reportMonthOffset = period; the seed's −2 is cycle M = period + 2). It takes ONLY
 * those step tasks, cycle by cycle in id order. A cycle without the task, or whose step is `manual`, is left alone.
 */
export async function closeReportStepsOnDelivery(
  c: PoolClient, tenantId: string, report: { engagementId: string; kind: string; period: string | null }, actorId: string | null,
): Promise<Array<{ cycleId: string; step: string; outcome: string }>> {
  if (report.kind !== "monthly" || !report.period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(report.period)) return [];
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string; month: string; rules_ref: string }>(
    `SELECT id::text AS id, to_char(month, 'YYYY-MM') AS month, rules_ref
       FROM social_cycles
      WHERE tenant_id = $1 AND engagement_id = $2 AND deleted_at IS NULL
        AND month BETWEEN $3::date AND ($3::date + interval '3 months')
      ORDER BY id`,
    [tenantId, report.engagementId, `${report.period}-01`],
  );
  const out: Array<{ cycleId: string; step: string; outcome: string }> = [];
  for (const cy of rows) {
    const steps = cycleSteps((await rulesByRef(c, tenantId, cy.rules_ref)).rules);
    const mine = steps.filter((s) => s.autoClose.rule === "report_delivered" && monthPlus(cy.month, s.autoClose.reportMonthOffset) === report.period);
    if (mine.length === 0) continue;
    const locked = await lockStepTasks(c, tenantId, cy.id, steps.map((s) => s.key), mine.map((s) => s.key));
    for (const t of locked) {
      const r = await setLinkedTaskProgressInTx(c, tenantId, actorId, t.id, { progress: 100, done: true });
      out.push({ cycleId: cy.id, step: t.step, outcome: r.outcome });
    }
  }
  return out;
}

/**
 * `PATCH engagements/:engagementId/allocation` changed the step estimates, the report day or the officer (§63.27.3): re-date the step
 * tasks of the engagement's OPEN cycles (content month not ended, `OPEN_CYCLE_SQL`'s rule) and give their open steps to the officer. In
 * the caller's transaction, after the engagement's own write: the cycle rows are locked first, in id order (as the nightly job locks
 * them), then each cycle's step tasks. Answers the cycles touched.
 */
export async function redateEngagementCycleSteps(
  c: PoolClient, a: { tenantId: string; engagementId: string; today: string; calendar: WorkingCalendar; actorId: string | null },
): Promise<number> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ id: string }>(
    `SELECT c.id::text AS id FROM social_cycles c
      WHERE c.tenant_id = $1 AND c.engagement_id = $3 AND c.deleted_at IS NULL
        AND (c.month + interval '1 month' - interval '1 day')::date >= $2::date
      ORDER BY c.id FOR UPDATE`,
    [a.tenantId, a.today, a.engagementId],
  );
  for (const r of rows) await syncCycleStepTasks(c, { tenantId: a.tenantId, cycleId: r.id, actorId: a.actorId, calendar: a.calendar, create: false });
  return rows.length;
}

/** The first and last deadline of an engagement's open cycles (the holiday window `redateEngagementCycleSteps` needs), or null. */
export async function openEngagementCycleDeadlines(c: PoolClient, tenantId: string, engagementId: string, today: string): Promise<string[] | null> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ min: string | null; max: string | null }>(
    `SELECT to_char(min(c.deadline), 'YYYY-MM-DD') AS min, to_char(max(c.deadline), 'YYYY-MM-DD') AS max
       FROM social_cycles c
      WHERE c.tenant_id = $1 AND c.engagement_id = $3 AND c.deleted_at IS NULL
        AND (c.month + interval '1 month' - interval '1 day')::date >= $2::date`,
    [tenantId, today, engagementId],
  );
  const r = rows[0];
  return r?.min && r.max ? [r.min, r.max] : null;
}
