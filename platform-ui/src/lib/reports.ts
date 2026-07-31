// Tracker/reporting — the `ReportDocument` contract (TR-16).
//
// This is the CANONICAL type family, transcribed verbatim from
// docs/blueprints/tracker-reporting-foundation.md §6.1. platform-nest's
// src/modules/reports/report-document.ts (TR-13) mirrors this shape; treat
// this file, not that one, as the source of truth for field names — TR-13
// was written to match what ships here first.
//
// Deliberately NOT `"server-only"` (contrast with lib/pm.ts): this file is
// ONLY types + pure, zero-I/O functions (bucketing, date/range formatting).
// The chart kit (components/reports/charts/*) is a set of "use client"
// components that call bucketSeries/bucketGranularityFor directly at
// interaction time (switching Daily/Weekly/Monthly redraws instantly, no
// refetch) — that only works if this module has no server-only guard and no
// Node-only API. When TR-17 adds real data fetchers (getReportDocument, a
// platformFetch caller) to this surface, put them in a SEPARATE server-only
// module (e.g. lib/reports-data.ts) rather than adding `import "server-only"`
// here — doing so would break every chart's runtime import of this file.
//
// §6.1 was read in full before transcribing. It is internally consistent as
// written; the one thing worth flagging for the architect (not a fix, just a
// note): `ReportKpi.value: number` is unconditional even when
// `unit === "text"`, which is underspecified — what a "text" KPI's numeric
// `value` means isn't defined anywhere in §5/§6. No current metric in §5.4's
// registry is classified `unit: "text"`, so it isn't blocking; flagging so
// whoever seeds a text-unit metric later doesn't have to reverse-engineer intent.

export type ReportGrain = "person" | "project" | "department" | "company";
export type ReportPeriodKind = "day" | "week" | "month" | "custom";
export type ReportUnit = "count" | "minutes" | "percent" | "score" | "text";

export interface ReportHeader {
  tenantId: string;
  grain: ReportGrain;
  scopeRef: string;            // userId | projectId | dept node id | tenantId
  scopeName: string;           // display name resolved at build time
  periodKind: ReportPeriodKind;
  periodStart: string;         // ISO date (inclusive)
  periodEnd: string;           // ISO date (inclusive)
  dayCount: number;            // inclusive days in range — the denominator for every per-day ratio (§5.4)
  periodLabel: string;         // display: "16 Jul 2026" | "Week 29 2026" | "July 2026" | "16 Jul – 3 Aug 2026"
  customLabel?: string;        // pinned custom ranges only (report_periods.label)
  generatedAt: string;         // ISO datetime
  sealed: boolean;
  periodId?: string;           // present when sealed OR pinned
  revision?: number;           // present when sealed
  // Comparison baseline. For a custom range this is the IMMEDIATELY PRECEDING EQUAL-LENGTH window
  // ([start − dayCount, start − 1]) — "previous period" is otherwise ambiguous for an arbitrary span.
  comparison?: { periodStart: string; periodEnd: string; dayCount: number };
  providerView?: { servedTenantId: string; servedTenantName: string }; // shared-service slice
  // Honesty flags — set at build time, rendered by the viewer AND carried onto every export (§6.3).
  // A user-chosen range will straddle these constantly; silence here would be a lie of omission.
  warnings?: {
    adHoc?: boolean;           // custom range: unsealed, not the authoritative record
    partialPeriod?: boolean;   // range cuts across an incomplete week/month
    endsInFuture?: boolean;    // periodEnd > today — trailing days have no data yet
    precedesFactHistory?: {    // range starts before TR-05 consumer go-live (§13 risk 2)
      firstFactDate: string;   // person-grain facts do not exist before this date
      affectedDays: number;
    };
    spansMembershipChange?: boolean; // a subject moved unit mid-range (§3.2) — dept totals split
  };
}

