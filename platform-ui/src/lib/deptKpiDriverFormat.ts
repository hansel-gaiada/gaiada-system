// "Behind the miss" (DW-4j-3, BFF contract §43.8 and §43.8a): the TYPES, the shape guard and the PURE wording of one KPI's drivers.
// No server-only import, so the panel and its tests can use them; the reader that calls the backend is lib/deptKpiDrivers.ts.
//
// A driver's value is worded by `formatKpiValue` (deptKpiFormat.ts) in the KPI's own unit, and by nothing else: there is ONE KPI formatter,
// so a driver reads "60%" exactly as the tile above it reads "81%". Only the parts ("3 of 5 milestones hit") are worded here, per metric,
// because what a numerator and a denominator MEAN depends on the metric (hit and due, reopened and completed, submitted and expected).
import { formatKpiValue, type KpiCondition, type KpiDirection, type KpiUnit } from "./deptKpiFormat";

/** The most rows the panel shows for one KPI (the server sends at most this many). */
export const MAX_DRIVER_ROWS = 5;

export type DriverKind = "project" | "person";

/** One row of `GET dept-kpis/drivers` (§43.8). `numerator` and `denominator` are present for a ratio metric only. */
export interface KpiDriver {
  kind: DriverKind;
  id: string;
  name: string;
  value: number;
  numerator?: number;
  denominator?: number;
}

/** Why a KPI has no drivers. The server may add one later; the words below fall back for a reason this code does not know. */
export type DriversReason = "no_reader" | "no_drivers";

export interface KpiDrivers {
  kpi: { key: string; label: string; unit: KpiUnit; direction: KpiDirection };
  period: { periodKind: string; start: string; end: string };
  drivers: KpiDriver[] | null;
  reason?: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optNum = (v: unknown) => v === undefined || isNum(v);

export function isKpiDriver(v: unknown): v is KpiDriver {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  return (d.kind === "project" || d.kind === "person") && isStr(d.id) && isStr(d.name) && isNum(d.value) && optNum(d.numerator) && optNum(d.denominator);
}

/** The shape guard for the drivers answer. An answer that is not this shape is an ERROR for the reader, never an empty list. */
export function isKpiDrivers(v: unknown): v is KpiDrivers {
  if (!v || typeof v !== "object") return false;
  const d = v as Record<string, unknown>;
  const kpi = d.kpi as Record<string, unknown> | null | undefined;
  if (!kpi || typeof kpi !== "object" || !isStr(kpi.key) || !isStr(kpi.label) || !isStr(kpi.unit)) return false;
  const period = d.period as Record<string, unknown> | null | undefined;
  if (!period || typeof period !== "object" || !isStr(period.periodKind) || !isStr(period.start) || !isStr(period.end)) return false;
  if (d.drivers === null) return isStr(d.reason); // no drivers must say why: a bare null is not an answer
  return Array.isArray(d.drivers) && d.drivers.every(isKpiDriver);
}

/** Only a KPI that is at risk or off track has a miss to look behind. */
export function hasMiss(condition: KpiCondition): boolean {
  return condition === "at_risk" || condition === "off_track";
}

const nf = (n: number) => n.toLocaleString("en-US");

/** The words for a ratio's parts, per metric (the KPI key): "2 of 5 milestones hit", "3 of 10 tasks reopened", "18 of 22 check-ins". A KPI this
 *  does not know says only "N of M": the numbers, never a noun it is not sure of. */
function ratioWords(kpiKey: string, n: number, d: number): string {
  switch (kpiKey) {
    case "projects-on-time": return `${nf(n)} of ${nf(d)} milestones hit`;
    case "reopened-work-rate": return `${nf(n)} of ${nf(d)} tasks reopened`;
    case "check-in-compliance": return `${nf(n)} of ${nf(d)} check-ins`;
    default: return `${nf(n)} of ${nf(d)}`;
  }
}

/** The line of parts under a driver, or null when the metric has none to say. For a count with no ratio (overdue tasks) the count IS the
 *  parts: "4 overdue". */
export function driverParts(kpiKey: string, unit: KpiUnit, d: Pick<KpiDriver, "value" | "numerator" | "denominator">): string | null {
  if (d.numerator !== undefined && d.denominator !== undefined) return ratioWords(kpiKey, d.numerator, d.denominator);
  if (kpiKey === "overdue-tasks") return `${formatKpiValue(d.value, unit)} overdue`;
  return null;
}

/** What a row shows: the driver's value in the KPI's unit, and its parts. The value is left out where the parts already carry it
 *  (an overdue count), so a row never says "4" and "4 overdue" side by side. */
export function driverReading(kpiKey: string, unit: KpiUnit, d: KpiDriver): { value: string | null; parts: string | null } {
  const parts = driverParts(kpiKey, unit, d);
  const valueInParts = kpiKey === "overdue-tasks" && d.numerator === undefined;
  return { value: valueInParts ? null : formatKpiValue(d.value, unit), parts };
}

/** The true statement for an answer that succeeded with no rows: what "nobody missed" means depends on the grain of the KPI. */
export function noDriversStandOut(kpiKey: string): string {
  return kpiKey === "projects-on-time" ? "No project missed a milestone" : "No one stands out";
}

export const DRIVERS_REASON_TEXT: Readonly<Record<DriversReason, string>> = {
  no_reader: "Not measured yet",
  no_drivers: "No breakdown for this KPI",
};

/** Why a KPI has no breakdown, in the words a head reads. A reason this code does not know reads as "No breakdown for this KPI". */
export function driversReasonText(reason: string | undefined): string {
  return (reason && (DRIVERS_REASON_TEXT as Record<string, string>)[reason]) || DRIVERS_REASON_TEXT.no_drivers;
}

export const DRIVERS_LOAD_ERROR = "Couldn't load what is behind this";

/** The accessible name of one KPI's list: "Behind the miss: Projects on time". */
export function driversListName(kpiLabel: string): string {
  return `Behind the miss: ${kpiLabel}`;
}

/** Where a driver's name leads: a project to its page, a person to their report for the period. Only routes that exist in the app. */
export function driverHref(d: Pick<KpiDriver, "kind" | "id">, period: { periodKind: string; start: string; end: string }): string {
  if (d.kind === "project") return `/projects/${encodeURIComponent(d.id)}`;
  const qs = new URLSearchParams({ periodKind: period.periodKind, start: period.start, end: period.end, scopeRef: d.id });
  return `/reports/person?${qs.toString()}`;
}
