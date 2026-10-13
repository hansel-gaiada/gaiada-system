import { describe, it, expect } from "vitest";
import { OVERVIEW_PERIODS } from "./overview";
import { comparisonLabel, type ReportDocument, type ReportKpi } from "./reports";
import {
  NO_DATA, buildYourNumbers, formatHours, personReportHref, personReportParams, reportPeriodKind, todayIso,
} from "./overviewNumbers";

const kpi = (metricKey: string, value: number, extra: Partial<ReportKpi> = {}): ReportKpi => ({
  metricKey, label: metricKey, unit: "count", value, appraisalSafe: true, direction: "up_good", previous: { value: 0 }, ...extra,
});
const doc = (
  kpis: ReportKpi[], warnings?: ReportDocument["header"]["warnings"], comparison: Partial<NonNullable<ReportDocument["header"]["comparison"]>> = {},
): ReportDocument => ({
  header: {
    tenantId: "co-a", grain: "person", scopeRef: "u-1", scopeName: "Made", periodKind: "month",
    periodStart: "2026-10-01", periodEnd: "2026-10-31", dayCount: 31, periodLabel: "October 2026",
    generatedAt: "2026-10-13T08:00:00Z", sealed: false,
    comparison: { periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30, ...comparison },
    ...(warnings ? { warnings } : {}),
  },
  kpis,
  series: [], distributions: [], tables: [], highlights: [], narrative: { source: "deterministic", text: "" },
});

const FULL = [
  kpi("delivery.tasks_completed", 12, { delta: 3 }),
  kpi("delivery.on_time_rate", 0.8, { unit: "percent", numerator: 8, denominator: 10, delta: -0.04 }),
  kpi("effort.minutes_logged", 750, { unit: "minutes", delta: -90, appraisalSafe: false }),
  kpi("discipline.checkin_compliance", 0.9, { unit: "percent", numerator: 9, denominator: 10, delta: 0.1 }),
];
const tile = (m: ReturnType<typeof buildYourNumbers>, key: string) => m.tiles.find((t) => t.key === key)!;

describe("the period to read (DW-3d)", () => {
  it("maps the six Overview periods one to one onto report period kinds", () => {
    expect(OVERVIEW_PERIODS.map(reportPeriodKind)).toEqual(["day", "week", "month", "quarter", "semester", "year"]);
  });

  it("reads the person grain for the signed-in person, with today as start (the server snaps the bounds)", () => {
    for (const period of OVERVIEW_PERIODS) {
      expect(personReportParams("u-1", period, "2026-10-13")).toEqual({
        grain: "person", scopeRef: "u-1", periodKind: period, start: "2026-10-13", end: "2026-10-13",
      });
    }
  });

  it("links to the person report with the same period, in the params that page reads", () => {
    expect(personReportHref("quarter", "2026-10-13")).toBe("/reports/person?periodKind=quarter&start=2026-10-13");
    expect(personReportHref("day", "2026-10-13")).toBe("/reports/person?periodKind=day&start=2026-10-13");
  });

  it("takes today in UTC, like the report page", () => {
    expect(todayIso(new Date("2026-10-13T23:59:00Z"))).toBe("2026-10-13");
  });
});