export interface ReportKpi {
  metricKey: string;           // registry key (§5)
  label: string;
  unit: ReportUnit;
  value: number;               // for ratios: numerator/denominator, computed at build
  numerator?: number;          // ALWAYS present for ratio metrics (invariant 2)
  denominator?: number;
  delta?: number;              // vs comparison period, same unit (percent-point for ratios)
  direction?: "up_good" | "down_good" | "neutral";
  appraisalSafe: boolean;
  // §5.4 class markers for the two non-additive metrics. The viewer and the XLSX exporter MUST
  // label these — without it a reader assumes any KPI on a 30-day report is a 30-day total.
  pointInTime?: boolean;       // #20: evaluated at range end, not summed across it
  distinctOver?: boolean;      // #22: distinct union across the range, not summed
}

export interface ReportSeriesPoint { t: string; v: number | null } // t = ISO date; null = no data (never 0-faked)

export interface ReportSeries {
  key: string; label: string; unit: ReportUnit;
  kind: "line" | "bar" | "area";
  points: ReportSeriesPoint[];
  numeratorKey?: string;       // ratio series carry both raw series keys for honest tooltips
  denominatorKey?: string;
}

export interface ReportDistribution {
  key: string; label: string;
  kind: "donut" | "bar" | "stacked";
  slices: { label: string; value: number; ref?: { kind: "project" | "person" | "unit" | "tag" | "status"; id: string } }[];
}

export interface ReportTable {
  key: string; label: string;
  columns: { key: string; label: string; unit?: ReportUnit; align?: "left" | "right" }[];
  rows: Record<string, string | number | null>[];
  totalRow?: Record<string, string | number | null>;
}

export interface ReportHighlight {
  kind: "achievement" | "risk" | "anomaly" | "compliance";
  text: string;                // deterministic, template-built from facts (never AI)
  refs?: { kind: "task" | "project" | "person" | "unit"; id: string; label: string }[];
}

export interface ReportNarrative {
  source: "ai" | "deterministic";
  text: string;                // prose ABOUT the numbers; numbers themselves come from kpis/series
  model?: string;               // gateway model id when source="ai"
  groundingHash?: string;       // sha256 of the fact payload the prompt was built from
}

export interface ReportDocument {
  header: ReportHeader;
  kpis: ReportKpi[];
  series: ReportSeries[];
  distributions: ReportDistribution[];
  tables: ReportTable[];
  highlights: ReportHighlight[];
  narrative: ReportNarrative;
}

// =====================================================================
// X-axis bucketing (§7 amendment) — a DISPLAY transform only.
//
// The document's series are always daily-resolution (one ReportSeriesPoint
// per calendar day in [periodStart, periodEnd]) regardless of how wide the
// range is — that resolution is the server's job (§5.4) and this file never
// re-derives it from anything else. What the chart kit does with that daily
// series to stay legible over a wide range (never render 400 points/bars) is
// purely a rendering concern, computed from data already sitting in the
// document's props:
//   - additive series (no numerator/denominator key) bucket via SUM — safe
//     for any additive metric because sum-of-daily-sums over a sub-range
//     equals the range sum (§5.4 class A); this is the common case (activity
//     counts, throughput, evidence-by-source).
//   - ratio series (numeratorKey/denominatorKey set) bucket by looking up
//     the sibling raw numerator/denominator series ALSO present in the
//     document's `series[]` and recomputing Σnumerator/Σdenominator for the
//     bucket — never by averaging the pre-computed daily ratios, which is
//     exactly the average-of-averages bug §5.4 warns about.
//   - a series the caller marks `lastNotSum` (point-in-time, e.g. the
//     `discipline.overdue_open` trend — §5.4 #20 is evaluated at range end,
//     never summed) buckets via the bucket's LAST real value instead of a
//     sum. This flag lives on the call site (TR-17 knows which metricKey
//     underlies a series), not on the contract — §6.1's `ReportSeries` has
//     no additivity-class field, and adding one here would be a contract
//     change outside this ticket's remit.
// =====================================================================

export type BucketGranularity = "day" | "week" | "month";

