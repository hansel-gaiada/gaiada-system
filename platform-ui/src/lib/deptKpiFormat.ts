// Department KPIs (DW-4e-2): the TYPES and PURE formatters, BFF contract §40 / §40.3a. No server-only import, so a client
// component (the target forms) can use them; the readers that call the backend are in lib/deptKpis.ts, which re-exports this.
//
// SCALES (§40.3a). `percent` values, targets and tolerances are FRACTIONS (0.85 = 85%). The UI shows and accepts whole
// percents (`toFraction` / `fromFraction`); the wire is always the fraction. `minutes` is a duration. `count` is a level.

export type KpiUnit = "percent" | "count" | "minutes";
export type KpiDirection = "up_good" | "down_good";
export type KpiCondition = "on_track" | "at_risk" | "off_track" | "unavailable";
export type KpiReason = "no_reader" | "no_data" | "no_target";
export type TargetStatus = "proposed" | "approved" | "rejected" | "superseded";

/** One KPI of a unit's read (§40.3a). `value`, `target` and `tolerance` are null when absent. */
export interface DeptKpi {
  key: string;
  label: string;
  unit: KpiUnit;
  direction: KpiDirection;
  value: number | null;
  numerator?: number;
  denominator?: number;
  target: number | null;
  tolerance: number | null;
  targetSource: "approved" | "none";
  condition: KpiCondition;
  reason?: KpiReason;
}

export interface DeptKpisView {
  unit: { id: string; name: string };
  workspace: string;
  period: { periodKind: string; start: string; end: string };
  condition: KpiCondition;
  kpis: DeptKpi[];
}

/** One row of `dept_kpi_targets` as the targets list returns it. */
export interface DeptKpiTargetRow {
  id: string;
  unitNodeId: string;
  kpiKey: string;
  effectiveFrom: string;
  target: number;
  tolerance: number;
  status: TargetStatus;
  note: string | null;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface DeptKpiTargetsKpi {
  key: string;
  label: string;
  unit: KpiUnit;
  direction: KpiDirection;
  suggestedTarget: number | null;
  suggestedTolerance: number | null;
  inForce: DeptKpiTargetRow | null;
  proposals: DeptKpiTargetRow[];
  history: DeptKpiTargetRow[];
}

export interface DeptKpiTargetsView {
  unit: { id: string; name: string };
  workspace: string;
  /** The current month start in the reporting timezone, YYYY-MM-DD. */
  asOf: string;
  kpis: DeptKpiTargetsKpi[];
}

// ─────────────────────────────────────────────────────────────────── formatting ───────────────
export const NO_VALUE = "—";

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Minutes as a human duration: "45 min", "3h 20m", "2.5 d". */
function formatMinutes(m: number): string {
  if (m < 60) return `${round(m, 0)} min`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const r = Math.round(m % 60);
    return r ? `${h}h ${r}m` : `${h}h`;
  }
  return `${round(m / 1440, 1)} d`;
}

/** A KPI value by its unit: a percent fraction as a whole percent ("79%"), a count, a duration. Null is a dash. */
export function formatKpiValue(value: number | null | undefined, unit: KpiUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_VALUE;
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (unit === "minutes") return formatMinutes(value);
  return round(value).toLocaleString("en-US");
}

/** A tolerance by its unit: percent points for a percent KPI, else the same as a value. */
export function formatTolerance(tolerance: number | null | undefined, unit: KpiUnit): string {
  if (tolerance === null || tolerance === undefined || !Number.isFinite(tolerance)) return NO_VALUE;
  if (unit === "percent") return `${round(tolerance * 100)} pts`;
  return formatKpiValue(tolerance, unit);
}

export const CONDITION_LABEL: Readonly<Record<KpiCondition, string>> = {
  on_track: "On track",
  at_risk: "At risk",
  off_track: "Off track",
  unavailable: "Unavailable",
};

export function conditionLabel(c: KpiCondition): string {
  return CONDITION_LABEL[c] ?? "Unavailable";
}

export const REASON_TEXT: Readonly<Record<KpiReason, string>> = {
  no_target: "No target yet",
  no_reader: "Not measured yet",
  no_data: "No data this period",
};

/** Why a KPI has no condition, in the words a head reads. A KPI with a condition has no reason (empty string). */
export function reasonText(reason: KpiReason | undefined): string {
  return reason ? REASON_TEXT[reason] ?? "" : "";
}

