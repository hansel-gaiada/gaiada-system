// The Overview's Me | Team switch for a head of department (DW-3h, docs/plans/2026-10-13-department-workspaces.md
// §3.4, DW-D8, DW-D15), as pure rules: who is offered the switch, how `?view=` is read, and the four Team blocks as
// data. No React and no server imports, so every rule here is a plain unit test.
//
// Nothing here is a security boundary. The switch is cosmetic: every Team read goes through the server, which narrows
// it to the units the person leads (`requiresUnitNarrowing`, `assertUnitInLedScope`, Cerbos `unitAncestors`).
//
// What Team mode changes (and where its numbers come from, each by a reader that says "No access" or "Unavailable"
// instead of turning a refusal into 0):
//   - Your numbers -> Team numbers:  the department's report document (`GET reports/document?grain=department`, which the
//                                    server narrows to the led unit) and the check-in compliance grid (`rollUpCompliance`).
//   - Needs you   -> Team needs you: the requests waiting on the department (`requests/summary`, DW-5) and the blocked tasks
//                                    of its open projects. These are what a head DECIDES or UNBLOCKS; the person's own
//                                    queue is Me mode.
//   - Learning    -> Team learning:  `lms compliance?unit=` (BFF §38, DW-4g).
//   - Appraisal   -> Team appraisals: `appraisals` list for a head (BFF §39, DW-4d).
// Not built here: the department's condition banner (DW-3k needs DW-4e's KPI targets).
import type { Me } from "./platform";
import { isLeadOf, leadUnits } from "./rbac";
import type { ReadResult } from "./readResult";
import type { ReportDocument, ReportKpi } from "./reports";
import { rollUpCompliance, type CheckinCompliance } from "./checkins";
import type { UnitComplianceResult } from "./lms";
import type { AppraisalStatus } from "./appraisals";
import { NO_DATA, formatDay, formatHours } from "./overviewNumbers";
import { computeProjectHealth } from "./departments";
import type { Milestone, PmTask, ProjectStatus } from "./pm";
import { requestsView, type RequestsView } from "./overviewWork";
import type { RequestSummary } from "./requests";

// ── The switch ───────────────────────────────────────────────────────────────────────────────────

export const OVERVIEW_VIEWS = ["me", "team"] as const;
export type OverviewView = (typeof OVERVIEW_VIEWS)[number];
export const DEFAULT_OVERVIEW_VIEW: OverviewView = "me";

/** Only the exact word `team` is Team; anything else, forged or repeated, reads as Me. A repeated param uses its first. */
export function parseOverviewView(raw: string | readonly string[] | null | undefined): OverviewView {
  const value = typeof raw === "string" || raw == null ? raw : raw[0];
  return value === "team" ? "team" : DEFAULT_OVERVIEW_VIEW;
}

/** Whether the person is a head of THIS workspace's unit: they hold `org_unit_lead` on the department or on a unit above
 *  it (`unitPath` is the unit and its ancestors; the server's rule cascades DOWN the led unit's subtree), in a company
 *  they belong to (node ids are unique only per company). A workspace without a unit of its own (HR, Finance, IT, and the
 *  Company frame) has nothing to lead, so no switch. A head of a unit INSIDE the department is not a head of the
 *  department. A mirror of the server, never the authority. */
export function canSwitchToTeam(
  me: Me,
  tenantId: string | null | undefined,
  subject: { deptId: string | null; unitPath: readonly string[] },
): boolean {
  if (!subject.deptId || !tenantId || subject.unitPath.length === 0) return false;
  if (!me.companies.some((c) => c.id === tenantId)) return false;
  return isLeadOf(me, subject.unitPath);
}

/** The view the page draws: `?view=team` counts only for someone who may switch. For anyone else it is ignored, so
 *  nothing about a team is ever read for them. */
export function resolveOverviewView(raw: string | readonly string[] | null | undefined, canSwitch: boolean): OverviewView {
  return canSwitch && parseOverviewView(raw) === "team" ? "team" : DEFAULT_OVERVIEW_VIEW;
}

export const OVERVIEW_VIEW_OPTIONS: readonly { key: OverviewView; label: string }[] = [
  { key: "me", label: "Me" },
  { key: "team", label: "Team" },
];

/** The link that selects a view, keeping the period. Query-only, so it resolves against the page it is on and works
 *  without JavaScript. Me drops `view`, since Me is the default. */
export function viewHref(period: string, view: OverviewView): string {
  const params = new URLSearchParams({ period });
  if (view === "team") params.set("view", "team");
  return `?${params.toString()}`;
}

