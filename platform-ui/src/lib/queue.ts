import "server-only";
// The shared "what needs me" data spine — UX-2 §1 + WS-UX-plan R-1. ONE
// merge, consumed by BOTH the app Home (`/`, this ticket) and the department
// console rail (`MyWorkRail`, via `projectQueueForCompany` below) — no second
// queue implementation may exist (R-1, WSUX-5 acceptance criteria).
//
// This is UI composition over EXISTING typed reads, per the daily-work spec's
// own instruction ("client-side merge of existing typed rows — no new merge
// endpoint required"): contract §9(a) `GET /api/approvals` and §9(b)
// `GET /api/tasks/mine` are both ⬜ PENDING backend work (unified server-side
// fan-out) — this file is the client-side equivalent until those land, then
// becomes a thin pass-through. Every per-company leg degrades independently
// (mirrors `getPendingApprovals`'s existing per-tenant try/catch) so one
// failing source/company never blanks the whole queue.
import type { Me } from "./platform";
import { can } from "./rbac";
import { getPendingApprovals, getMyTasks, type ApprovalItem, type TaskRow } from "./data";
import {
  listAllPmTasks, listTaskComments, statusesForTasks, isDoneStatus, taskUrgency, dayDiff,
  type PmTask, type ProjectStatus, type Comment,
} from "./pm";
import { listWorkActivity, type WorkActivityRow } from "./activity";
import { listAutomationApprovals, type AutomationApproval } from "./automationApprovals";
import { listInternalPendingGates, GATE_LABEL, type PipelineGate } from "./pipeline";
import { listNotifications, type NotificationItem } from "./entities";
import { mergeLegs, type Envelope } from "./envelope";
import { rankByUrgency, type QueueItem, type QueueItemType } from "./queueUrgency";
import { PM_STATUS_LADDER } from "./pmVocabulary";
import type { PmHomeProps, PmHomeTask, PmHomeStatusGroup } from "@/components/pm/PmHome";
import type { PmCounterValues } from "@/components/pm/PmCounters";

/**
 * ⚠ A THIRD NAME FOR THE DEGRADE PATTERN — and the limitation it used to carry is now CLOSED.
 *
 * The reader-degrade sweep looked for `safe()` and `skipMissing()`; this is the same shape called
 * `settle()`, which is why it went unnoticed. Its original comment described the whole defect chain
 * approvingly: "The underlying readers already degrade 404/403 to [] themselves; this is the outer
 * net for anything else." Those readers no longer do, so this net now catches only what it should.
 *
 * WHY IT STILL EXISTS: the queue aggregates six independent sources and UX-2 §1.5 requires that one
 * dead source must not blank it. That is right, and it used to conflict with "never render a list you
 * cannot vouch for" — the queue could come back SHORT and say nothing, and on a "work waiting for
 * you" surface a short queue reads as "this is all of it" while an empty one reads as "you are done".
 *
 * Resolved by keeping the resilience and dropping the silence: a failed source is NAMED into
 * `partialSources`, `EnvelopeBanner` renders it, and the caller can tell an honest empty queue from
 * an incomplete one. The try/catch stays because a leg must still survive; what changed is that
 * surviving is no longer indistinguishable from succeeding.
 */
async function settle<T>(source: string, p: Promise<T[]>, lost: string[]): Promise<T[]> {
  try {
    return await p;
  } catch {
    lost.push(source);
    return [];
  }
}


function fromApproval(a: ApprovalItem, decidable: boolean): QueueItem {
  return {
    id: `agency:${a.id}`,
    type: "approval",
    origin: "agency",
    originId: a.id,
    title: a.subject,
    meta: a.campaign,
    companyId: a.tenantId,
    company: a.company,
    href: a.campaignId ? `/agency/${a.campaignId}` : "/approvals",
    createdAt: a.created_at,
    decidable,
    urgencyScore: 0,
  };
}