describe("buildYourNumbers: the tiles", () => {
  it("draws the four tiles, in order, with their values and what is behind a ratio", () => {
    const m = buildYourNumbers(doc(FULL));
    expect(m.tiles.map((t) => [t.label, t.value, t.detail])).toEqual([
      ["Tasks done", "12", null],
      ["On time", "80%", "8 of 10"],
      ["Hours logged", "12.5 h", null],
      ["Check-ins", "9 of 10", "90%"],
    ]);
    expect(m.tiles.every((t) => !t.noData)).toBe(true);
    expect(m.periodLabel).toBe("October 2026");
  });

  it("carries each delta against the previous period, in the tile's own unit, with the report's direction", () => {
    const m = buildYourNumbers(doc(FULL));
    expect(tile(m, "tasks-done").delta).toEqual({ change: 3, magnitude: "3", direction: "up_good" });
    // A ratio's delta is a difference of fractions: 0.04 is four percentage points.
    expect(tile(m, "on-time").delta).toEqual({ change: -4, magnitude: "4pp", direction: "up_good" });
    expect(tile(m, "hours-logged").delta).toEqual({ change: -1.5, magnitude: "1.5 h", direction: "up_good" });
    expect(tile(m, "check-ins").delta).toEqual({ change: 10, magnitude: "10pp", direction: "up_good" });
  });

  it("names the compared range once, from the document", () => {
    expect(buildYourNumbers(doc(FULL)).comparison).toBe(comparisonLabel(doc(FULL).header.comparison));
    expect(buildYourNumbers(doc(FULL)).comparison).toMatch(/^vs /);
  });

  it("passes a KPI's direction through, so a metric where down is good is coloured by the one rule", () => {
    const m = buildYourNumbers(doc([kpi("delivery.tasks_completed", 4, { delta: -2, direction: "down_good" })]));
    expect(tile(m, "tasks-done").delta?.direction).toBe("down_good");
  });

  it("says No data for a ratio over a denominator of 0, never 0%, and gives it no change", () => {
    const m = buildYourNumbers(doc([
      kpi("delivery.on_time_rate", 0, { unit: "percent", numerator: 0, denominator: 0, delta: -0.5 }),
      kpi("discipline.checkin_compliance", 0, { unit: "percent", numerator: 0, denominator: 0, delta: 0.2 }),
    ]));
    for (const key of ["on-time", "check-ins"]) {
      expect(tile(m, key)).toMatchObject({ value: NO_DATA, noData: true, detail: null, delta: null });
    }
    // The same ratio with a real 0 of 4 is a stated 0%.
    const zero = buildYourNumbers(doc([kpi("delivery.on_time_rate", 0, { unit: "percent", numerator: 0, denominator: 4 })]));
    expect(tile(zero, "on-time")).toMatchObject({ value: "0%", noData: false, detail: "0 of 4" });
  });

  it("says No data for a ratio that does not carry its parts", () => {
    const m = buildYourNumbers(doc([kpi("delivery.on_time_rate", 0.5, { unit: "percent" })]));
    expect(tile(m, "on-time").noData).toBe(true);
  });

  it("says No data for a KPI the document does not carry, tile by tile, never a made-up 0", () => {
    const none = buildYourNumbers(doc([]));
    expect(none.tiles.map((t) => [t.label, t.value])).toEqual([
      ["Tasks done", NO_DATA], ["On time", NO_DATA], ["Hours logged", NO_DATA], ["Check-ins", NO_DATA],
    ]);
    const some = buildYourNumbers(doc([FULL[0]]));
    expect(some.tiles.map((t) => t.noData)).toEqual([false, true, true, true]);
  });

  it("says No data for a value that is not a number", () => {
    expect(tile(buildYourNumbers(doc([kpi("delivery.tasks_completed", Number.NaN)])), "tasks-done").noData).toBe(true);
  });

  it("shows minutes as hours to one decimal, and a stated 0 as 0 h", () => {
    expect(formatHours(150)).toBe("2.5 h");
    expect(formatHours(120)).toBe("2 h");
    expect(formatHours(30)).toBe("0.5 h");
    expect(formatHours(0)).toBe("0 h");
    expect(formatHours(61)).toBe("1 h");
    const m = buildYourNumbers(doc([kpi("effort.minutes_logged", 0, { unit: "minutes", delta: 0 })]));
    expect(tile(m, "hours-logged")).toMatchObject({ value: "0 h", noData: false });
  });

  it("a change that rounds to nothing is flat, and never -0", () => {
    const m = buildYourNumbers(doc([kpi("delivery.tasks_completed", 5, { delta: -0.2 }), kpi("effort.minutes_logged", 60, { unit: "minutes", delta: -1 })]));
    expect(tile(m, "tasks-done").delta?.change).toBe(0);
    expect(tile(m, "tasks-done").delta?.magnitude).toBe("0");
    expect(tile(m, "hours-logged").delta?.change).toBe(0);
  });

  it("gives no delta when the document states none", () => {
    const m = buildYourNumbers(doc([kpi("delivery.tasks_completed", 5)]));
    expect(tile(m, "tasks-done")).toMatchObject({ value: "5", delta: null });
  });
});