/** The title a block carries in Team mode (for its skeleton and its error boundary); Me mode keeps the registry's own. */
const TEAM_TITLE: Readonly<Record<string, string>> = {
  "your-numbers": "Team numbers",
  "needs-you": "Team needs you",
  learning: "Team learning",
  appraisal: "Team appraisals",
};
export function widgetTitle(key: string, label: string, view: OverviewView): string {
  return (view === "team" && TEAM_TITLE[key]) || label;
}

/** The You band holds Team numbers in Team mode, so its quiet label says so. */
export function youBandLabel(view: OverviewView): string {
  return view === "team" ? "You and your team" : "You";
}

/** Whether the person leads exactly this department and nothing else. The check-in grid and the appraisal list are narrowed
 *  by the server to EVERYONE the person leads, not to one department; for a head of one unit that is this department, and
 *  otherwise the figure covers more, which the block must say. */
export function ledScopeIsThisUnit(me: Me, deptId: string | null): boolean {
  const led = leadUnits(me);
  return !!deptId && led.length === 1 && led[0] === deptId;
}

// ── Team numbers ─────────────────────────────────────────────────────────────────────────────────

export type TeamTileState = "ok" | "no-data" | "forbidden" | "unavailable";
export interface TeamTile {
  key: "check-ins" | "on-time" | "blocked" | "hours";
  label: string;
  state: TeamTileState;
  /** The figure, or "No data". Never a 0 the source did not state. */
  value: string;
  detail: string | null;
}

export type TeamNumbersView =
  | { kind: "ok"; periodLabel: string | null; tiles: TeamTile[]; note: string | null }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

const fmt = (n: number) => n.toLocaleString("en-US");
const percent = (v: number) => `${Math.round(v * 100)}%`;
const refused = (key: TeamTile["key"], label: string, state: "forbidden" | "unavailable"): TeamTile =>
  ({ key, label, state, value: state === "forbidden" ? "No access" : "Unavailable", detail: null });
const noData = (key: TeamTile["key"], label: string, detail: string | null = null): TeamTile =>
  ({ key, label, state: "no-data", value: NO_DATA, detail });

/** A ratio KPI as a tile: the figure only when it states both of its parts and measured something. */
function ratioKpi(kpi: ReportKpi | undefined): { value: number; numerator: number; denominator: number } | null {
  if (!kpi || !Number.isFinite(kpi.value)) return null;
  if (kpi.numerator === undefined || kpi.denominator === undefined || kpi.denominator === 0) return null;
  return { value: kpi.value, numerator: kpi.numerator, denominator: kpi.denominator };
}

/** The department document's tiles. Each key is the registry's own metric key (platform-nest `reports/metrics.ts`). */
function documentTiles(document: ReadResult<ReportDocument>): TeamTile[] {
  const specs = [
    { key: "on-time", label: "On time" },
    { key: "blocked", label: "Blocked share" },
    { key: "hours", label: "Hours vs capacity" },
  ] as const;
  if (document.kind !== "ok") return specs.map((s) => refused(s.key, s.label, document.kind));
  const kpi = (metricKey: string) => document.data.kpis.find((k) => k.metricKey === metricKey);

  const onTime = ratioKpi(kpi("delivery.on_time_rate"));
  // A task counts as blocked on the days its status says so; the share is blocked task-days over open task-days, so it is
  // shown as a share and its parts are NOT shown as "n of m tasks" (they are days, not tasks).
  const blocked = ratioKpi(kpi("flow.blocked_share"));
  // Capacity is the registry's own "logged minutes over expected calendar minutes" (`effort.capacity_utilization`): a
  // presence proxy, so the tile says "expected hours", not "capacity" in any headcount sense. Without that KPI there is no
  // capacity, and the tile is "No data": hours alone (`effort.minutes_logged`) are not hours AGAINST anything.
  const capacity = ratioKpi(kpi("effort.capacity_utilization"));

  return [
    onTime
      ? { key: "on-time", label: "On time", state: "ok", value: percent(onTime.value), detail: `${fmt(onTime.numerator)} of ${fmt(onTime.denominator)} tasks` }
      : noData("on-time", "On time"),
    blocked
      ? { key: "blocked", label: "Blocked share", state: "ok", value: percent(blocked.value), detail: "of open work, over the period" }
      : noData("blocked", "Blocked share"),
    capacity
      ? { key: "hours", label: "Hours vs capacity", state: "ok", value: `${formatHours(capacity.numerator)} of ${formatHours(capacity.denominator)}`, detail: `${percent(capacity.value)} of expected hours` }
      : noData("hours", "Hours vs capacity"),
  ];
}

