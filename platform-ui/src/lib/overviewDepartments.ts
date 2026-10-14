// Department KPIs: condition and standing, as the UI reads them (DW-3i, docs/plans/2026-10-13-department-workspaces.md
// §5.5, BFF `docs/FRONTEND-BFF-CONTRACT.md` §40). Pure and client-safe, like the registry: the wire types, the defensive
// normalizer for `GET /api/:t/dept-kpis/overview`, the worst-first order and the words a row says. The reader that
// fetches it is `overviewDepartments-data.ts`. DW-4e-2's `deptKpis.ts` / `deptKpiFormat.ts` word the department KPI page;
// this file words the company Overview's Departments block. Folding the two vocabularies into one is DW-3i2.
//
// The server owns every number here. A KPI's value, target and condition come from the API; this file never computes a
// condition, never gives a department a rating it was not sent, and never turns "no target" into "on track". A
// department with no target set says so in words ("No target set") and goes last.
import type { ReadResult } from "./readResult";

// ── The wire (BFF §40.3, §40.3a) ─────────────────────────────────────────────────────────────────

export const DEPT_CONDITIONS = ["off_track", "at_risk", "on_track", "unavailable"] as const;
export type DeptCondition = (typeof DEPT_CONDITIONS)[number];

export type DeptKpiUnit = "percent" | "count" | "minutes";

export interface DeptKpiReading {
  key: string;
  label: string;
  unit: DeptKpiUnit;
  direction: "up_good" | "down_good";
  /** `null` when absent: never 0. Percent values are fractions (0.85 = 85%). */
  value: number | null;
  target: number | null;
  tolerance: number | null;
  /** `approved` when a target is in force for the period; `none` means no condition can exist. */
  targetSource: "approved" | "none";
  condition: DeptCondition;
  /** Why the KPI is unavailable: `no_reader`, `no_data` or `no_target` (§40.3). */
  reason: string | null;
}

export interface DeptStanding {
  id: string;
  name: string;
  workspace: string | null;
  condition: DeptCondition;
  kpis: DeptKpiReading[];
}

export interface DeptKpiOverview {
  departments: DeptStanding[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A condition code this build does not know (the backend moved first) reads as `unavailable`: never an invented rating. */
function conditionOf(v: unknown): DeptCondition {
  return (DEPT_CONDITIONS as readonly unknown[]).includes(v) ? (v as DeptCondition) : "unavailable";
}

function normalizeKpi(raw: unknown): DeptKpiReading | null {
  if (!isRecord(raw)) return null;
  const key = str(raw.key);
  if (!key) return null;
  const unit = raw.unit === "percent" || raw.unit === "minutes" ? raw.unit : "count";
  return {
    key,
    label: str(raw.label) ?? key,
    unit,
    direction: raw.direction === "down_good" ? "down_good" : "up_good",
    value: num(raw.value),
    target: num(raw.target),
    tolerance: num(raw.tolerance),
    targetSource: raw.targetSource === "approved" ? "approved" : "none",
    condition: conditionOf(raw.condition),
    reason: str(raw.reason),
  };
}

/** `GET dept-kpis/overview` as a typed value; `null` for an answer that is not that shape (a backend older than §40, a proxy
 *  error page), which the reader turns into "Unavailable" and never into an empty list of departments. */
export function normalizeDeptKpiOverview(raw: unknown): DeptKpiOverview | null {
  if (!isRecord(raw) || !Array.isArray(raw.departments)) return null;
  const departments: DeptStanding[] = [];
  for (const d of raw.departments) {
    if (!isRecord(d) || !isRecord(d.unit)) continue;
    const id = str(d.unit.id);
    if (!id) continue;
    departments.push({
      id,
      name: str(d.unit.name) ?? id,
      workspace: str(d.workspace),
      condition: conditionOf(d.condition),
      kpis: (Array.isArray(d.kpis) ? d.kpis : []).flatMap((k) => {
        const kpi = normalizeKpi(k);
        return kpi ? [kpi] : [];
      }),
    });
  }
  return { departments };
}

// ── Worst first (plan §5.5) ──────────────────────────────────────────────────────────────────────

const RANK: Readonly<Record<DeptCondition, number>> = { off_track: 0, at_risk: 1, on_track: 2, unavailable: 3 };

/** Off track, at risk, on track, then the departments with no rating last; ties by name, then id. The server sends this
 *  order too (§40.3a), but a page that depends on it silently would break the day it changes, so it is applied here. */
export function orderDepartments<T extends { id: string; name: string; condition: DeptCondition }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    RANK[a.condition] - RANK[b.condition] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export const CONDITION_TEXT: Readonly<Record<DeptCondition, string>> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  unavailable: "No condition yet",
};

const trim = (n: number) => String(Math.round(n * 10) / 10);

/** A KPI's figure in its own unit: "85%", "12", "45 min", "2.5 h". */
export function formatKpiValue(unit: DeptKpiUnit, value: number): string {
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "minutes") return value >= 120 ? `${trim(value / 60)} h` : `${Math.round(value)} min`;
  return value.toLocaleString("en-US");
}