// `tool_name` is a machine identifier — "it.devices.disable", "pm.tasks.bulkUpdate". It was being
// printed as the item's TITLE, so the approval queue asked people to decide on things named like
// permission keys. Read as: last segment is the verb, the segment before it the object, the first
// the owning domain (kept as the `meta` prefix, where a namespace belongs).
//   "it.devices.disable"   -> "Disable devices"
//   "pm.tasks.bulkUpdate"  -> "Bulk update tasks"
//   "deploy"               -> "Deploy"
// An identifier that does not fit the shape is returned as-is rather than mangled: a name we cannot
// parse is still better than a wrong sentence.
export function humanizeToolName(tool: string): string {
  const parts = tool.split(".").filter(Boolean);
  if (parts.length === 0) return tool;
  const words = (s: string) => s.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const verb = words(parts[parts.length - 1]);
  const object = parts.length >= 2 ? words(parts[parts.length - 2]) : "";
  const phrase = object ? `${verb} ${object}` : verb;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Domain segment of a tool id ("it.devices.disable" -> "IT"), or null when there is none. */
function toolDomain(tool: string): string | null {
  const parts = tool.split(".").filter(Boolean);
  return parts.length >= 3 ? parts[0].toUpperCase() : null;
}

function fromAutomation(a: AutomationApproval, company: { id: string; name: string }, decidable: boolean): QueueItem {
  const domain = toolDomain(a.tool_name);
  return {
    id: `automation:${a.id}`,
    type: "approval",
    origin: "automation",
    originId: a.id,
    title: humanizeToolName(a.tool_name),
    // Domain first, then why. The namespace still has to be visible — "Disable devices" is not the
    // same decision under IT as under HR — it just belongs in the caption, not in the title.
    meta: [domain, a.reason ?? (a.origin === "agent" ? (a.agent_name ?? "Agent") : "Automation")]
      .filter(Boolean)
      .join(" · "),
    companyId: company.id,
    company: company.name,
    createdAt: a.created_at,
    decidable,
    urgencyScore: 0,
  };
}

function fromGate(g: PipelineGate, company: { id: string; name: string }, decidable: boolean): QueueItem {
  return {
    id: `pipeline:${g.id}`,
    type: "gate",
    origin: "pipeline",
    originId: g.id,
    title: GATE_LABEL[g.kind] ?? g.kind,
    meta: g.note ?? undefined,
    companyId: company.id,
    company: company.name,
    href: `/pipeline/${g.run_id}`,
    createdAt: g.created_at,
    decidable,
    urgencyScore: 0,
  };
}

// PM tasks (`pm_tasks`) — the model every task the app creates actually lives in. The queue used to
// read ONLY getMyTasks (GET /api/:t/tasks?assignee=me, the legacy flat `tasks` table), which returns
// [] on live data, so an overdue PM task never reached "Needs you" at all. Both are read now: the
// tables are distinct, so there is nothing to de-duplicate.
//
// KNOWN LIMIT: "done" is matched literally. A project that renamed its done status keeps the
// isDone FLAG in its own status registry (lib/pm's statusFlags), which the queue does not load —
// it is a cross-company fan-out and fetching a registry per project would multiply the request
// count. A renamed done status therefore still shows here; the literal covers every default project.
function fromPmTask(t: PmTask, company: { id: string; name: string }): QueueItem {
  return {
    id: `pmtask:${company.id}:${t.id}`,
    type: "task",
    title: t.title,
    meta: t.projectName,
    companyId: company.id,
    company: company.name,
    href: `/tasks/${t.id}`,
    dueDate: t.dueDate,
    createdAt: t.updatedAt ?? t.dueDate ?? new Date(0).toISOString(),
    decidable: true,
    urgencyScore: 0,
  };
}

function fromTask(t: TaskRow, company: { id: string; name: string }): QueueItem {
  return {
    id: `task:${company.id}:${t.id}`,
    type: "task",
    title: t.title,
    meta: t.project_name,
    companyId: company.id,
    company: company.name,
    href: `/tasks/${t.id}`,
    dueDate: t.due_date,
    // TaskRow has no created_at (5c's simple task model, distinct from PmTask)
    // — fall back to due_date, else the epoch so it never crashes scoring; it
    // just means such a task competes on type-weight alone, which is correct
    // (we have no real signal for its age).
    createdAt: t.due_date ?? new Date(0).toISOString(),
    decidable: true, // "Open" is always available; no mutation gate needed to view
    urgencyScore: 0,
  };
}

// Heuristic mention filter — WSUX-4's typed `severity: "action_needed"`
// payload isn't built yet (soft dependency, WS-UX plan §2), so this reads the
// current opaque payload defensively: unread AND the type names a mention.
// Once WSUX-4 lands this narrows to `payload.severity === "action_needed"`
// with no shape change to QueueItem itself.
function isMentionEligible(n: NotificationItem): boolean {
  if (n.read_at) return false;
  return /mention/i.test(n.type);
}

function fromMention(n: NotificationItem, company: { id: string; name: string }): QueueItem {
  const p = n.payload ?? {};
  const title = (typeof p.title === "string" && p.title) || (typeof p.subject === "string" && p.subject) || "Mention";
  const href = typeof p.href === "string" && p.href.startsWith("/") ? p.href : undefined;
  return {
    id: `mention:${company.id}:${n.id}`,
    type: "mention",
    title,
    companyId: company.id,
    company: company.name,
    href,
    createdAt: n.created_at,
    decidable: true,
    urgencyScore: 0,
  };
}

export interface MyWorkQueueOptions {
  /** Cap on automation-approval + pipeline-gate reads (both tenant-wide
   *  lists); default matches the rail's own convention of pending-only. */
  limit?: number;
}

/** THE shared queue spine (R-1). Fans out per company — same shape as
 *  `getPendingApprovals` — merging approvals + automation approvals +
 *  pipeline gates + tasks + mentions into one ranked `Envelope<QueueItem>`.
 *  Every accessible company gets its own try/catch net so one bad leg is
 *  excluded (reason "error") without dropping the rest (UX-2 §1.5/§4.3). */
export async function getMyWorkQueue(
  me: Me,
  userId: string,
  companies: { id: string; name: string }[],
  _opts: MyWorkQueueOptions = {},
): Promise<Envelope<QueueItem>> {
  const legs = await Promise.all(
    companies.map(async (c) => {
      try {
        const decidable = can(me, "approvals.decide", c.id);
        // AGN-3: every source names itself, so a leg that survives a dead source reports WHICH one it
        // lost instead of quietly returning a shorter queue.
        const lost: string[] = [];
        const [approvals, automation, gates, tasks, pmTasks, notifications] = await Promise.all([
          settle("approvals", getPendingApprovals(userId, [c]), lost),
          settle("automation approvals", listAutomationApprovals(userId, c.id, { status: "pending" }), lost),
          // A refused gate read is a REFUSAL, not an empty gate list, so it is reported as a lost
          // source rather than unwrapped into [].
          settle(
            "pipeline gates",
            listInternalPendingGates(userId, c.id).then((r) => {
              if (r.kind !== "ok") throw new Error(r.kind === "forbidden" ? "forbidden" : r.reason);
              return r.data;
            }),
            lost,
          ),
          settle("my tasks", getMyTasks(userId, c.id), lost),
          settle("PM tasks", listAllPmTasks(userId, c.id, { assignee: "me" }), lost),
          settle("mentions", listNotifications(userId, c.id, true), lost),
        ]);
        const rows: QueueItem[] = [
          ...approvals.map((a) => fromApproval(a, decidable)),
          ...automation.map((a) => fromAutomation(a, c, decidable)),
          ...gates.map((g) => fromGate(g, c, decidable)),
          ...tasks.filter((t) => t.status !== "done").map((t) => fromTask(t, c)),
          ...pmTasks.filter((t) => t.status !== "done").map((t) => fromPmTask(t, c)),
          ...notifications.filter(isMentionEligible).map((n) => fromMention(n, c)),
        ];
        return { company: c, ok: true, rows, partialSources: lost };
      } catch {
        return { company: c, ok: false, rows: [] as QueueItem[], reason: "error" as const };
      }
    }),
  );
  const merged = mergeLegs(legs);
  return { items: rankByUrgency(merged.items), companies: merged.companies };
}

export interface QueueProjectionOptions {
  /** Restrict the projection to these item types (e.g. the rail's "Waiting on
   *  me" only wants approval/gate rows — its "My work today" list is dept-task
   *  specific and comes from `lib/departments.ts`, not this queue). */
  types?: QueueItemType[];
  limit?: number;
}

// The department console rail's compact projection of the SAME queue (R-1) —
// a pure filter, never a second fetch/merge. Kept here (not in the rail
// component, which stays props-only) so callers share one implementation:
// `projectQueueForCompany(queue, companyId, {types}) === queue.items.filter(...)`
// by construction, which is exactly what the WSUX-5 rail-equivalence test
// below asserts.
export function projectQueueForCompany(
  queue: Envelope<QueueItem>,
  companyId: string,
  opts: QueueProjectionOptions = {},
): QueueItem[] {
  let items = queue.items.filter((i) => i.companyId === companyId);
  if (opts.types) {
    const allow = new Set(opts.types);
    items = items.filter((i) => allow.has(i.type));
  }
  return typeof opts.limit === "number" ? items.slice(0, opts.limit) : items;
}

// =================================================================================================
// P4-A8 — the `@all` Home dashboard, and P4-A9 — top-bar counters. Plan
// `2026-08-04-pm-repsona-parity-phase4-plan.md` §1.2 + workstream A.
//
// This is the DATA half; `components/pm/PmHome.tsx` and `components/pm/PmCounters.tsx` are pure
// rendering over the shapes assembled here. Lives in `queue.ts` rather than `lib/pm.ts` because
// `lib/pm.ts` is owned by a concurrent agent on this ticket set and because the shape of the work —
// "assemble a cross-project, mine-relevant view over the tenant's PM tasks, tolerating a partial
// read" — is exactly this file's existing job (the My Work spine), just a different projection.
// =================================================================================================

// "YYYY-MM-DD" minus N days, at UTC midnight — pure, no `Date.now()`. `today` is always the
// caller-resolved value (see PmHome.tsx's header on why "today" is never read from the clock
// inside a helper); this only does calendar arithmetic on it, same technique as
// `pmRecurrence.ts::addRecurrenceFreq`.
export function isoDaysAgo(today: string, days: number): string {
  const [y, m, d] = today.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString();
}

// "7/28 – 8/4" — Repsona shows the activity/upcoming windows as an explicit date range rather than
// a relative "this week". Pure string slicing (no `Date`, no locale formatter) for the same
// hydration reason `dayDiff` parses at UTC midnight.
export function homeWindowLabel(today: string): string {
  const from = isoDaysAgo(today, 7).slice(0, 10);
  const fmt = (iso: string) => {
    const [, mo, d] = iso.split("-");
    return `${Number(mo)}/${Number(d)}`;
  };
  return `${fmt(from)} – ${fmt(today)}`;
}

const HOME_ACTIVITY_WINDOW_DAYS = 7;
const HOME_UPCOMING_WINDOW_DAYS = 7;
const COMMENT_EXCERPT_MAX = 140;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > COMMENT_EXCERPT_MAX ? `${flat.slice(0, COMMENT_EXCERPT_MAX - 1)}…` : flat;
}

