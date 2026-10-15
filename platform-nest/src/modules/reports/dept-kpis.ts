// DW-4e-1 — the department KPI catalogue and condition engine (docs/FRONTEND-BFF-CONTRACT.md §40.1 and §40.3; plan
// docs/plans/2026-10-13-department-workspaces.md §5.5, owner ruling DW-Q4). PURE: no I/O, no Nest. The service
// (dept-kpi-targets.ts) and the controller (dept-kpis.controller.ts) do the reading; this file only decides.
//
// ══════════════════════════ ONE SOURCE, ON THE SERVER ══════════════════════════
// Every KPI definition lives here, keyed by WORKSPACE SLUG, in the order and with the keys of the UI registry's `kpis`
// (platform-ui/src/lib/workspaces.ts). `dept-kpis.test.ts` reads that file as text and pins the two key lists equal,
// so a KPI added on one side and not the other fails the build. The UI keeps its labels for display order only;
// values, targets and conditions come from the API this file feeds.
//
// ══════════════════════════ READERS: A KPI IS NEVER GIVEN A NUMBER IT DOES NOT HAVE ══════════════════════════
// A KPI's `reader` says where its value comes from:
//   - `report_fact`: a metric of the report document (the department-grain document for the unit, or the company
//     document for `utilization`), so the number is the one the Reports page shows;
//   - `derived`: departments-in-good-condition, the share of the OTHER departments whose condition is on track;
//   - `module`: a module read. Without a `readerId` it does not exist yet and the KPI reads `unavailable` (reason
//     `no_reader`) until its own ticket adds the read; with one, the id names a reader in dept-kpi-readers.ts and the KPI
//     behaves like a report_fact KPI (§40.5.1). §40.1's table names the only report_fact KPIs in 4e-1; every other KPI is
//     `module`. The id is only a string here: this file stays pure.
//
// ══════════════════════════ SCALES ══════════════════════════
// `percent` values, targets and tolerances are FRACTIONS (0.85 = 85%), the scale of the report document's own
// `value`. `minutes` is a duration (turnaround, time to hire). `count` is a level (a point-in-time count, or an
// average such as revision rounds). Targets are LEVELS, so one target applies to a month, a quarter, a semester or a
// year alike (§40.2). The one starting-set KPI that is a VOLUME, `assets-delivered`, scales with the period's length,
// so it gets no suggested target: whoever adds its reader decides how a volume target works.
import { packFor } from "../../core/packs";
import type { ReportDocument } from "./report-document";
import { unwrapOrgRoot, type UnitTreeNode } from "./person-scope";

export type KpiUnit = "percent" | "count" | "minutes";
export type KpiDirection = "up_good" | "down_good";

export type KpiReader =
  | { kind: "report_fact"; metricKey: string; grain: "department" | "company" }
  | { kind: "derived"; source: "departments_in_good_condition" }
  | { kind: "module"; readerId?: string };

export interface DeptKpiDef {
  key: string;
  label: string;
  unit: KpiUnit;
  direction: KpiDirection;
  reader: KpiReader;
  /** Pre-fills a proposal only; never in force (§40.2). `null` when no level makes sense yet. */
  suggestedTarget: number | null;
  suggestedTolerance: number | null;
}

export const WORKSPACE_SLUGS = ["web-dev", "seo", "social-media", "creatives", "gm", "hr", "finance", "it", "generic"] as const;
export type WorkspaceSlug = (typeof WORKSPACE_SLUGS)[number];

/** A module KPI whose reader exists: `readerId` names it in dept-kpi-readers.ts (§40.5.1). */
const read = (readerId: string): KpiReader => ({ kind: "module", readerId });
const dept = (metricKey: string): KpiReader => ({ kind: "report_fact", metricKey, grain: "department" });

const pct = (key: string, label: string, direction: KpiDirection, reader: KpiReader, target: number, tolerance: number): DeptKpiDef => ({
  key, label, unit: "percent", direction, reader, suggestedTarget: target, suggestedTolerance: tolerance,
});

const DAY = 1440; // minutes