/** The check-in tile, from the compliance grid. A grid of the caller's own row alone is the server's self-only fallback (BFF
 *  `checkins/compliance`: a caller with no lead tier gets one row, `unit: null`), not a team, and never becomes one here. A
 *  head's own grid names no unit when they are not placed in one, so `unit: null` alone is not the sign: the rows are. */
function checkinTile(compliance: ReadResult<CheckinCompliance>, wider: boolean, selfUserId: string): TeamTile {
  const label = "Check-ins sent";
  if (compliance.kind !== "ok") return refused("check-ins", label, compliance.kind);
  const { rows, unit } = compliance.data;
  if (unit === null && rows.length > 0 && rows.every((r) => r.userId === selfUserId)) {
    return { key: "check-ins", label, state: "unavailable", value: "Unavailable", detail: "The server answered for you alone, not for a team." };
  }
  const roll = rollUpCompliance(rows);
  // Nothing expected is "no data", never 0%: nobody was due is not nobody complied.
  if (roll.expected === 0) return noData("check-ins", label, "No check-in was due in this period");
  const scope = wider ? `${fmt(roll.people)} people you lead, more than this department` : `${fmt(roll.people)} ${roll.people === 1 ? "person" : "people"}`;
  return {
    key: "check-ins", label, state: "ok",
    value: `${fmt(roll.submitted)} of ${fmt(roll.expected)}`,
    detail: `${roll.rate === null ? "" : `${percent(roll.rate)} · `}${scope}`,
  };
}

/** Team numbers from the two reads. When BOTH failed the block says so as a whole; otherwise each tile says what ITS source
 *  said, so one refused read never hides the other's figures and never reads as 0. */
export function buildTeamNumbers(input: {
  document: ReadResult<ReportDocument>;
  compliance: ReadResult<CheckinCompliance>;
  /** The person leads more than this department (see `ledScopeIsThisUnit`). */
  wider: boolean;
  /** The signed-in person, to tell a team's grid from their own row alone. */
  selfUserId: string;
}): TeamNumbersView {
  const { document, compliance, wider, selfUserId } = input;
  if (document.kind !== "ok" && compliance.kind !== "ok") {
    return { kind: document.kind === "forbidden" && compliance.kind === "forbidden" ? "forbidden" : "unavailable" };
  }
  const [onTime, blocked, hours] = documentTiles(document);
  const history = document.kind === "ok" ? document.data.header.warnings?.precedesFactHistory : undefined;
  return {
    kind: "ok",
    periodLabel: document.kind === "ok" ? document.data.header.periodLabel : null,
    tiles: [checkinTile(compliance, wider, selfUserId), onTime, blocked, hours],
    note: history ? `These numbers cover only part of this period: records begin on ${formatDay(history.firstFactDate)}.` : null,
  };
}

// ── Team needs you ───────────────────────────────────────────────────────────────────────────────

export interface BlockedProject { id: string; name: string; blocked: number }
export type BlockedReading = { kind: "ok"; blocked: number } | { kind: "forbidden" } | { kind: "unavailable" };

/** One project's blocked-task count from what its work read said. A failed read is its own state, never "0 blocked". The
 *  flag is the project's OWN status registry's `isBlocked`, the same rule the Projects block's health uses. */
export function blockedReading(
  work: ReadResult<{ tasks: PmTask[]; milestones: Milestone[]; statuses: ProjectStatus[] }>,
  now: Date,
): BlockedReading {
  if (work.kind !== "ok") return { kind: work.kind };
  const { tasks, milestones, statuses } = work.data;
  const h = computeProjectHealth(tasks, milestones.map((m) => ({ name: m.name, dueDate: m.dueDate, status: m.status })), now, statuses);
  return { kind: "ok", blocked: h.composition.blocked };
}

export const BLOCKED_PROJECTS_SHOWN = 3;

export type BlockersView =
  | {
    kind: "ok";
    /** Blocked tasks across the projects that could be read. */
    total: number;
    /** The projects with something blocked, the most first. */
    projects: BlockedProject[];
    /** Open projects whose work could not be read: their blocked count is not known, so `total` is a floor, never a claim. */
    unread: number;
    open: number;
  }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** The blockers of the department's open projects. `rows` are the open projects and what each work read said. An empty list
 *  is a real "no open project" (the list read succeeded); when no project at all could be read the whole is the refusal. */