describe("buildYourNumbers: the period starts before the facts do", () => {
  const history = { firstFactDate: "2026-05-01", affectedDays: 120 };

  it("says the numbers cover only part of the period, and from when records begin", () => {
    const m = buildYourNumbers(doc(FULL, { precedesFactHistory: history }));
    expect(m.note).toMatch(/cover only part of this period/);
    expect(m.note).toContain("1 May 2026");
  });

  it("still shows the values, but no change and no comparison range: the earlier period has no records to compare with", () => {
    const m = buildYourNumbers(doc(FULL, { precedesFactHistory: history }));
    expect(m.tiles.map((t) => t.value)).toEqual(["12", "80%", "12.5 h", "9 of 10"]);
    expect(m.tiles.every((t) => t.delta === null)).toBe(true);
    expect(m.comparison).toBeNull();
  });

  it("says nothing of the sort when the warning is absent", () => {
    expect(buildYourNumbers(doc(FULL)).note).toBeNull();
    expect(buildYourNumbers(doc(FULL, {})).note).toBeNull();
  });

  it("deliberately ignores the other warnings: a current period always ends in the future, and the rest are not set for this read", () => {
    const m = buildYourNumbers(doc(FULL, { endsInFuture: true, partialPeriod: true, adHoc: true, spansMembershipChange: true }));
    expect(m.note).toBeNull();
    expect(tile(m, "tasks-done").delta).not.toBeNull();
  });
});

describe("buildYourNumbers: comparison honesty (DW-3d2, DW-4m)", () => {
  const cmpHistory = { firstFactDate: "2026-05-01", affectedDays: 10 };
  const history = { firstFactDate: "2026-05-01", affectedDays: 120 };
  const withoutPrevious = (kpis: ReportKpi[]) => kpis.map(({ previous: _p, ...k }) => k as ReportKpi);

  it("shows a delta when the KPI carries previous and a delta", () => {
    expect(tile(buildYourNumbers(doc(FULL)), "tasks-done").delta).toMatchObject({ change: 3 });
  });

  it("shows no delta for a KPI without previous (a sealed pre-DW-4m document), and no note", () => {
    const m = buildYourNumbers(doc(withoutPrevious(FULL)));
    expect(m.tiles.every((t) => t.delta === null)).toBe(true);
    expect(m.tiles.map((t) => t.value)).toEqual(["12", "80%", "12.5 h", "9 of 10"]);
    expect(m.note).toBeNull();
  });

  it("shows no delta for a ratio whose delta is absent, and keeps the other deltas", () => {
    const onTime = kpi("delivery.on_time_rate", 0.8, { unit: "percent", numerator: 8, denominator: 10, previous: { value: 0, numerator: 0, denominator: 0 } });
    const m = buildYourNumbers(doc([FULL[0], onTime]));
    expect(tile(m, "on-time")).toMatchObject({ value: "80%", delta: null });
    expect(tile(m, "tasks-done").delta).not.toBeNull();
  });

  it("noFacts: no KPI shows a delta, the range is not named, and the note says the previous period has no records", () => {
    const m = buildYourNumbers(doc(FULL, undefined, { noFacts: true, precedesFactHistory: cmpHistory }));
    expect(m.tiles.every((t) => t.delta === null)).toBe(true);
    expect(m.comparison).toBeNull();
    expect(m.note).toBe("No records in the previous period to compare with.");
  });

  it("comparison precedesFactHistory: deltas stay and the note gives the date", () => {
    const m = buildYourNumbers(doc(FULL, undefined, { precedesFactHistory: cmpHistory }));
    expect(m.tiles.every((t) => t.delta !== null)).toBe(true);
    expect(m.comparison).toMatch(/^vs /);
    expect(m.note).toBe("Compared with a period that starts before records began on 1 May 2026.");
  });

  it("the current period's partial warning wins over both comparison notes", () => {
    const m = buildYourNumbers(doc(FULL, { precedesFactHistory: history }, { noFacts: true, precedesFactHistory: cmpHistory }));
    expect(m.note).toMatch(/cover only part of this period/);
    expect(m.tiles.every((t) => t.delta === null)).toBe(true);
    const p = buildYourNumbers(doc(FULL, { precedesFactHistory: history }, { precedesFactHistory: cmpHistory }));
    expect(p.note).toMatch(/cover only part of this period/);
  });

  it("says nothing when the comparison is clean", () => {
    expect(buildYourNumbers(doc(FULL)).note).toBeNull();
  });
});