/** §40.1: the starting sets, plan §5.5's table, keyed by workspace slug, in the UI registry's order. */
export const DEPT_KPI_SETS: Readonly<Record<WorkspaceSlug, readonly DeptKpiDef[]>> = {
  "web-dev": [
    pct("projects-on-time", "Projects on time", "up_good", dept("delivery.milestone_hit_rate"), 0.85, 0.05),
    pct("requests-within-sla", "Requests delivered by the date needed", "up_good", read("webdev.requests_delivered_by_needed"), 0.9, 0.05),
    pct("client-site-uptime", "Client site uptime", "up_good", read("monitoring.client_uptime"), 0.995, 0.005),
    pct("reopened-work-rate", "Reopened work rate", "down_good", dept("flow.reopen_rate"), 0.05, 0.03),
  ],
  seo: [
    pct("clients-ranking-growth", "Clients with ranking growth", "up_good", read("search.clients_ranking_growth"), 0.7, 0.1),
    pct("client-reports-on-time", "Client reports delivered on time", "up_good", read("search.client_reports_on_time"), 0.95, 0.05),
    pct("ad-budgets-on-pace", "Ad budgets on pace", "up_good", read("search.ad_budgets_on_pace"), 0.9, 0.05),
    pct("client-retention", "Client retention", "up_good", read("clients.retention"), 0.9, 0.05),
  ],
  "social-media": [
    pct("posts-on-schedule", "Posts published on schedule", "up_good", read("social.posts_on_schedule"), 0.95, 0.05),
    { key: "client-approval-turnaround", label: "Client approval turnaround", unit: "minutes", direction: "down_good", reader: read("social.client_approval_turnaround"), suggestedTarget: 2 * DAY, suggestedTolerance: DAY },
    pct("engagement-growth", "Engagement growth across clients", "up_good", read("social.engagement_growth"), 0.05, 0.05),
  ],
  creatives: [
    pct("asset-requests-on-time", "Asset requests delivered on time", "up_good", read("creatives.asset_requests_on_time"), 0.9, 0.05),
    { key: "revision-rounds", label: "Revision rounds per asset", unit: "count", direction: "down_good", reader: read("creatives.revision_rounds"), suggestedTarget: 2, suggestedTolerance: 1 },
    { key: "assets-delivered", label: "Assets delivered", unit: "count", direction: "up_good", reader: read("creatives.assets_delivered"), suggestedTarget: null, suggestedTolerance: null },
  ],
  gm: [
    pct("revenue-vs-plan", "Revenue against plan", "up_good", read("gm.revenue_vs_plan"), 1, 0.05),
    pct("margin", "Margin", "up_good", read("gm.margin"), 0.3, 0.05),
    pct("utilization", "Utilization", "up_good", { kind: "report_fact", metricKey: "effort.capacity_utilization", grain: "company" }, 0.8, 0.1),
    pct("departments-in-good-condition", "Departments in good condition", "up_good", { kind: "derived", source: "departments_in_good_condition" }, 0.8, 0.2),
  ],
  hr: [
    pct("leave-decided-2d", "Leave decided within 2 days", "up_good", read("hr.leave_decided_2d"), 0.95, 0.05),
    pct("payroll-on-time", "Payroll published on time", "up_good", read("hr.payroll_on_time"), 1, 0),
    { key: "time-to-hire", label: "Time to hire", unit: "minutes", direction: "down_good", reader: read("hr.time_to_hire"), suggestedTarget: 30 * DAY, suggestedTolerance: 10 * DAY },
    pct("mandatory-learning", "Mandatory learning complete", "up_good", read("hr.mandatory_learning"), 1, 0.05),
  ],
  finance: [
    pct("close-on-time", "Period closed on time", "up_good", read("finance.close_on_time"), 1, 0),
    pct("overdue-receivables-share", "Overdue receivables share", "down_good", read("finance.overdue_receivables_share"), 0.1, 0.05),
    pct("payments-confirmed-1d", "Client payments confirmed within 1 day", "up_good", read("finance.payments_confirmed_1d"), 0.95, 0.05),
  ],
  it: [
    pct("uptime", "Device and network uptime", "up_good", read("it.uptime"), 0.995, 0.005),
    pct("requests-within-sla", "Account and device requests resolved within the SLA", "up_good", read("it.leaver_access_closed"), 0.9, 0.05),
    { key: "open-threat-alerts", label: "Open threat alerts", unit: "count", direction: "down_good", reader: read("it.devices_alerting"), suggestedTarget: 0, suggestedTolerance: 2 },
  ],
  generic: [
    pct("projects-on-time", "Projects on time", "up_good", dept("delivery.milestone_hit_rate"), 0.85, 0.05),
    { key: "overdue-tasks", label: "Overdue tasks", unit: "count", direction: "down_good", reader: dept("discipline.overdue_open"), suggestedTarget: 0, suggestedTolerance: 3 },
    pct("check-in-compliance", "Check-in compliance", "up_good", dept("discipline.checkin_compliance"), 0.9, 0.05),
  ],
};