/** The design-token family of a condition (the same `--status-*-fg` tokens KpiTiles and the badges use). */
export type ConditionTone = "ok" | "warning" | "danger" | "idle";

export function conditionTone(c: KpiCondition): ConditionTone {
  if (c === "on_track") return "ok";
  if (c === "at_risk") return "warning";
  if (c === "off_track") return "danger";
  return "idle";
}

const RANK: Readonly<Record<KpiCondition, number>> = { off_track: 3, at_risk: 2, on_track: 1, unavailable: 0 };

/** How far worse than its target a KPI is, in the KPI's own scale (<= 0 means at or better than target). */
function shortfall(k: DeptKpi): number {
  if (k.value === null || k.target === null) return 0;
  return k.direction === "up_good" ? k.target - k.value : k.value - k.target;
}

/** The KPI that explains the department's condition: the worst condition, then the largest shortfall, then catalogue order. */
export function worstKpi(kpis: readonly DeptKpi[]): DeptKpi | null {
  let worst: DeptKpi | null = null;
  for (const k of kpis) {
    if (k.condition === "unavailable") continue;
    if (!worst || RANK[k.condition] > RANK[worst.condition] ||
        (RANK[k.condition] === RANK[worst.condition] && shortfall(k) > shortfall(worst))) {
      worst = k;
    }
  }
  return worst;
}

/** Why a department has no condition, in one short line. */
export function unavailableWhy(kpis: readonly DeptKpi[]): string {
  if (kpis.length === 0) return "This department has no KPIs yet";
  if (kpis.some((k) => k.reason === "no_target")) return "No KPI has an approved target yet";
  if (kpis.some((k) => k.reason === "no_data")) return "No data this period";
  return "None of its KPIs is measured yet";
}

/**
 * The banner sentence. "Web Dev: at risk · Projects on time 81% against 85%" names the worst KPI; an on-track
 * department says only that; an unavailable one says why, never a colour it has not earned.
 */
export function bannerSentence(view: Pick<DeptKpisView, "unit" | "condition" | "kpis">): string {
  const name = view.unit.name;
  if (view.condition === "unavailable") return `${name}: condition unavailable · ${unavailableWhy(view.kpis)}`;
  const label = conditionLabel(view.condition).toLowerCase();
  if (view.condition === "on_track") return `${name}: ${label}`;
  const w = worstKpi(view.kpis);
  if (!w) return `${name}: ${label}`;
  return `${name}: ${label} · ${driverText(w)}`;
}

/** The KPI that drives a condition, in the banner's words: "Projects on time 81% against 85%". Shared by the department banner
 *  and the company Overview's rows, so a condition reads the same everywhere (DW-3i2). */
export function driverText(k: DeptKpi): string {
  return `${k.label} ${formatKpiValue(k.value, k.unit)} against ${formatKpiValue(k.target, k.unit)}`;
}

/** The line under a tile's value: the target in force, or why there is no condition. */
export function tileFoot(k: DeptKpi): string {
  if (k.target !== null) {
    return `Target ${formatKpiValue(k.target, k.unit)} (tolerance ${formatTolerance(k.tolerance, k.unit)})`;
  }
  return reasonText(k.reason) || "No target yet";
}

/** A ratio's parts ("11 of 14"), shown beside the value so a small denominator is visible. */
export function ratioParts(k: DeptKpi): string | null {
  if (k.numerator === undefined || k.denominator === undefined) return null;
  return `${k.numerator.toLocaleString("en-US")} of ${k.denominator.toLocaleString("en-US")}`;
}

/** The page's period from its query string (DW-4j-3: the weekly digest links `?unit=&periodKind=week&start=<Monday>`). A param that is
 *  missing, empty or repeated falls back (month, today); `end` is passed only when given (the server re-derives it for every calendar kind). */
export function kpiPeriodFromQuery(
  sp: { periodKind?: string | string[]; start?: string | string[]; end?: string | string[] },
  today: string,
): { periodKind: string; start: string; end?: string } {
  const one = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);
  const end = one(sp.end);
  return { periodKind: one(sp.periodKind) ?? "month", start: one(sp.start) ?? today, ...(end ? { end } : {}) };
}

// ─────────────────────────────────────────────────────────────────── target forms ───────────────
/** A UI number to the wire scale: a whole percent becomes a fraction. */
export function toFraction(unit: KpiUnit, uiValue: number): number {
  return unit === "percent" ? round(uiValue / 100, 6) : uiValue;
}