// Ordered status ids for grouping: the shared ladder first (so every `@all` column reads in the
// same Backlog->Done order regardless of which project's tasks happen to populate it first), then
// any project-custom status ids in first-seen order.
function statusOrder(tasks: PmTask[]): string[] {
  const seen = new Set(PM_STATUS_LADDER.map((s) => s.id));
  const order = [...seen];
  for (const t of tasks) {
    if (!seen.has(t.status)) { seen.add(t.status); order.push(t.status); }
  }
  return order;
}

function statusOf(t: PmTask, byProject: Record<string, ProjectStatus[]>): ProjectStatus | undefined {
  return byProject[t.projectId]?.find((s) => s.id === t.status);
}

interface HomeExtra { excerpt: string; author?: string }

function toHomeTask(t: PmTask, byProject: Record<string, ProjectStatus[]>, today: string, extra?: HomeExtra): PmHomeTask {
  const status = statusOf(t, byProject);
  const isDone = isDoneStatus(t.status, byProject[t.projectId]);
  return {
    id: t.id,
    href: `/tasks/${t.id}`,
    title: t.title,
    projectName: t.projectName,
    statusLabel: status?.label ?? t.status,
    statusColor: status?.color ?? "var(--pm-surface-sunken)",
    dueDate: t.dueDate,
    urgencyTier: taskUrgency({ dueDate: t.dueDate, isDone }, today),
    assigneeName: t.assignee?.refName ?? null,
    commentExcerpt: extra?.excerpt,
    commentAuthor: extra?.author,
  };
}

