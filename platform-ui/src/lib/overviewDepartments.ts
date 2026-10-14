// Department KPIs: the company Overview's "Departments by condition" block (DW-3i, docs/plans/2026-10-13-department-workspaces.md
// §5.5, BFF `docs/FRONTEND-BFF-CONTRACT.md` §40). Pure and client-safe, like the registry: the defensive normalizer for
// `GET /api/:t/dept-kpis/overview` and the block's model. The reader that fetches it is `overviewDepartments-data.ts`.
//
// ONE KPI VOCABULARY (DW-3i2). The types, the condition words, the figures, the worst-first order and the driving KPI all come
// from `deptKpiFormat.ts`, the same module the department KPI page and the department Overview's condition banner (DW-3k) use,
// so a condition reads the same on every surface. This file keeps only what is specific to the company block: the normalizer,
// the row model, the counts line and the cap.
//
// The server owns every number here. A KPI's value, target and condition come from the API; this file never computes a
// condition, never gives a department a rating it was not sent, and never turns "no target" into "on track". A
// department with no approved target has no condition: it says why in words and goes last.
import type { ReadResult } from "./readResult";
import {
  compareByConditionThenName, conditionLabel, driverText, unavailableWhy, worstKpi,
  type DeptKpi, type KpiCondition, type KpiReason,
} from "./deptKpiFormat";

// ── The wire (BFF §40.3, §40.3a) ─────────────────────────────────────────────────────────────────

/** One department of the overview: `unit` as the per-unit read (`DeptKpisView`) sends it, so the two share one shape. */
export interface DeptStanding {
  unit: { id: string; name: string };
  workspace: string | null;
  condition: KpiCondition;
  kpis: DeptKpi[];
}

export interface DeptKpiOverview {
  departments: DeptStanding[];
}

const CONDITIONS: readonly unknown[] = ["off_track", "at_risk", "on_track", "unavailable"];
const REASONS: readonly unknown[] = ["no_reader", "no_data", "no_target"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A condition code this build does not know (the backend moved first) reads as `unavailable`: never an invented rating. */
function conditionOf(v: unknown): KpiCondition {
  return CONDITIONS.includes(v) ? (v as KpiCondition) : "unavailable";
}

function normalizeKpi(raw: unknown): DeptKpi | null {
  if (!isRecord(raw)) return null;
  const key = str(raw.key);
  if (!key) return null;
  const unit = raw.unit === "percent" || raw.unit === "minutes" ? raw.unit : "count";
  const numerator = num(raw.numerator);
  const denominator = num(raw.denominator);
  return {
    key,
    label: str(raw.label) ?? key,
    unit,
    direction: raw.direction === "down_good" ? "down_good" : "up_good",
    value: num(raw.value),
    ...(numerator !== null ? { numerator } : {}),
    ...(denominator !== null ? { denominator } : {}),
    target: num(raw.target),
    tolerance: num(raw.tolerance),
    targetSource: raw.targetSource === "approved" ? "approved" : "none",
    condition: conditionOf(raw.condition),
    ...(REASONS.includes(raw.reason) ? { reason: raw.reason as KpiReason } : {}),
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
      unit: { id, name: str(d.unit.name) ?? id },
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

// ── The line under a department ──────────────────────────────────────────────────────────────────

/** The line under a department's condition, in the shared words: the KPI driving it (and how many more share its condition), or
 *  why there is no rating. */
export function standingDetail(d: Pick<DeptStanding, "condition" | "kpis">): string {
  if (d.condition === "unavailable") return unavailableWhy(d.kpis);
  if (d.condition === "on_track") {
    const measured = d.kpis.filter((k) => k.condition !== "unavailable").length;
    return measured === 1 ? "Its one measured KPI is on target" : `All ${measured} measured KPIs are on target`;
  }
  const w = worstKpi(d.kpis);
  if (!w) return conditionLabel(d.condition);
  const others = d.kpis.filter((k) => k.condition === w.condition).length - 1;
  return `${driverText(w)}${others > 0 ? `, and ${others} more` : ""}`;
}

// ── The block's model ────────────────────────────────────────────────────────────────────────────

export const DEPARTMENTS_SHOWN = 10;

export interface DeptRowModel {
  id: string;
  name: string;
  condition: KpiCondition;
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
  // The server sends this order too (§40.3a), but a page that depends on it silently would break the day it changes: worst
  // first, the departments with no rating last, then by name, then id.
  const ordered = [...result.data.departments].sort(compareByConditionThenName);
  const count = (c: KpiCondition) => ordered.filter((d) => d.condition === c).length;
  return {
    kind: "ok",
    total: ordered.length,
    counts: { offTrack: count("off_track"), atRisk: count("at_risk"), onTrack: count("on_track"), notRated: count("unavailable") },
    rows: ordered.slice(0, DEPARTMENTS_SHOWN).map((d) => ({
      id: d.unit.id,
      name: d.unit.name,
      condition: d.condition,
      conditionText: conditionLabel(d.condition),
      detail: standingDetail(d),
      href: `/departments/${encodeURIComponent(d.unit.id)}`,
    })),
  };
}

/** "1 off track, 1 at risk, 2 on track, 1 unavailable": only the states that have a department in them, each in the shared
 *  condition words. */
export function countsText(c: StandingCounts): string {
  const parts: [number, KpiCondition][] = [[c.offTrack, "off_track"], [c.atRisk, "at_risk"], [c.onTrack, "on_track"], [c.notRated, "unavailable"]];
  return parts.filter(([n]) => n > 0).map(([n, k]) => `${n} ${conditionLabel(k).toLowerCase()}`).join(", ");
}
