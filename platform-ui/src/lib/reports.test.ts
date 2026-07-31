import { describe, it, expect } from "vitest";
import {
  bucketGranularityFor, bucketKeyFor, bucketSeries, bucketSeriesWithParts, formatDateRange, comparisonLabel,
  buildPresetRanges, dayCountOf, REPORT_MAX_CUSTOM_DAYS,
  type ReportSeries,
} from "./reports";

describe("bucketGranularityFor — the day/week/month boundary (§7)", () => {
  it("stays daily up to 45 days", () => {
    expect(bucketGranularityFor(1)).toBe("day");
    expect(bucketGranularityFor(44)).toBe("day");
    expect(bucketGranularityFor(45)).toBe("day");
  });
  it("switches to weekly at 46 days (the off-by-one boundary)", () => {
    expect(bucketGranularityFor(46)).toBe("week");
    expect(bucketGranularityFor(182)).toBe("week");
  });
  it("switches to monthly at 183 days", () => {
    expect(bucketGranularityFor(183)).toBe("month");
  });
  it("a 400-day custom range is monthly, ~13 buckets — never 400 points", () => {
    expect(bucketGranularityFor(400)).toBe("month");
  });
});

describe("bucketKeyFor", () => {
  it("day granularity is the identity function", () => {
    expect(bucketKeyFor("2026-07-15", "day")).toBe("2026-07-15");
  });
  it("week granularity floors to the ISO week's Monday", () => {
    // 2026-07-15 is a Wednesday
    expect(bucketKeyFor("2026-07-15", "week")).toBe("2026-07-13");
    // Monday itself maps to itself
    expect(bucketKeyFor("2026-07-13", "week")).toBe("2026-07-13");
    // Sunday maps to the Monday that started its week
    expect(bucketKeyFor("2026-07-19", "week")).toBe("2026-07-13");
  });
  it("month granularity floors to the 1st of the month", () => {
    expect(bucketKeyFor("2026-07-31", "month")).toBe("2026-07-01");
    expect(bucketKeyFor("2026-02-05", "month")).toBe("2026-02-01");
  });
});

function daily(key: string, label: string, values: (number | null)[], startIso = "2026-01-01", extra?: Partial<ReportSeries>): ReportSeries {
  const points = values.map((v, i) => ({ t: addDaysIso(startIso, i), v }));
  return { key, label, unit: "count", kind: "line", points, ...extra };
}
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

describe("bucketSeries — additive default (SUM), never re-aggregated from scratch", () => {
  it("passes through unchanged at day granularity", () => {
    const s = daily("throughput", "Throughput", [1, 2, 3]);
    const b = bucketSeries(s, [s], 3);
    expect(b.granularity).toBe("day");
    expect(b.points).toEqual(s.points);
  });

  it("sums an additive series into weekly buckets", () => {
    // 14 days -> two 7-day ISO-week buckets starting on a Monday.
    const values = Array.from({ length: 14 }, (_, i) => i + 1); // 1..14
    const s = daily("activity", "Activity", values, "2026-07-13"); // Monday
    const b = bucketSeries(s, [s], 50); // dayCount forces weekly bucketing
    expect(b.granularity).toBe("week");
    expect(b.points).toHaveLength(2);
    expect(b.points[0]).toEqual({ t: "2026-07-13", v: (1 + 2 + 3 + 4 + 5 + 6 + 7) });
    expect(b.points[1]).toEqual({ t: "2026-07-20", v: (8 + 9 + 10 + 11 + 12 + 13 + 14) });
  });

  it("a bucket with no real data anywhere stays null — never zero-faked", () => {
    const s = daily("activity", "Activity", [null, null, null, null, null, null, null], "2026-07-13");
    const b = bucketSeries(s, [s], 50);
    expect(b.points[0].v).toBeNull();
  });

  it("a partially-null bucket sums only the real days", () => {
    const s = daily("activity", "Activity", [5, null, 3, null, null, null, null], "2026-07-13");
    const b = bucketSeries(s, [s], 50);
    expect(b.points[0].v).toBe(8);
  });
});

