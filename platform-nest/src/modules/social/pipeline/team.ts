// SCP-5d — the pure side of `GET team?month=YYYY-MM`, the Social Media Team dashboard's one read (BFF §63.19). No I/O here: `team-data.ts` reads,
// `team.controller.ts` gates, reads each section on its own and answers.
//
// NOTHING IS RETYPED. Who holds a post is the stage machine's `holderOf` (the fixture's `holders`) through the feed's `holderRoleOf`; whose turn
// a post is, is the feed's `isYourTurn`; a post's health is the feed's `healthOfCandidate` (schedule-health.ts); working days are
// `workingDaysBetween` over the company's HR calendar. So the dashboard, the feed and the Pulse cannot disagree about who holds what or what is late.
//
// WHAT WAITS, AND FOR WHOM (BFF §63.19, plan §4.4). A post's wait is counted against ITS HOLDER, the role the fixture names for its status, never the
// officer for time the post sat with someone else: a post in `proofread` waits on the copywriters, in `hod` or `final` on the approvers, in `client` on the
// client, in `design` (and a design change) on the designer, a `blocked` post on whoever it waits on (`block_waiting_on`, `external` included), and
// `planned`, `drafting`, `approved` and a team copy change on the officer. A `scheduled` or `live` post waits on nobody (it is at its time, or done), and a
// publisher-held post is the publisher's, not a person's: they are in no wait and no workload.
// A person's row counts the posts that are THEIR turn by the feed's own rule (`isYourTurn`), so a copywriter's holding is the proofread queue they could
// take (every copywriter sees the same queue; the role's `posts` counts each post once), and an approver never holds a post they made.
import type { WorkingCalendar } from "../../hr/working-days";
import { SCP } from "./fixture";
import type { FeedCandidate } from "./feed-data";
import { healthOfCandidate, holderRoleOf, isYourTurn } from "./feed";
import { HOLDER_LABELS } from "./pipeline-read";
import { lastDayOfMonth, previousMonth, workingDaysBetween, type ApprovalSample, type Health } from "./schedule-health";
import type { CycleTable, EngagementRow } from "./cycles-data";
import type { BoostWaitingRow, FailedPostRow, ReportDueRow, ReportToCheckRow, StepMove } from "./team-data";
import { todayIsoInTz } from "../../reports/person-scope";

// ── the shape (BFF §63.19) ─────────────────────────────────────────────────────────────────────────────────────────────────

export type AttentionKind = "late" | "at_risk" | "blocked" | "failed_post" | "boost_waiting" | "report_due" | "report_to_check";
/** The order the list is drawn in: what is already late first, the reports last. */
export const ATTENTION_ORDER: readonly AttentionKind[] = ["late", "at_risk", "blocked", "failed_post", "boost_waiting", "report_due", "report_to_check"];

export interface AttentionItem {
  kind: AttentionKind;
  postId?: string;
  reportId?: string;
  boostId?: string;
  engagementId: string;
  clientName: string;
  title?: string;
  /** ISO timestamp, or the first day of the month for a report that is due. */
  since: string;
  holder?: { role: string; label: string };
}

export type WorkloadRole = "officer" | "copywriter" | "designer" | "approver";
export type WaitRole = "officer" | "copywriter" | "approver" | "designer" | "client" | "external";
export const WORKLOAD_ROLES: readonly WorkloadRole[] = ["officer", "copywriter", "designer", "approver"];
export const WAIT_ROLES: readonly WaitRole[] = ["officer", "copywriter", "approver", "designer", "client", "external"];

/** One person's row: id, name and counts, nothing else (no sign-in, no e-mail). */
export interface WorkloadRow { userId: string; name: string; role: WorkloadRole; holding: number; late: number; oldestSince: string | null }
export interface WaitPerson { userId: string; name: string; posts: number; oldestSince: string | null }
export interface WaitRow { holderRole: WaitRole; posts: number; oldestSince: string | null; averageWorkingDays: number | null; people: WaitPerson[] }
export interface StepAverage { step: string; averageWorkingDays: number; samples: number }
export interface ClientRow {
  engagementId: string; clientName: string; officer: { id: string; name: string } | null;
  target: number | null; counted: number; approved: number; live: number; extra: number; stories: number; health: Health | null;
}