/** The definition of `kpiKey` in a workspace's set, or undefined when it is not one of that set's KPIs. */
export function kpiDefFor(slug: WorkspaceSlug, kpiKey: string): DeptKpiDef | undefined {
  return DEPT_KPI_SETS[slug].find((d) => d.key === kpiKey);
}

// ══════════════════════════ WORKSPACE RESOLUTION (the server twin of `workspaceFor`) ══════════════════════════

/** Port of platform-ui `deptSlug` (src/lib/deptToolkits.ts): "Web Dev" -> "web-dev". Byte-identical rule. */
export function deptSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** HR, Finance and IT exist in every vertical (platform-ui workspaces.ts `FUNCTIONAL_SLUGS`). */
export const FUNCTIONAL_SLUGS: readonly WorkspaceSlug[] = ["hr", "finance", "it"];

/** The workspace of a department named `deptName` in a company of `vertical`, resolved exactly as platform-ui's
 *  `workspaceFor` does: the functional slugs in every vertical; a bespoke workspace only when the vertical's pack
 *  lists the slug (PV-D15, `packFor(...).toolkitDepartments`); anything else is generic. Both sides pin one golden
 *  table of (vertical, name -> slug) rows: dept-kpis.test.ts here, dept-workspace-slugs.test.ts in platform-ui. */
export function workspaceSlugFor(vertical: string | null | undefined, deptName: string): WorkspaceSlug {
  const slug = deptSlug(deptName);
  if ((FUNCTIONAL_SLUGS as readonly string[]).includes(slug)) return slug as WorkspaceSlug;
  if (packFor(vertical).toolkitDepartments.includes(slug) && Object.prototype.hasOwnProperty.call(DEPT_KPI_SETS, slug)) {
    return slug as WorkspaceSlug;
  }
  return "generic";
}

// ══════════════════════════ CONDITION (§40.3) ══════════════════════════

export type KpiCondition = "on_track" | "at_risk" | "off_track" | "unavailable";
/** Why a KPI has no condition: no reader yet, no data in the window, no target in force, or its reader threw
 *  (`read_failed`, §40.5.1: set by the engine, never by `kpiCondition`). */
export type UnavailableReason = "no_reader" | "no_data" | "no_target" | "read_failed";

export interface KpiTargetLevel {
  target: number;
  tolerance: number;
}

/** Comparisons are on derived floating-point ratios (17/20, 0.85 - 0.8): a gap equal to the tolerance must read as
 *  "within", not miss by 5e-17. One billionth is far below any meaningful KPI difference. */
const EPSILON = 1e-9;

/**
 * PURE. One KPI's condition given its value and the target in force (§40.3):
 *   on track  — at or better than the target;
 *   at risk   — worse than the target, but by no more than `tolerance`;
 *   off track — worse by more than `tolerance`;
 *   unavailable — no reader, no data, or no target, in that order of precedence (`reason` says which).
 * "Better" follows `direction`: higher for up_good, lower for down_good.
 */
export function kpiCondition(
  def: Pick<DeptKpiDef, "direction" | "reader">,
  value: number | null,
  target: KpiTargetLevel | null,
): { condition: KpiCondition; reason?: UnavailableReason } {
  if (def.reader.kind === "module" && def.reader.readerId === undefined) return { condition: "unavailable", reason: "no_reader" };
  if (value === null || !Number.isFinite(value)) return { condition: "unavailable", reason: "no_data" };
  if (target === null) return { condition: "unavailable", reason: "no_target" };
  const shortfall = def.direction === "up_good" ? target.target - value : value - target.target;
  if (shortfall <= EPSILON) return { condition: "on_track" };
  if (shortfall <= target.tolerance + EPSILON) return { condition: "at_risk" };
  return { condition: "off_track" };
}

/**
 * PURE. The department's condition from its KPIs' (§40.3): off track if any KPI is off track or two are at risk; at
 * risk if one is at risk; on track if at least one KPI has a condition and none is worse; unavailable if no KPI has a
 * condition. "Trending to miss" (plan §5.5) is deferred: it needs a projection rule, and none is guessed.
 */
export function departmentCondition(conditions: readonly KpiCondition[]): KpiCondition {
  const atRisk = conditions.filter((c) => c === "at_risk").length;
  if (conditions.includes("off_track") || atRisk >= 2) return "off_track";
  if (atRisk === 1) return "at_risk";
  if (conditions.includes("on_track")) return "on_track";
  return "unavailable";
}