describe("bucketSeries — ratio series recompute Σn/Σd, never average pre-computed ratios", () => {
  it("bucketing a ratio series looks up its numerator/denominator siblings", () => {
    // Day 1: 1/2 = 0.5 ; Day 2: 3/2 = 1.5 — naive average of ratios would be 1.0,
    // but the honest Σn/Σd over the 2-day bucket is (1+3)/(2+2) = 1.0 here by
    // coincidence of these numbers, so use asymmetric denominators to distinguish:
    // Day1: n=1,d=1 -> ratio 1 ; Day2: n=1,d=3 -> ratio 0.333 — average = 0.667,
    // but Σn/Σd = 2/4 = 0.5.
    const numer = daily("done_n", "Done (n)", [1, 1]);
    const denom = daily("done_d", "Done (d)", [1, 3]);
    const ratio: ReportSeries = {
      key: "on_time_rate", label: "On-time rate", unit: "percent", kind: "line",
      points: [{ t: "2026-01-01", v: 1 }, { t: "2026-01-02", v: 0.333 }],
      numeratorKey: "done_n", denominatorKey: "done_d",
    };
    const all = [ratio, numer, denom];
    const b = bucketSeries(ratio, all, 50); // force week bucketing — both days fall in the same ISO week (2026-01-01 is a Thursday)
    expect(b.points).toHaveLength(1);
    expect(b.points[0].v).toBeCloseTo(0.5, 5);
  });
});

describe("bucketSeriesWithParts — honest n/d tooltip at any bucket granularity (§7)", () => {
  it("carries the summed raw numerator/denominator behind a bucketed ratio", () => {
    const numer = daily("done_n", "Done (n)", [1, 1]);
    const denom = daily("done_d", "Done (d)", [1, 3]);
    const ratio: ReportSeries = {
      key: "on_time_rate", label: "On-time rate", unit: "percent", kind: "line",
      points: [{ t: "2026-01-01", v: 1 }, { t: "2026-01-02", v: 0.333 }],
      numeratorKey: "done_n", denominatorKey: "done_d",
    };
    const b = bucketSeriesWithParts(ratio, [ratio, numer, denom], 50);
    expect(b.points).toHaveLength(1);
    expect(b.points[0].numerator).toBe(2);
    expect(b.points[0].denominator).toBe(4);
    expect(b.points[0].v).toBeCloseTo(0.5, 5);
  });
});

describe("formatDateRange / comparisonLabel — the comparison chip must name the baseline (§7)", () => {
  it("formats a short human range", () => {
    expect(formatDateRange("2026-06-16", "2026-07-04")).toBe("16 Jun – 4 Jul");
  });
  it("never renders a bare 'vs previous period'", () => {
    const label = comparisonLabel({ periodStart: "2026-06-16", periodEnd: "2026-07-04", dayCount: 19 });
    expect(label).toBe("vs 16 Jun – 4 Jul");
    expect(label).not.toMatch(/previous period/i);
  });
  it("is null when there is no comparison window", () => {
    expect(comparisonLabel(undefined)).toBeNull();
  });
});

describe("buildPresetRanges", () => {
  it("Last 7/30/90 days end today and span the right length", () => {
    const presets = buildPresetRanges("2026-07-30");
    const last7 = presets.find((p) => p.label === "Last 7 days")!;
    expect(dayCountOf(last7.start, last7.end)).toBe(7);
    const last30 = presets.find((p) => p.label === "Last 30 days")!;
    expect(dayCountOf(last30.start, last30.end)).toBe(30);
    const last90 = presets.find((p) => p.label === "Last 90 days")!;
    expect(dayCountOf(last90.start, last90.end)).toBe(90);
  });
  it("This quarter / Last quarter / YTD land on real calendar boundaries", () => {
    // 2026-07-30 sits in Q3 (Jul-Sep)
    const presets = buildPresetRanges("2026-07-30");
    const thisQ = presets.find((p) => p.label === "This quarter")!;
    expect(thisQ.start).toBe("2026-07-01");
    const lastQ = presets.find((p) => p.label === "Last quarter")!;
    expect(lastQ.start).toBe("2026-04-01");
    expect(lastQ.end).toBe("2026-06-30");
    const ytd = presets.find((p) => p.label === "Year to date")!;
    expect(ytd.start).toBe("2026-01-01");
  });
  it("Last quarter rolls back across a year boundary from Q1", () => {
    const presets = buildPresetRanges("2026-02-10");
    const lastQ = presets.find((p) => p.label === "Last quarter")!;
    expect(lastQ.start).toBe("2025-10-01");
    expect(lastQ.end).toBe("2025-12-31");
  });
});

describe("dayCountOf / REPORT_MAX_CUSTOM_DAYS", () => {
  it("is inclusive of both endpoints", () => {
    expect(dayCountOf("2026-07-01", "2026-07-01")).toBe(1);
    expect(dayCountOf("2026-07-01", "2026-07-02")).toBe(2);
  });
  it("mirrors the server's 400-day ceiling (§6.2 range_too_large)", () => {
    expect(REPORT_MAX_CUSTOM_DAYS).toBe(400);
  });
});
