// Shared normalization for GroupedBars/StackedBars — both accept EITHER a
// time axis (`ReportSeries[]`, bucketed by `dayCount` exactly like TrendLine)
// or a category axis (`ReportDistribution[]`, e.g. one distribution per
// measure sharing the same slice labels — "dept-comparison grouped bars" is
// several measures across the same department labels). This file is the
// kit's OWN internal reconciliation, not a contract adapter the caller has to
// write: the caller still just hands over real `ReportSeries[]` or
// `ReportDistribution[]` values straight from the document (§7: "no adapter
// layer" means TR-17 never transforms the document before calling the kit).
import { bucketSeries, type ReportSeries, type ReportDistribution, type ReportUnit } from "@/lib/reports";

export interface BarGroup { categoryKey: string; categoryLabel: string; values: (number | null)[] }
export interface NormalizedBars { seriesKeys: string[]; seriesLabels: string[]; groups: BarGroup[]; unit: ReportUnit }

export type BarsInput =
  | { kind: "time"; series: ReportSeries[]; dayCount: number }
  | { kind: "category"; distributions: ReportDistribution[] };

function fmtBucketLabel(iso: string, granularity: "day" | "week" | "month"): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (granularity === "month") return d.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

export function normalizeBars(input: BarsInput): NormalizedBars {
  if (input.kind === "time") {
    const { series, dayCount } = input;
    const bucketed = series.map((s) => bucketSeries(s, series, dayCount));
    const n = Math.max(0, ...bucketed.map((b) => b.points.length));
    const groups: BarGroup[] = Array.from({ length: n }, (_, i) => ({
      categoryKey: bucketed[0]?.points[i]?.t ?? String(i),
      categoryLabel: bucketed[0]?.points[i] ? fmtBucketLabel(bucketed[0].points[i].t, bucketed[0].granularity) : "",
      values: bucketed.map((b) => b.points[i]?.v ?? null),
    }));
    return {
      seriesKeys: series.map((s) => s.key),
      seriesLabels: series.map((s) => s.label),
      groups,
      unit: series[0]?.unit ?? "count",
    };
  }

  const { distributions } = input;
  const labelOrder: string[] = [];
  const seen = new Set<string>();
  for (const d of distributions) {
    for (const s of d.slices) {
      if (!seen.has(s.label)) { seen.add(s.label); labelOrder.push(s.label); }
    }
  }
  const groups: BarGroup[] = labelOrder.map((label) => ({
    categoryKey: label,
    categoryLabel: label,
    values: distributions.map((d) => d.slices.find((s) => s.label === label)?.value ?? null),
  }));
  return {
    seriesKeys: distributions.map((d) => d.key),
    seriesLabels: distributions.map((d) => d.label),
    groups,
    unit: "count",
  };
}