// Daily ticks stay legible to ~45 days, weekly to ~26 weeks (182 days),
// monthly beyond — a 400-day custom range lands in the monthly branch and
// renders ~400/30 ≈ 13 buckets, never 400 points (§7 acceptance example).
export function bucketGranularityFor(dayCount: number): BucketGranularity {
  if (dayCount <= 45) return "day";
  if (dayCount <= 182) return "week";
  return "month";
}

// The bucket's stable key (also its display date, taken as the bucket's
// START day) for a given ISO date under a granularity. Week buckets start
// Monday (ISO week), matching the rest of the platform's week convention
// (see lib/pm.ts isoShift usage). Pure string/date math, UTC throughout so a
// bucket boundary never shifts under the viewer's local timezone.
export function bucketKeyFor(isoDate: string, granularity: BucketGranularity): string {
  if (granularity === "day") return isoDate;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (granularity === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    d.setUTCDate(d.getUTCDate() - dow);
    return d.toISOString().slice(0, 10);
  }
  return `${isoDate.slice(0, 7)}-01`; // month bucket key = first of that month
}

export interface BucketedSeries {
  key: string; label: string; unit: ReportUnit; kind: ReportSeries["kind"];
  granularity: BucketGranularity;
  points: ReportSeriesPoint[]; // one per bucket, t = bucket start date
}

// A bucketed point for a RATIO series additionally carries the summed raw
// numerator/denominator behind that bucket's recomputed ratio, so a tooltip
// can honestly show "n/d" at any granularity (§7: "ratios always tooltip as
// n/d") instead of just the recomputed percentage.
export interface BucketedPoint extends ReportSeriesPoint { numerator?: number | null; denominator?: number | null }
export interface BucketedSeriesDetailed {
  key: string; label: string; unit: ReportUnit; kind: ReportSeries["kind"];
  granularity: BucketGranularity;
  points: BucketedPoint[];
}

function bucketSeriesDetailed(
  target: ReportSeries,
  all: ReportSeries[],
  dayCount: number,
  opts?: { lastNotSum?: boolean },
): BucketedSeriesDetailed {
  const granularity = bucketGranularityFor(dayCount);
  if (granularity === "day") {
    return { key: target.key, label: target.label, unit: target.unit, kind: target.kind, granularity, points: target.points };
  }

  const numer = target.numeratorKey ? all.find((s) => s.key === target.numeratorKey) : undefined;
  const denom = target.denominatorKey ? all.find((s) => s.key === target.denominatorKey) : undefined;
  const numerByDate = numer ? new Map(numer.points.map((p) => [p.t, p.v])) : undefined;
  const denomByDate = denom ? new Map(denom.points.map((p) => [p.t, p.v])) : undefined;

  interface Acc { sum: number; hasValue: boolean; last: number | null; nSum: number; nHas: boolean; dSum: number; dHas: boolean }
  const order: string[] = [];
  const groups = new Map<string, Acc>();
  for (const p of target.points) {
    const key = bucketKeyFor(p.t, granularity);
    let g = groups.get(key);
    if (!g) { g = { sum: 0, hasValue: false, last: null, nSum: 0, nHas: false, dSum: 0, dHas: false }; groups.set(key, g); order.push(key); }
    if (p.v !== null) { g.sum += p.v; g.hasValue = true; g.last = p.v; }
    if (numerByDate) { const nv = numerByDate.get(p.t); if (nv !== undefined && nv !== null) { g.nSum += nv; g.nHas = true; } }
    if (denomByDate) { const dv = denomByDate.get(p.t); if (dv !== undefined && dv !== null) { g.dSum += dv; g.dHas = true; } }
  }

  const points: BucketedPoint[] = order.map((key) => {
    const g = groups.get(key)!;
    if (numer && denom) {
      return {
        t: key,
        v: g.dHas && g.dSum !== 0 ? g.nSum / g.dSum : null,
        numerator: g.nHas ? g.nSum : null,
        denominator: g.dHas ? g.dSum : null,
      };
    }
    if (opts?.lastNotSum) return { t: key, v: g.hasValue ? g.last : null };
    return { t: key, v: g.hasValue ? g.sum : null };
  });

  return { key: target.key, label: target.label, unit: target.unit, kind: target.kind, granularity, points };
}

