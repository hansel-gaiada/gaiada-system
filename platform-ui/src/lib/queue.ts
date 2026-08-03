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
import { listAllPmTasks, type PmTask } from "./pm";
import { listAutomationApprovals, type AutomationApproval } from "./automationApprovals";
import { listInternalPendingGates, GATE_LABEL, type PipelineGate } from "./pipeline";
import { listNotifications, type NotificationItem } from "./entities";
import { mergeLegs, type Envelope } from "./envelope";
import { rankByUrgency, type QueueItem, type QueueItemType } from "./queueUrgency";

async function settle<T>(p: Promise<T[]>): Promise<T[]> {
  try {
    return await p;
  } catch {
    // Never let one failing source blank the whole queue (UX-2 §1.5 "Error
    // (one source fails)"). The underlying readers already degrade 404/403 to
    // [] themselves; this is the outer net for anything else (timeout, 500).
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

function fromAutomation(a: AutomationApproval, company: { id: string; name: string }, decidable: boolean): QueueItem {
  return {
    id: `automation:${a.id}`,
    type: "approval",
    origin: "automation",
    originId: a.id,
    title: a.tool_name,
    meta: a.reason ?? (a.origin === "agent" ? (a.agent_name ?? "Agent") : "Automation"),
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
        const [approvals, automation, gates, tasks, pmTasks, notifications] = await Promise.all([
          settle(getPendingApprovals(userId, [c])),
          settle(listAutomationApprovals(userId, c.id, { status: "pending" })),
          settle(listInternalPendingGates(userId, c.id)),
          settle(getMyTasks(userId, c.id)),
          settle(listAllPmTasks(userId, c.id, { assignee: "me" })),
          settle(listNotifications(userId, c.id, true)),
        ]);
        const rows: QueueItem[] = [
          ...approvals.map((a) => fromApproval(a, decidable)),
          ...automation.map((a) => fromAutomation(a, c, decidable)),
          ...gates.map((g) => fromGate(g, c, decidable)),
          ...tasks.filter((t) => t.status !== "done").map((t) => fromTask(t, c)),
          ...pmTasks.filter((t) => t.status !== "done").map((t) => fromPmTask(t, c)),
          ...notifications.filter(isMentionEligible).map((n) => fromMention(n, c)),
        ];
        return { company: c, ok: true, rows };
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