export interface TeamAnswer {
  month: string;
  needsAttention: AttentionItem[];
  clients: ClientRow[];
  workload: WorkloadRow[];
  waits: WaitRow[];
  stepAverages: StepAverage[];
  estimatesNotSet: Array<{ engagementId: string; clientName: string }>;
  personRowsLimited: boolean;
  partial: string[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const minIso = (a: string | null, b: string): string => (a === null || b < a ? b : a);

// ── simulated rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The overview's rule: while simulated rows are left out, a pipeline post is out when it says so itself or any live variant does. */
export const isVisible = (c: Pick<FeedCandidate, "id" | "simulated">, includeSimulated: boolean, simulatedIds: ReadonlySet<string>): boolean =>
  includeSimulated || !(c.simulated || simulatedIds.has(c.id));

// ── needs attention ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PostCtx {
  today: string;
  tz: string;
  calendar: WorkingCalendar;
  samples: Map<string, ApprovalSample[]>;
  includeSimulated: boolean;
  simulatedIds: ReadonlySet<string>;
}

const holderOfCandidate = (c: FeedCandidate): { role: string; label: string } | undefined => {
  const role = holderRoleOf(c);
  return role === null ? undefined : { role, label: HOLDER_LABELS[role] ?? role };
};

/** Late, at risk and blocked posts. A post that is blocked and late is both (two kinds, one post). PURE. */
export function postAttention(candidates: readonly FeedCandidate[], ctx: PostCtx): AttentionItem[] {
  const slowerCache = new Map<string, boolean>();
  const out: AttentionItem[] = [];
  for (const c of candidates) {
    if (!isVisible(c, ctx.includeSimulated, ctx.simulatedIds)) continue;
    const state = healthOfCandidate(c, ctx.today, ctx.calendar, ctx.samples, slowerCache)?.state;
    const holder = holderOfCandidate(c);
    const base = { postId: c.id, engagementId: c.engagementId, clientName: c.clientName, title: c.title, since: c.statusSince, ...(holder ? { holder } : {}) };
    if (state === "late") out.push({ kind: "late", ...base });
    else if (state === "at_risk") out.push({ kind: "at_risk", ...base });
    if (c.pipelineStatus === "blocked") out.push({ kind: "blocked", ...base });
  }
  return out;
}

export const failedAttention = (rows: readonly FailedPostRow[]): AttentionItem[] =>
  rows.map((r) => ({ kind: "failed_post", postId: r.postId, engagementId: r.engagementId, clientName: r.clientName, title: r.title, since: r.since }));

export const boostAttention = (rows: readonly BoostWaitingRow[]): AttentionItem[] =>
  rows.map((r) => ({ kind: "boost_waiting", postId: r.postId, boostId: r.boostId, engagementId: r.engagementId, clientName: r.clientName, title: r.title, since: r.since }));

const KIND_LABEL: Record<string, string> = { monthly: "Monthly", campaign: "Campaign", adhoc: "Ad hoc" };

/**
 * The reports' two kinds. Report due, as ruled by the orchestrator for `GET team?month=M` (the contract left it open; the UI and demo follow it):
 *   - only period M-1's monthly report is looked at (the facts hold exactly that): an older overdue report does not carry into later months;
 *   - it is due only once the engagement's `report_due_day` in M has been reached: the day is clamped to M's last day (§63.1: a day past the month's
 *     end means its last day), and `today` (the company's report day) must be on or after it. A past M always qualifies, a future M never does;
 *   - `since` is the first of M, and `reportId` is omitted when no row exists.
 * Report to check: the reports in review.
 */
export function reportAttention(
  month: string, facts: { due: readonly ReportDueRow[]; toCheck: readonly ReportToCheckRow[] }, today: string,
): AttentionItem[] {
  const period = previousMonth(month);
  const last = lastDayOfMonth(month);
  const reached = (day: number): boolean => {
    const dueOn = `${month}-${String(Math.min(day, Number(last.slice(8, 10)))).padStart(2, "0")}`;
    return today >= dueOn;
  };
  const out: AttentionItem[] = facts.due.filter((r) => reached(r.reportDueDay)).map((r) => ({
    kind: "report_due" as const, ...(r.reportId ? { reportId: r.reportId } : {}), engagementId: r.engagementId, clientName: r.clientName,
    title: `Monthly report ${period}`, since: `${month}-01`,
  }));
  for (const r of facts.toCheck) {
    out.push({
      kind: "report_to_check", reportId: r.reportId, engagementId: r.engagementId, clientName: r.clientName,
      title: `${KIND_LABEL[r.kind] ?? r.kind} report${r.period ? ` ${r.period}` : ""}`, since: r.since,
    });
  }
  return out;
}

const idOfItem = (i: AttentionItem): string => i.boostId ?? i.postId ?? i.reportId ?? i.engagementId;

/** The list's order: by kind (`ATTENTION_ORDER`), then the longest in that state first, then client, then id: a total order. */
export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const k = ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    if (a.since !== b.since) return a.since < b.since ? -1 : 1;
    if (a.clientName !== b.clientName) return a.clientName < b.clientName ? -1 : 1;
    const x = idOfItem(a), y = idOfItem(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// ── clients, estimates ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The clients' rows from the month's deadline table (the table `GET cycles` answers, one source). `approved` is the posts PAST the client's approval
 * (approved, scheduled and live: the content-month task's own "past", content-month-progress.ts), `live` the live ones among them; `counted` leaves out
 * stories and extra posts, which are `stories` and `extra`. A client with no cycle or no post has no health.
 */
export function clientRows(table: CycleTable): ClientRow[] {
  return table.rows.map((r) => ({
    engagementId: r.engagementId, clientName: r.clientName, officer: r.officer, target: r.target,
    counted: r.counts.counted, approved: r.counts.approved + r.counts.scheduled + r.counts.live, live: r.counts.live,
    extra: r.counts.extra, stories: r.counts.stories, health: r.health,
  }));
}

/** Engagements with none of the six step estimates set (so health can only say ready-by, plan §4.4). */
export const estimatesNotSet = (engagements: readonly EngagementRow[]): Array<{ engagementId: string; clientName: string }> =>
  engagements.filter((e) => Object.keys(e.stepEstimates).length === 0).map((e) => ({ engagementId: e.id, clientName: e.clientName }));

// ── who holds what ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The people who could hold a post: the sources of the roster, every id lower-case. */
export interface Roster {
  officers: readonly string[];
  copywriters: readonly string[];
  /** The live lead-seat holders of the Social Media and GM units. */
  approvers: readonly string[];
  inTeamDesigners: readonly string[];
  /** Month request id -> the assignees of its PM task (the Creatives designers). */
  assigneesByRequest: ReadonlyMap<string, readonly string[]>;
  names: ReadonlyMap<string, string>;
}

/** A post that waits on nobody: at its time, or done. */
const NOT_WAITING: ReadonlySet<string> = new Set(["scheduled", "live"]);

const isWaitRole = (r: string | null): r is WaitRole => r !== null && (WAIT_ROLES as readonly string[]).includes(r);

/** The people of `role` who could take `c` (the roster's, before `isYourTurn` removes a maker). */
function takersOf(role: WorkloadRole, c: FeedCandidate, roster: Roster): readonly string[] {
  switch (role) {
    case "officer": return c.ownerId ? [c.ownerId] : [];
    case "copywriter": return roster.copywriters;
    case "approver": return roster.approvers;
    case "designer":
      return c.creativeSource === "in_team" ? roster.inTeamDesigners
        : c.creativeSource === "creatives" && c.creativeRequestId ? roster.assigneesByRequest.get(c.creativeRequestId) ?? [] : [];
  }
}

/** The waits per holder role and the workload per person and role. Every roster person has a row (zero included: a free copywriter is information). PURE. */
export function composeHoldings(
  candidates: readonly FeedCandidate[], ctx: PostCtx, roster: Roster,
): { waits: WaitRow[]; workload: WorkloadRow[] } {
  const slowerCache = new Map<string, boolean>();
  const dayOf = (isoTs: string): string => todayIsoInTz(ctx.tz, new Date(isoTs));

  const rolePosts = new Map<WaitRole, Array<{ since: string; waited: number }>>();
  const rows = new Map<string, WorkloadRow>();
  const rowOf = (role: WorkloadRole, userId: string): WorkloadRow => {
    const key = `${role}|${userId}`;
    let r = rows.get(key);
    if (!r) {
      r = { userId, name: roster.names.get(userId) ?? "Someone", role, holding: 0, late: 0, oldestSince: null };
      rows.set(key, r);
    }
    return r;
  };
  for (const id of roster.officers) rowOf("officer", id);
  for (const id of roster.copywriters) rowOf("copywriter", id);
  for (const id of roster.approvers) rowOf("approver", id);
  for (const id of roster.inTeamDesigners) rowOf("designer", id);
  for (const ids of roster.assigneesByRequest.values()) for (const id of ids) rowOf("designer", id);

  for (const c of candidates) {
    if (!isVisible(c, ctx.includeSimulated, ctx.simulatedIds) || NOT_WAITING.has(c.pipelineStatus)) continue;
    const holder = holderRoleOf(c);
    if (!isWaitRole(holder)) continue; // nobody (live) or the publisher
    const list = rolePosts.get(holder) ?? [];
    list.push({ since: c.statusSince, waited: workingDaysBetween(dayOf(c.statusSince), ctx.today, ctx.calendar) });
    rolePosts.set(holder, list);
    if (holder === "client" || holder === "external") continue;
    const late = healthOfCandidate(c, ctx.today, ctx.calendar, ctx.samples, slowerCache)?.state === "late";
    for (const userId of takersOf(holder, c, roster)) {
      const cand = c.iAmAssignee === false ? { ...c, iAmAssignee: roster.assigneesByRequest.get(c.creativeRequestId ?? "")?.includes(userId) === true } : c;
      const who = { userId, isCopywriter: holder === "copywriter", isSeatApprover: holder === "approver", isInTeamDesigner: holder === "designer" };
      if (!isYourTurn(cand, holder, who)) continue;
      const row = rowOf(holder, userId);
      row.holding += 1;
      if (late) row.late += 1;
      row.oldestSince = minIso(row.oldestSince, c.statusSince);
    }
  }

  const workload = [...rows.values()].sort((a, b) =>
    WORKLOAD_ROLES.indexOf(a.role) - WORKLOAD_ROLES.indexOf(b.role) || b.holding - a.holding
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  const waits = WAIT_ROLES.map((role): WaitRow => {
    const posts = rolePosts.get(role) ?? [];
    let oldest: string | null = null;
    let total = 0;
    for (const p of posts) { oldest = minIso(oldest, p.since); total += p.waited; }
    const people = role === "client" || role === "external" ? [] : workload
      .filter((w) => w.role === role && w.holding > 0)
      .map((w): WaitPerson => ({ userId: w.userId, name: w.name, posts: w.holding, oldestSince: w.oldestSince }))
      .sort((a, b) => (a.oldestSince ?? "") < (b.oldestSince ?? "") ? -1 : (a.oldestSince ?? "") > (b.oldestSince ?? "") ? 1 : b.posts - a.posts
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.userId < b.userId ? -1 : 1));
    return { holderRole: role, posts: posts.length, oldestSince: oldest, averageWorkingDays: posts.length === 0 ? null : round2(total / posts.length), people };
  });
  return { waits, workload };
}

/**
 * The privacy gate on the per-person rows (BFF §63.19, SCP-Q19). `shown` is every person whose row may be drawn: the Social Media unit's people and
 * whoever the DW-4 person-axis gate passed. A row of anyone else is left out. `limited` is true when a row was left out because the gate DENIED that
 * person (`denied`); a person left out because the gate could not answer (an error) is left out too, but that is the caller's `partial`, not `limited`.
 * The role totals of `waits` stay as they are (team-level, no person). PURE.
 */
export function narrowPeople(
  held: { waits: readonly WaitRow[]; workload: readonly WorkloadRow[] }, shown: ReadonlySet<string>, denied: ReadonlySet<string>,
): { waits: WaitRow[]; workload: WorkloadRow[]; limited: boolean } {
  let limited = false;
  const keep = (userId: string): boolean => {
    if (shown.has(userId)) return true;
    if (denied.has(userId)) limited = true;
    return false;
  };
  const workload = held.workload.filter((w) => keep(w.userId));
  const waits = held.waits.map((w) => ({ ...w, people: w.people.filter((p) => keep(p.userId)) }));
  return { waits, workload, limited };
}

// ── step averages ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The mean working days a post spent in each step it LEFT in the month, in the fixture's status order; a step with no sample is not listed. PURE. */
export function stepAverages(moves: readonly StepMove[], calendar: WorkingCalendar): StepAverage[] {
  const by = new Map<string, { total: number; n: number }>();
  for (const m of moves) {
    const e = by.get(m.step) ?? { total: 0, n: 0 };
    e.total += workingDaysBetween(m.enteredOn, m.leftOn, calendar);
    e.n += 1;
    by.set(m.step, e);
  }
  return SCP.statuses.filter((s) => by.has(s)).map((step) => {
    const e = by.get(step)!;
    return { step, averageWorkingDays: round2(e.total / e.n), samples: e.n };
  });
}

/** The first and last company day of `month` (`YYYY-MM`). */
export const monthRange = (month: string): { from: string; to: string } => ({ from: `${month}-01`, to: lastDayOfMonth(month) });