function toGroups(
  tasks: PmTask[],
  byProject: Record<string, ProjectStatus[]>,
  today: string,
  extraByTaskId?: Map<string, HomeExtra>,
): PmHomeStatusGroup[] {
  const order = statusOrder(tasks);
  const groups = new Map<string, PmHomeStatusGroup>();
  for (const id of order) groups.set(id, { statusId: id, statusLabel: id, statusColor: "var(--pm-surface-sunken)", tasks: [] });
  for (const t of tasks) {
    const status = statusOf(t, byProject);
    // `order` was built FROM `tasks` above (statusOrder), so every t.status already has an entry.
    const g = groups.get(t.status)!;
    if (status) { g.statusLabel = status.label; g.statusColor = status.color; }
    g.tasks.push(toHomeTask(t, byProject, today, extraByTaskId?.get(t.id)));
  }
  return order.map((id) => groups.get(id)!).filter((g) => g.tasks.length > 0);
}

/** Cross-project (`@all`) Home dashboard data (P4-A8). Fans out: one tenant-wide task list, one
 *  batched status-registry read (`statusesForTasks`, deduped per distinct project — existing
 *  helper, not a new endpoint), one work-activity read for the comment column, and one comment
 *  read per DISTINCT task that has commented activity in the window (bounded by how many tasks
 *  actually got a comment this week, not by the tenant's whole task count). Every leg degrades to
 *  empty on its own (the underlying readers already return `[]`/`null` on 404/403), so a missing
 *  work-activity deployment still renders 3 working columns instead of a blank page. */