/** How far the KPI is on the wrong side of its target, in units of its tolerance (its own unit when it has none). Zero for
 *  a KPI without both a value and a target, and for one at or better than the target. */
function shortfall(k: DeptKpiReading): number {
  if (k.value === null || k.target === null) return 0;
  const gap = k.direction === "up_good" ? k.target - k.value : k.value - k.target;
  if (gap <= 0) return 0;
  return k.tolerance !== null && k.tolerance > 0 ? gap / k.tolerance : gap;
}

export interface Drivers {
  /** The KPI furthest past its target among those at the worst KPI-level condition; `null` when nothing is at risk. */
  first: DeptKpiReading | null;
  /** How many more KPIs share the department's worst KPI-level condition. */
  others: number;
  /** The KPI-level condition the drivers have: a department is off track when ANY KPI is, or when two are at risk (§40.3), so
   *  an off-track department can be driven by two at-risk KPIs. */
  level: "off_track" | "at_risk" | null;
}

/** The KPI (or KPIs) driving a department's condition: the worst KPI-level condition present, then the largest shortfall.
 *  On-track and unrated departments have none. Stable: equal shortfalls keep the catalogue's order. */
export function driversOf(d: Pick<DeptStanding, "kpis">): Drivers {
  const level = d.kpis.some((k) => k.condition === "off_track") ? "off_track" : d.kpis.some((k) => k.condition === "at_risk") ? "at_risk" : null;
  if (!level) return { first: null, others: 0, level: null };
  const worst = d.kpis.map((k, i) => ({ k, i })).filter((x) => x.k.condition === level)
    .sort((a, b) => shortfall(b.k) - shortfall(a.k) || a.i - b.i);
  return { first: worst[0].k, others: worst.length - 1, level };
}

/** In words why a department has no rating: "No target set" when none of its KPIs has a target in force, which is the case
 *  on a company that has not set targets yet; otherwise what the rated KPIs lack. */
export function unratedText(d: Pick<DeptStanding, "kpis">): string {
  if (d.kpis.length === 0) return "No KPIs defined";
  if (d.kpis.every((k) => k.targetSource === "none")) return "No target set";
  const withTarget = d.kpis.filter((k) => k.targetSource === "approved");
  if (withTarget.some((k) => k.reason === "no_data")) return "No data in this period";
  if (withTarget.some((k) => k.reason === "no_reader")) return "Not measured yet";
  return "Not rated";
}

/** The line under a department's condition: the KPI driving it, or why there is no rating. */
export function standingDetail(d: DeptStanding): string {
  if (d.condition === "unavailable") return unratedText(d);
  if (d.condition === "on_track") {
    const measured = d.kpis.filter((k) => k.condition !== "unavailable").length;
    return measured === 1 ? "Its one measured KPI is on target" : `All ${measured} measured KPIs are on target`;
  }
  const { first, others } = driversOf(d);
  if (!first) return d.condition === "off_track" ? "Off track" : "At risk";
  const figure = first.value !== null && first.target !== null
    ? `${formatKpiValue(first.unit, first.value)} against a target of ${formatKpiValue(first.unit, first.target)}`
    : "No figure this period";
  return `${first.label}: ${figure}${others > 0 ? `, and ${others} more` : ""}`;
}

// ── The block's model ────────────────────────────────────────────────────────────────────────────

export const DEPARTMENTS_SHOWN = 10;

export interface DeptRowModel {
  id: string;
  name: string;
  condition: DeptCondition;
  conditionText: string;
  detail: string;
  /** The department's own console. */
  href: string;
}

export interface StandingCounts { offTrack: number; atRisk: number; onTrack: number; notRated: number }

export type DepartmentsView =
  | { kind: "ok"; rows: DeptRowModel[]; total: number; counts: StandingCounts }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** The block's state from what the reader said. An empty `ok` is a real "no department in the org structure"; a refused or
 *  failed read never reaches it. */
export function departmentsView(result: ReadResult<DeptKpiOverview>): DepartmentsView {
  if (result.kind !== "ok") return { kind: result.kind };
  const ordered = orderDepartments(result.data.departments);
  const count = (c: DeptCondition) => ordered.filter((d) => d.condition === c).length;
  return {
    kind: "ok",
    total: ordered.length,
    counts: { offTrack: count("off_track"), atRisk: count("at_risk"), onTrack: count("on_track"), notRated: count("unavailable") },
    rows: ordered.slice(0, DEPARTMENTS_SHOWN).map((d) => ({
      id: d.id,
      name: d.name,
      condition: d.condition,
      conditionText: CONDITION_TEXT[d.condition],
      detail: standingDetail(d),
      href: `/departments/${encodeURIComponent(d.id)}`,
    })),
  };
}

/** "1 off track, 1 at risk, 2 on track, 1 with no condition yet": only the states that have a department in them. */
export function countsText(c: StandingCounts): string {
  const parts: [number, string][] = [[c.offTrack, "off track"], [c.atRisk, "at risk"], [c.onTrack, "on track"], [c.notRated, "with no condition yet"]];
  return parts.filter(([n]) => n > 0).map(([n, text]) => `${n} ${text}`).join(", ");
}