/** Worst first (§40.3's standing order). `unavailable` is not a condition, so it sorts after every real one. */
export const CONDITION_RANK: Readonly<Record<KpiCondition, number>> = { off_track: 0, at_risk: 1, on_track: 2, unavailable: 3 };

/** PURE. The overview's order: condition worst first, then name, then id (stable for equal names). */
export function compareByConditionThenName(
  a: { condition: KpiCondition; unit: { id: string; name: string } },
  b: { condition: KpiCondition; unit: { id: string; name: string } },
): number {
  return (
    CONDITION_RANK[a.condition] - CONDITION_RANK[b.condition] ||
    a.unit.name.localeCompare(b.unit.name) ||
    (a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0)
  );
}

// ══════════════════════════ VALUES ══════════════════════════

export interface KpiValue {
  value: number;
  numerator?: number;
  denominator?: number;
}

/** PURE. True when the document's whole window precedes the tenant's first fact date: "a window with no facts"
 *  (§40.3). Every report_fact KPI then reads `no_data`, never the builder's honest-zero placeholder. */
export function windowHasNoFacts(doc: ReportDocument): boolean {
  const gap = doc.header.warnings?.precedesFactHistory;
  return !!gap && gap.affectedDays >= doc.header.dayCount;
}

/**
 * PURE. A report_fact KPI's value from the document of its grain, or `null` (no data):
 *   - the metric is not on the document (not computed for this grain);
 *   - the whole window precedes fact history;
 *   - a ratio with a 0 denominator: nothing was measured, and the builder's `value: 0` would read as a real zero.
 */
export function reportFactValue(metricKey: string, doc: ReportDocument | null): KpiValue | null {
  if (!doc || windowHasNoFacts(doc)) return null;
  const kpi = doc.kpis.find((k) => k.metricKey === metricKey);
  if (!kpi) return null;
  if (kpi.denominator !== undefined) {
    if (kpi.denominator === 0) return null;
    return { value: kpi.value, numerator: kpi.numerator ?? 0, denominator: kpi.denominator };
  }
  return { value: kpi.value };
}

/** PURE. departments-in-good-condition: the share of departments whose condition is on track, over the departments
 *  that have a condition at all. `null` (no data) when none has one. The caller passes the OTHER departments'
 *  conditions: the GM department itself is never counted in its own KPI. */
export function departmentsInGoodCondition(conditions: readonly KpiCondition[]): KpiValue | null {
  const withCondition = conditions.filter((c) => c !== "unavailable");
  if (withCondition.length === 0) return null;
  const good = withCondition.filter((c) => c === "on_track").length;
  return { value: good / withCondition.length, numerator: good, denominator: withCondition.length };
}

// ══════════════════════════ THE ORG TREE ══════════════════════════

export interface OrgUnitRef {
  id: string;
  name: string;
  kind: string;
}

interface NamedNode extends UnitTreeNode {
  name?: string;
  children?: NamedNode[] | null;
}

function walk(structure: unknown, visit: (node: NamedNode) => boolean | void): void {
  const root = unwrapOrgRoot(structure) as NamedNode | null;
  if (!root) return;
  const stack: NamedNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (visit(node) === true) return;
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = kids.length - 1; i >= 0; i--) if (kids[i] && typeof kids[i] === "object") stack.push(kids[i]);
  }
}

const refOf = (n: NamedNode): OrgUnitRef => ({
  id: n.id as string,
  name: typeof n.name === "string" && n.name.trim() ? n.name : (n.id as string),
  kind: n.kind ?? "",
});

/** PURE. The node `id` of the org tree, or null when the tree does not hold it. */
export function findOrgUnit(structure: unknown, id: string): OrgUnitRef | null {
  const hit: { ref: OrgUnitRef | null } = { ref: null };
  walk(structure, (n) => {
    if (n.id !== id) return false;
    hit.ref = refOf(n);
    return true;
  });
  return hit.ref;
}

/** PURE. Every `department` node of the tree, in tree order (the overview's population, §40.3). */
export function departmentUnits(structure: unknown): OrgUnitRef[] {
  const out: OrgUnitRef[] = [];
  const seen = new Set<string>();
  walk(structure, (n) => {
    if (n.kind === "department" && typeof n.id === "string" && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(refOf(n));
    }
  });
  return out;
}