export async function getPmHomeData(u: string, t: string, today: string): Promise<PmHomeProps> {
  const tasks = await listAllPmTasks(u, t);
  const byProject = await statusesForTasks(u, t, tasks);

  const todaysTodo: PmTask[] = [];
  const completedTasks: PmTask[] = [];
  const upcoming: PmTask[] = [];
  for (const task of tasks) {
    const done = isDoneStatus(task.status, byProject[task.projectId]);
    if (done) {
      if (task.updatedAt && dayDiff(task.updatedAt, today) <= HOME_ACTIVITY_WINDOW_DAYS && dayDiff(task.updatedAt, today) >= 0) {
        completedTasks.push(task);
      }
      continue;
    }
    if (!task.dueDate) continue;
    const diff = dayDiff(today, task.dueDate);
    if (diff === 0) todaysTodo.push(task);
    else if (diff > 0 && diff <= HOME_UPCOMING_WINDOW_DAYS) upcoming.push(task);
  }

  // "Tasks with Activity" — the column the plan calls out as the one that makes Home feel alive:
  // a `commented` work-activity row within the window, joined back to the comment's own body for
  // the excerpt (the activity row itself never carries the text — only `payload.commentId`).
  const since = isoDaysAgo(today, HOME_ACTIVITY_WINDOW_DAYS);
  // This is the PM-home projection, not the queue envelope: it has nowhere to render a lost-source
  // note, and a missing activity feed costs an "active tasks" column rather than hiding work the
  // viewer owes. The discarded name is collected so the call still type-checks against the same
  // helper — one settle(), one contract, rather than a second helper for the loose case.
  const activityLost: string[] = [];
  const activity = await settle("work activity", listWorkActivity(u, t, { since, limit: 200 }), activityLost);
  const commentedByTask = new Map<string, WorkActivityRow>();
  for (const row of activity) {
    if (row.verb !== "commented" || row.objectKind !== "pm_task") continue;
    const prev = commentedByTask.get(row.objectRef);
    if (!prev || row.occurredAt > prev.occurredAt) commentedByTask.set(row.objectRef, row);
  }
  const activeTaskIds = [...commentedByTask.keys()];
  const activeTasks = tasks.filter((tk) => activeTaskIds.includes(tk.id));
  const extraByTaskId = new Map<string, HomeExtra>();
  await Promise.all(
    activeTasks.map(async (tk) => {
      const row = commentedByTask.get(tk.id)!;
      const commentId = typeof row.payload?.commentId === "string" ? row.payload.commentId : undefined;
      if (!commentId) return;
      // Per-task comment fetch for an excerpt; a loss costs the excerpt, nothing owed.
      const comments = await settle("task comments", listTaskComments(u, t, tk.id), activityLost);
      const c = comments.find((cm: Comment) => cm.id === commentId);
      if (c) extraByTaskId.set(tk.id, { excerpt: excerpt(c.body), author: c.author_name ?? undefined });
    }),
  );

  return {
    today,
    windowLabel: homeWindowLabel(today),
    todaysTodo: todaysTodo.map((tk) => toHomeTask(tk, byProject, today)),
    completedTasks: completedTasks.map((tk) => toHomeTask(tk, byProject, today)),
    tasksWithActivity: toGroups(activeTasks, byProject, today, extraByTaskId),
    upcomingSchedule: toGroups(upcoming, byProject, today),
  };
}

