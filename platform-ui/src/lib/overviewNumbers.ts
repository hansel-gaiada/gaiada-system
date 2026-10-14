// The Overview's "Your numbers" block, as pure rules (DW-3d, docs/plans/2026-10-13-department-workspaces.md §3.2,
// §3.3): which report to read for a period, and how its KPIs become four tiles. No React and no server
// imports, so the block stays thin and every rule here is a plain unit test.
//
// Nothing here is a security boundary: the person reads their own report document, which every principal may
// read (§8), and the server narrows it.
import { comparisonLabel, type ReportDocument, type ReportKpi, type ReportPeriodKind } from "@/lib/reports";
import type { OverviewPeriod } from "@/lib/overview";

// ── What to read ─────────────────────────────────────────────────────────────────────────────────

/** The six Overview periods are six report period kinds, one to one. Total on purpose: a seventh period would
 *  not compile until it says which report it reads. */
const REPORT_KIND: Record<OverviewPeriod, ReportPeriodKind> = {
  day: "day", week: "week", month: "month", quarter: "quarter", semester: "semester", year: "year",
};

export function reportPeriodKind(period: OverviewPeriod): ReportPeriodKind {
  return REPORT_KIND[period];
}

/** The date the report is read for; the server snaps it to the period's own bounds. UTC, like the report page. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The person-grain document read for the signed-in person, for the Overview's period. `end` is always sent
 *  (the endpoint ignores it for a calendar period). */
export function personReportParams(userId: string, period: OverviewPeriod, today: string) {
  return { grain: "person" as const, scopeRef: userId, periodKind: reportPeriodKind(period), start: today, end: today };
}

/** "Open my report": the person report page with the same period (it reads `periodKind` and `start`). */
export function personReportHref(period: OverviewPeriod, today: string): string {
  return `/reports/person?periodKind=${reportPeriodKind(period)}&start=${today}`;
}

// ── The tiles ────────────────────────────────────────────────────────────────────────────────────

export const NO_DATA = "No data";

export interface TileDelta {
  /** Signed, in the unit shown (whole numbers, percentage points or hours), already rounded: 0 is flat. */
  change: number;
  /** What the chip says: "3", "4pp" or "1.5 h". The arrow and the colour come from `change` and `direction`. */
  magnitude: string;
  direction: ReportKpi["direction"];
}

export interface NumberTile {
  key: "tasks-done" | "on-time" | "hours-logged" | "check-ins";
  label: string;
  /** The figure, or "No data". Never a 0 the document did not state. */
  value: string;
  noData: boolean;
  /** The part behind a ratio ("9 of 11" under 82%, "90%" under "9 of 10"). */
  detail: string | null;
  delta: TileDelta | null;
}

export interface YourNumbers {
  /** The document's own label for the period ("October 2026"). */
  periodLabel: string;
  /** "vs 1 Sep – 30 Sep", or null when there is nothing honest to compare with. */
  comparison: string | null;
  tiles: NumberTile[];
  /** One quiet note, the most important first: the period itself starts before the facts do, else the previous
   *  period has no records, else the previous period starts before they do. Null when there is nothing to say. */
  note: string | null;
}

const fmtCount = (n: number) => n.toLocaleString("en-US");
const roundTo = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const flat = (n: number) => (n === 0 ? 0 : n); // never "-0"

/** Minutes as hours, to one decimal and without a trailing ".0": 150 -> "2.5 h", 120 -> "2 h". */
export function formatHours(minutes: number): string {
  return `${fmtCount(roundTo(minutes / 60, 1))} h`;
}

/** "1 May 2026" from an ISO date, in UTC so the day does not move with the server's zone. */
export function formatDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const noData = (key: NumberTile["key"], label: string): NumberTile => ({ key, label, value: NO_DATA, noData: true, detail: null, delta: null });

type Shape = "count" | "hours" | "ratio-percent" | "ratio-of";
const TILES: readonly { key: NumberTile["key"]; label: string; metricKey: string; shape: Shape }[] = [
  { key: "tasks-done", label: "Tasks done", metricKey: "delivery.tasks_completed", shape: "count" },
  { key: "on-time", label: "On time", metricKey: "delivery.on_time_rate", shape: "ratio-percent" },
  { key: "hours-logged", label: "Hours logged", metricKey: "effort.minutes_logged", shape: "hours" },
  { key: "check-ins", label: "Check-ins", metricKey: "discipline.checkin_compliance", shape: "ratio-of" },
];