// Buckets one target series for display. `all` should be the document's full
// `series[]` (or at least the target plus anything it references by
// numeratorKey/denominatorKey) so the ratio lookup can succeed; passing a
// smaller array just means a ratio series silently falls back to summing its
// own (already-a-ratio) points, which is wrong, so callers should pass the
// whole array — cheap, and it's already in memory as the document prop.
export function bucketSeries(
  target: ReportSeries,
  all: ReportSeries[],
  dayCount: number,
  opts?: { lastNotSum?: boolean },
): BucketedSeries {
  const detailed = bucketSeriesDetailed(target, all, dayCount, opts);
  return { ...detailed, points: detailed.points.map(({ t, v }) => ({ t, v })) };
}

// Same as bucketSeries but keeps the per-bucket numerator/denominator (for an
// honest "n/d" tooltip on a ratio series at any bucket granularity).
export function bucketSeriesWithParts(
  target: ReportSeries,
  all: ReportSeries[],
  dayCount: number,
  opts?: { lastNotSum?: boolean },
): BucketedSeriesDetailed {
  return bucketSeriesDetailed(target, all, dayCount, opts);
}

// =====================================================================
// Range/date display helpers — pure formatting, no fetch.
// =====================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function fmtShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

// "16 Jun – 4 Jul" (no bare "vs previous period" — §7 amendment: the
// comparison chip must name the actual baseline window for an arbitrary span).
export function formatDateRange(startIso: string, endIso: string): string {
  return `${fmtShort(startIso)} – ${fmtShort(endIso)}`;
}

export function comparisonLabel(comparison: { periodStart: string; periodEnd: string } | undefined): string | null {
  if (!comparison) return null;
  return `vs ${formatDateRange(comparison.periodStart, comparison.periodEnd)}`;
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  return toIso(new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY_MS));
}

export interface ReportRangePreset { label: string; start: string; end: string }

// Preset shortcuts for the Custom-range picker (§7 amendment): Last 7/30/90
// days, this & last quarter, year to date. These are ordinary custom ranges,
// not new period kinds — see §7's note that a new calendar kind (quarterly
// seal) is a separate, larger decision if it's ever needed for appraisal.
export function buildPresetRanges(todayIso: string): ReportRangePreset[] {
  const today = new Date(`${todayIso}T00:00:00Z`);
  const y = today.getUTCFullYear();
  const q = Math.floor(today.getUTCMonth() / 3); // 0-3
  const quarterStart = (year: number, qtr: number) => toIso(new Date(Date.UTC(year, qtr * 3, 1)));
  const quarterEnd = (year: number, qtr: number) => toIso(new Date(Date.UTC(year, qtr * 3 + 3, 0)));
  const lastQ = q === 0 ? { y: y - 1, q: 3 } : { y, q: q - 1 };
  return [
    { label: "Last 7 days", start: addDays(todayIso, -6), end: todayIso },
    { label: "Last 30 days", start: addDays(todayIso, -29), end: todayIso },
    { label: "Last 90 days", start: addDays(todayIso, -89), end: todayIso },
    { label: "This quarter", start: quarterStart(y, q), end: todayIso },
    { label: "Last quarter", start: quarterStart(lastQ.y, lastQ.q), end: quarterEnd(lastQ.y, lastQ.q) },
    { label: "Year to date", start: toIso(new Date(Date.UTC(y, 0, 1))), end: todayIso },
  ];
}

// 400-day ceiling mirrors §6.2's server-side validation (`range_too_large`) —
// the picker enforces it up front so a user doesn't build a doomed request.
export const REPORT_MAX_CUSTOM_DAYS = 400;

export function dayCountOf(startIso: string, endIso: string): number {
  return Math.round((new Date(`${endIso}T00:00:00Z`).getTime() - new Date(`${startIso}T00:00:00Z`).getTime()) / DAY_MS) + 1;
}
