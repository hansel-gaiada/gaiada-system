// TR-13 — the backend MIRROR of the canonical `ReportDocument` contract (§6.1).
//
// The source of truth is `platform-ui/src/lib/reports.ts` (TR-16, landed first — see its own
// header comment: "§6.1 was read in full before transcribing... treat this file, not that one,
// as the source of truth for field names"). This file is transcribed FIELD-FOR-FIELD from that
// one, not re-derived from the blueprint prose a second time, so the two can never silently
// diverge on a name. If you are adding a field, add it to lib/reports.ts first and copy it here
// verbatim — never the other way around.
//
// Deliberately NOT re-exporting the FE's display/bucketing helpers (bucketSeries,
// buildPresetRanges, formatDateRange, ...) — those are pure client rendering concerns (§7's
// x-axis bucketing is explicitly "a DISPLAY transform only", done by the chart kit at interaction
// time). The backend's job is to always emit DAILY-resolution series/kpis; bucketing them for a
// wide range is TR-16/17's concern, not this module's.
export type ReportGrain = "person" | "project" | "department" | "company";
export type ReportPeriodKind = "day" | "week" | "month" | "custom";
export type ReportUnit = "count" | "minutes" | "percent" | "score" | "text";

export interface ReportHeader {
  tenantId: string;
  grain: ReportGrain;
  scopeRef: string; // userId | projectId | dept node id | tenantId
  scopeName: string; // display name resolved at build time
  periodKind: ReportPeriodKind;
  periodStart: string; // ISO date (inclusive)
  periodEnd: string; // ISO date (inclusive)
  dayCount: number; // inclusive days in range — the denominator for every per-day ratio (§5.4)
  periodLabel: string; // display: "16 Jul 2026" | "Week 29 2026" | "July 2026" | "16 Jul - 3 Aug 2026"
  customLabel?: string; // pinned custom ranges only (report_periods.label) — always absent until TR-15/TR-14 land
  generatedAt: string; // ISO datetime
  sealed: boolean; // ALWAYS false from this builder — sealing is TR-15's job, layered on later
  periodId?: string; // present when sealed OR pinned — never set by this builder
  revision?: number; // present when sealed — never set by this builder
  // Comparison baseline. For a custom range this is the IMMEDIATELY PRECEDING EQUAL-LENGTH window
  // ([start - dayCount, start - 1]); for a calendar kind it is the immediately preceding period OF
  // THE SAME KIND (previous day/ISO-week/calendar-month), which is what makes month-boundary
  // deltas correct without assuming every month is 30 days.
  comparison?: { periodStart: string; periodEnd: string; dayCount: number };
  providerView?: { servedTenantId: string; servedTenantName: string }; // shared-service slice
  // Honesty flags — set at build time. A user-chosen range will straddle these constantly;
  // silence here would be a lie of omission.
  warnings?: {
    adHoc?: boolean; // custom range: unsealed, not the authoritative record
    partialPeriod?: boolean; // range cuts across an incomplete week/month
    endsInFuture?: boolean; // periodEnd > today — trailing days have no data yet
    precedesFactHistory?: {
      // range starts before this tenant's first computed fact date
      firstFactDate: string; // person-grain facts do not exist before this date
      affectedDays: number;
    };
    spansMembershipChange?: boolean; // a subject moved unit mid-range (§3.2) — dept totals split
  };
}

export interface ReportKpi {
  metricKey: string; // registry key (§5 / metrics.ts)
  label: string;
  unit: ReportUnit;
  value: number; // for ratios: numerator/denominator, computed at build
  numerator?: number; // ALWAYS present for ratio metrics (invariant 2)
  denominator?: number;
  delta?: number; // vs comparison period, same unit (percent-point for ratios)
  direction?: "up_good" | "down_good" | "neutral";
  appraisalSafe: boolean;
  // §5.4 class markers for the two non-additive metrics (never omitted when applicable — a
  // reader must not assume any KPI on a 30-day report is a 30-day total).
  pointInTime?: boolean; // #20: evaluated at range end, not summed across it
  distinctOver?: boolean; // #22: distinct union across the range, not summed
}

export interface ReportSeriesPoint {
  t: string; // ISO date
  v: number | null; // null = no data (never 0-faked)
}

export interface ReportSeries {
  key: string;
  label: string;
  unit: ReportUnit;
  kind: "line" | "bar" | "area";
  points: ReportSeriesPoint[];
  numeratorKey?: string; // ratio series carry both raw series keys for honest tooltips
  denominatorKey?: string;
}

export interface ReportDistribution {
  key: string;
  label: string;
  kind: "donut" | "bar" | "stacked";
  slices: { label: string; value: number; ref?: { kind: "project" | "person" | "unit" | "tag" | "status"; id: string } }[];
}

export interface ReportTable {
  key: string;
  label: string;
  columns: { key: string; label: string; unit?: ReportUnit; align?: "left" | "right" }[];
  rows: Record<string, string | number | null>[];
  totalRow?: Record<string, string | number | null>;
}

export interface ReportHighlight {
  kind: "achievement" | "risk" | "anomaly" | "compliance";
  text: string; // deterministic, template-built from facts (never AI)
  refs?: { kind: "task" | "project" | "person" | "unit"; id: string; label: string }[];
}

export interface ReportNarrative {
  source: "ai" | "deterministic";
  text: string; // prose ABOUT the numbers; numbers themselves come from kpis/series
  model?: string; // gateway model id when source="ai" — never set by this builder (live path only)
  groundingHash?: string; // sha256 of the fact payload the prompt was built from
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