function deltaOf(kpi: ReportKpi, shape: Shape): TileDelta | null {
  // DW-4m: a delta is real only beside the baseline it was measured against. A KPI without `previous` is a
  // sealed pre-DW-4m document: absent means "not known", never "the baseline is fine".
  if (kpi.previous === undefined) return null;
  if (kpi.delta === undefined || !Number.isFinite(kpi.delta)) return null;
  const direction = kpi.direction;
  if (shape === "hours") {
    const change = flat(roundTo(kpi.delta / 60, 1));
    return { change, magnitude: `${fmtCount(Math.abs(change))} h`, direction };
  }
  if (shape === "count") {
    const change = flat(Math.round(kpi.delta));
    return { change, magnitude: fmtCount(Math.abs(change)), direction };
  }
  // A ratio's delta is the difference of two fractions: 0.04 is four percentage points.
  const change = flat(Math.round(kpi.delta * 100));
  return { change, magnitude: `${fmtCount(Math.abs(change))}pp`, direction };
}

function tileOf(spec: (typeof TILES)[number], kpi: ReportKpi | undefined): NumberTile {
  const { key, label, shape } = spec;
  if (!kpi || !Number.isFinite(kpi.value)) return noData(key, label);

  if (shape === "ratio-percent" || shape === "ratio-of") {
    // A ratio over nothing is no data, never 0%. The contract says a ratio always carries both parts, so a
    // KPI without them cannot be shown honestly either.
    if (kpi.numerator === undefined || kpi.denominator === undefined || kpi.denominator === 0) return noData(key, label);
    const percent = `${Math.round(kpi.value * 100)}%`;
    const parts = `${fmtCount(kpi.numerator)} of ${fmtCount(kpi.denominator)}`;
    return {
      key, label, noData: false, delta: deltaOf(kpi, shape),
      value: shape === "ratio-percent" ? percent : parts,
      detail: shape === "ratio-percent" ? parts : percent,
    };
  }
  return { key, label, noData: false, detail: null, delta: deltaOf(kpi, shape), value: shape === "hours" ? formatHours(kpi.value) : fmtCount(kpi.value) };
}

/** The four tiles and the honest notes for one person-grain document.
 *
 *  Warnings: only `precedesFactHistory` is surfaced, because it is the one that can change what a tile means
 *  (facts start part-way through 2026, so a semester or a year can begin before them). The others cannot be
 *  set for this read or are not worth a line: `adHoc`, `partialPeriod` and `spansMembershipChange` belong to
 *  custom ranges and the department grain, and the Overview reads a calendar period for one person;
 *  `endsInFuture` is true of every current day, week and month, so a note would be on the page all the time
 *  and say nothing a reader does not know ("so far"). */
export function buildYourNumbers(doc: ReportDocument): YourNumbers {
  const history = doc.header.warnings?.precedesFactHistory;
  const comparison = doc.header.comparison;
  const noBaseline = Boolean(history) || comparison?.noFacts === true;
  const tiles = TILES.map((spec) => {
    const tile = tileOf(spec, doc.kpis.find((k) => k.metricKey === spec.metricKey));
    // The comparison period ends before this one starts, so a current period that begins before the facts has
    // a comparison wholly before them too: its zeros are missing records, not a quiet period, and a change
    // against them would be a made-up rise. The same holds when the document says the comparison has no facts.
    return noBaseline ? { ...tile, delta: null } : tile;
  });
  let note: string | null = null;
  if (history) {
    note = `These numbers cover only part of this period: records begin on ${formatDay(history.firstFactDate)}, so there is no earlier period to compare with.`;
  } else if (comparison?.noFacts) {
    note = "No records in the previous period to compare with.";
  } else if (comparison?.precedesFactHistory) {
    note = `Compared with a period that starts before records began on ${formatDay(comparison.precedesFactHistory.firstFactDate)}.`;
  }
  return {
    periodLabel: doc.header.periodLabel,
    comparison: noBaseline ? null : comparisonLabel(comparison),
    tiles,
    note,
  };
}