/** The wire scale to a UI number: a fraction becomes a whole percent (2 decimals at most). */
export function fromFraction(unit: KpiUnit, wire: number): number {
  return unit === "percent" ? round(wire * 100, 2) : wire;
}

const MONTH_START = /^\d{4}-\d{2}-01$/;

export function isMonthStart(s: string): boolean {
  return MONTH_START.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** The first day of the month after `isoDate` ("2026-10-14" -> "2026-11-01"). */
export function nextMonthStart(isoDate: string): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

export interface ProposalBody {
  unitNodeId: string;
  kpiKey: string;
  effectiveFrom: string;
  target: number;
  tolerance: number;
  note?: string;
}

export type ProposalParse =
  | { ok: true; body: ProposalBody }
  | { ok: false; error: string; field: "target" | "tolerance" | "effectiveFrom" | "kpiKey" | "unitNodeId" };

/**
 * A proposal form to the POST body (§40.2): percent entered as a whole percent goes out as a fraction. This only
 * saves a round trip; the server validates the same rules and stays the authority.
 */
export function parseProposal(
  unit: KpiUnit,
  raw: { unitNodeId: string; kpiKey: string; effectiveFrom: string; target: string; tolerance: string; note?: string },
): ProposalParse {
  if (!raw.unitNodeId) return { ok: false, error: "Choose a department.", field: "unitNodeId" };
  if (!raw.kpiKey) return { ok: false, error: "Choose a KPI.", field: "kpiKey" };
  if (!isMonthStart(raw.effectiveFrom)) return { ok: false, error: "Choose the first day of a month.", field: "effectiveFrom" };
  const num = (s: string) => (s.trim() === "" ? NaN : Number(s));
  const t = num(raw.target);
  const tol = num(raw.tolerance);
  if (!Number.isFinite(t)) return { ok: false, error: "Enter a target.", field: "target" };
  if (!Number.isFinite(tol) || tol < 0) return { ok: false, error: "Enter a tolerance of 0 or more.", field: "tolerance" };
  if (unit === "percent" && (t < 0 || t > 100)) return { ok: false, error: "A percent target is between 0 and 100.", field: "target" };
  if (unit !== "percent" && t < 0) return { ok: false, error: "A target cannot be negative.", field: "target" };
  const note = raw.note?.trim();
  return {
    ok: true,
    body: {
      unitNodeId: raw.unitNodeId,
      kpiKey: raw.kpiKey,
      effectiveFrom: raw.effectiveFrom,
      target: toFraction(unit, t),
      tolerance: toFraction(unit, tol),
      ...(note ? { note } : {}),
    },
  };
}

/** The two machine codes a head can meet on a decision, as sentences. Anything else is the server's own words. */
export function explainDecisionError(message: string): string {
  if (message === "cannot_approve_own_proposal") return "You proposed this target, so someone else has to decide it.";
  if (message === "not_proposed") return "This proposal was already decided. Refresh to see where it stands.";
  return message;
}

/** The next `count` month starts from the month after `asOf`, for the "Effective from" picker. */
export function monthStartsFrom(asOf: string, count = 12): string[] {
  const out: string[] = [];
  let m = nextMonthStart(asOf);
  for (let i = 0; i < count; i++) {
    out.push(m);
    m = nextMonthStart(m);
  }
  return out;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-01" -> "November 2026". */
export function formatMonth(monthStart: string): string {
  const mi = Number(monthStart.slice(5, 7)) - 1;
  return MONTHS[mi] ? `${MONTHS[mi]} ${monthStart.slice(0, 4)}` : monthStart;
}

const CONDITION_ORDER: Readonly<Record<KpiCondition, number>> = { off_track: 0, at_risk: 1, on_track: 2, unavailable: 3 };

/** The overview's order, as the backend sorts it (`compareByConditionThenName`, dept-kpis.ts): worst first, unavailable last, then name, then id. */
export function compareByConditionThenName(
  a: { condition: KpiCondition; unit: { id: string; name: string } },
  b: { condition: KpiCondition; unit: { id: string; name: string } },
): number {
  return (
    CONDITION_ORDER[a.condition] - CONDITION_ORDER[b.condition] ||
    a.unit.name.localeCompare(b.unit.name) ||
    (a.unit.id < b.unit.id ? -1 : a.unit.id > b.unit.id ? 1 : 0)
  );
}