/** Top-bar mine-scoped counters (P4-A9): Ball · Responsible · Reactions · Overdue.
 *
 *  ONE list read (`assignee=me`, already the union of ball-or-responsible on the backend — see
 *  `pm.controller.ts`'s `mine` clause) then pure client-side counting — NOT six separate list
 *  calls. `reactions` stays `null`: there is no BFF read today that answers "reactions on things I
 *  authored/commented on" (no endpoint, no notification type), so this returns "not available"
 *  rather than a fabricated 0 — see `PmCounters.tsx`'s header and this ticket's report. */
export async function getPmCounters(u: string, t: string, userId: string, today: string): Promise<PmCounterValues> {
  const mineLost: string[] = [];
  const mine = await settle("my PM tasks", listAllPmTasks(u, t, { assignee: "me" }), mineLost);
  let ball = 0;
  let responsible = 0;
  let overdue = 0;
  for (const task of mine) {
    const isBall = !!task.assignee && task.assignee.kind === "person" && task.assignee.refId === userId;
    const isResponsible = !!task.assignee && task.assignee.responsibleId === userId;
    if (isBall) ball += 1;
    if (isResponsible) responsible += 1;
    // KNOWN LIMIT, same convention as `fromPmTask` above: "done" is matched literally rather than
    // via each task's own project registry, so a project that renamed its done status still counts
    // an already-finished task here. Acceptable for a glanceable badge; not for a KPI.
    if (task.status !== "done" && taskUrgency({ dueDate: task.dueDate, isDone: false }, today) === "overdue") overdue += 1;
  }
  return { ball, responsible, reactions: null, overdue };
}