export function blockersView(rows: readonly { id: string; name: string; reading: BlockedReading }[]): BlockersView {
  if (rows.length === 0) return { kind: "ok", total: 0, projects: [], unread: 0, open: 0 };
  const readable = rows.flatMap((r) => (r.reading.kind === "ok" ? [{ id: r.id, name: r.name, blocked: r.reading.blocked }] : []));
  if (readable.length === 0) return { kind: rows.every((r) => r.reading.kind === "forbidden") ? "forbidden" : "unavailable" };
  return {
    kind: "ok",
    total: readable.reduce((n, r) => n + r.blocked, 0),
    projects: readable.filter((r) => r.blocked > 0).sort((a, b) => b.blocked - a.blocked || a.name.localeCompare(b.name)).slice(0, BLOCKED_PROJECTS_SHOWN),
    unread: rows.length - readable.length,
    open: rows.length,
  };
}

export interface TeamNeedsYou { requests: RequestsView; blockers: BlockersView }

/** The two honest sources of "what the team is waiting on": what waits on the department (the decisions a head makes) and
 *  what is blocked in its projects. Each keeps its own read state. */
export function buildTeamNeedsYou(input: { requests: ReadResult<RequestSummary>; blockers: BlockersView; now: Date }): TeamNeedsYou {
  return { requests: requestsView(input.requests, input.now), blockers: input.blockers };
}

// ── Team learning (BFF §38) ──────────────────────────────────────────────────────────────────────

export type TeamLearningView =
  | {
    kind: "ok";
    /** The roster size, so "0 assigned" is never read as "nobody here". */
    learners: number;
    /** Over the MANDATORY paths only, like the Team progress page. */
    assigned: number;
    completed: number;
    outstanding: number;
    overdue: number;
    /** Completed over assigned, in whole percent; null when nothing mandatory is assigned (not "100%", not "0%"). */
    coverage: number | null;
  }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** `getUnitCompliance`'s answer as a view. `not_found` (the department is not in the org tree) and `error` are both "cannot
 *  tell"; neither is an empty table. Waived is not a completion: it counts toward neither side. */
export function teamLearningView(res: UnitComplianceResult): TeamLearningView {
  if (res.kind === "forbidden") return { kind: "forbidden" };
  if (res.kind !== "ok") return { kind: "unavailable" };
  const mandatory = res.data.paths.filter((p) => p.isMandatory);
  const sum = (pick: (p: (typeof mandatory)[number]) => number) => mandatory.reduce((n, p) => n + pick(p), 0);
  const assigned = sum((p) => p.assigned);
  const completed = sum((p) => p.completed);
  return {
    kind: "ok",
    learners: res.data.learners,
    assigned,
    completed,
    outstanding: sum((p) => p.outstanding),
    overdue: sum((p) => p.overdue),
    coverage: assigned > 0 ? Math.round((completed / assigned) * 100) : null,
  };
}

// ── Team appraisals (BFF §39) ────────────────────────────────────────────────────────────────────

export interface TeamAppraisalCounts {
  total: number;
  cycles: number;
  draft: number;
  submitted: number;
  acknowledged: number;
  disputed: number;
  finalized: number;
}
export type TeamAppraisalsView = ({ kind: "ok" } & TeamAppraisalCounts) | { kind: "forbidden" } | { kind: "unavailable" };

const countOf = (rows: readonly { status: AppraisalStatus }[], s: AppraisalStatus) => rows.filter((r) => r.status === s).length;

/** The list a head reads is the people they lead PLUS the rows they are the manager of (BFF §39), with no cycle name and no
 *  unit filter. So this is progress over "the appraisals you lead or score", counted by status, and the cycles are only
 *  counted: a cycle's name needs the HR-only cycle read, which a head does not have. An empty `ok` is a real "none yet". */
export function teamAppraisalsView(
  result: ReadResult<{ appraisals: readonly { cycleId: string; status: AppraisalStatus }[] }>,
): TeamAppraisalsView {
  if (result.kind !== "ok") return { kind: result.kind };
  const rows = result.data.appraisals;
  return {
    kind: "ok",
    total: rows.length,
    cycles: new Set(rows.map((r) => r.cycleId)).size,
    draft: countOf(rows, "draft"),
    submitted: countOf(rows, "submitted"),
    acknowledged: countOf(rows, "acknowledged"),
    disputed: countOf(rows, "disputed"),
    finalized: countOf(rows, "finalized"),
  };
}

/** The unfinished part in words, only the states that have someone in them: "2 being scored, 1 awaiting acknowledgement". */
export function appraisalBreakdown(c: TeamAppraisalCounts): string {
  const parts: [number, string][] = [
    [c.draft, "being scored"],
    [c.submitted, "awaiting acknowledgement"],
    [c.acknowledged, "acknowledged, awaiting HR"],
    [c.disputed, "disputed"],
  ];
  return parts.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`).join(", ");
}
