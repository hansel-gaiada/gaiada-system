// TR-08 — pure tests for the reports metric catalog: no database, matching the house pattern
// (fact-job.test.ts pins the pure half of TR-07; this pins the pure half of TR-08).
import { describe, it, expect } from "vitest";
import {
  REPORT_METRICS,
  SEEDED_REPORT_METRICS,
  getReportMetric,
  toMetricDefs,
  parsePeriodRange,
  formatPeriodRange,
  inclusiveDayCount,
} from "./metrics";

// The governed CHECK vocabulary, restated (0001_core.sql:83) — the acceptance bar this catalog
// must never violate.
const ALLOWED_AGGREGATION_RULES = new Set(["sum", "ratio_of_sums", "max", "last"]);

describe("TR-08 REPORT_METRICS catalog", () => {
  it("carries exactly 22 metrics total, 21 seeded, #22 explicitly not seeded", () => {
    expect(REPORT_METRICS).toHaveLength(22);
    expect(SEEDED_REPORT_METRICS).toHaveLength(21);
    const unseeded = REPORT_METRICS.filter((m) => !m.seeded);
    expect(unseeded).toHaveLength(1);
    expect(unseeded[0].metricKey).toBe("evidence.source_diversity");
  });

  it("every SEEDED metric's aggregationRule is inside the shared, unwidened CHECK vocabulary", () => {
    for (const m of SEEDED_REPORT_METRICS) {
      expect(ALLOWED_AGGREGATION_RULES.has(m.aggregationRule), `${m.metricKey}: ${m.aggregationRule}`).toBe(true);
    }
  });

  it("#20 discipline.overdue_open seeds as 'last' (point-in-time, never summed)", () => {
    const m = getReportMetric("discipline.overdue_open");
    expect(m.aggregationRule).toBe("last");
    expect(m.rangeClass).toBe("non_additive");
    expect(m.seeded).toBe(true);
  });

  it("#22 evidence.source_diversity is NOT seeded and never uses 'max'", () => {
    const m = getReportMetric("evidence.source_diversity");
    expect(m.seeded).toBe(false);
    expect(m.rangeClass).toBe("non_additive");
  });

  it("toMetricDefs() projects exactly the 21 seeded rows, never monetary, never widening the unit vocabulary", () => {
    const defs = toMetricDefs();
    expect(defs).toHaveLength(21);
    for (const d of defs) {
      expect(d.isMonetary).toBe(false);
      expect(["count", "ratio", "minutes", "money_minor"]).toContain(d.unit);
      expect(ALLOWED_AGGREGATION_RULES.has(d.aggregationRule)).toBe(true);
    }
    expect(defs.find((d) => d.metricKey === "evidence.source_diversity")).toBeUndefined();
  });

  // §5's prose: "Nine appraisal-safe metrics feed the four appraisal axes; the other thirteen
  // exist for ops truth and report richness." This is the ticket's own acceptance criterion —
  // "The appraisal-unsafe flags in the catalog match §5's table exactly — 9 safe, the rest
  // unsafe." Pinned against the EXACT metric keys, not just a count, so a flag flipping on the
  // wrong metric (right count, wrong member) still fails loudly.
  it("exactly the nine documented metrics are appraisal-safe", () => {
    const EXPECTED_SAFE = new Set([
      "delivery.throughput_weighted",
      "delivery.on_time_rate",
      "delivery.estimate_coverage",
      "delivery.milestone_hit_rate",
      "flow.reopen_rate",
      "effort.estimate_accuracy",
      "collab.contributed_minutes",
      "discipline.checkin_compliance",
      "discipline.time_logging_coverage",
    ]);
    const actualSafe = new Set(REPORT_METRICS.filter((m) => m.appraisalSafe).map((m) => m.metricKey));
    expect(actualSafe).toEqual(EXPECTED_SAFE);
    expect(actualSafe.size).toBe(9);
  });

  it("effort.billable_share is UNSAFE overall despite being safe at D/C — appraisal packs are person-grain", () => {
    const m = getReportMetric("effort.billable_share");
    expect(m.appraisalSafe).toBe(false);
    expect(m.grains).toContain("person");
  });

  it("getReportMetric throws on an unknown key", () => {
    expect(() => getReportMetric("nope.not.real")).toThrow(/unknown report metric/);
  });
});

describe("TR-08 period-range convention ('YYYY-MM-DD:YYYY-MM-DD')", () => {
  it("round-trips format/parse and computes the inclusive day count", () => {
    const period = formatPeriodRange("2026-07-14", "2026-07-20");
    expect(period).toBe("2026-07-14:2026-07-20");
    const range = parsePeriodRange(period);
    expect(range).toEqual({ start: "2026-07-14", end: "2026-07-20", days: 7 });
  });

  it("a single day is 1 inclusive day", () => {
    expect(parsePeriodRange("2026-07-15:2026-07-15").days).toBe(1);
  });

  // The exact "awkward span" the ticket calls out: 11 days crossing a month boundary.
  it("an 11-day span crossing a month boundary counts 11 real days, never an assumed 7 or 30", () => {
    const range = parsePeriodRange("2026-07-26:2026-08-05");
    expect(range.days).toBe(11);
    expect(inclusiveDayCount("2026-07-26", "2026-08-05")).toBe(11);
  });

  it("rejects a malformed period string", () => {
    expect(() => parsePeriodRange("2026-07")).toThrow(/must be/);
    expect(() => parsePeriodRange("not-a-period")).toThrow(/must be/);
  });

  it("rejects an inverted range (end before start)", () => {
    expect(() => parsePeriodRange("2026-07-20:2026-07-14")).toThrow(/precedes/);
  });
});
