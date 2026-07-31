// TR-13 — the PURE half of the document builder: calendar range resolution, the comparison
// baseline, scope matching over RollupRow[], KPI shaping, header warnings, and the deterministic
// highlights/narrative. No database, no clock — house pattern (dept-resolution.test.ts,
// fact-job.test.ts). The I/O orchestration (`buildReportDocument` itself) is covered against live
// Postgres in document-builder.db.test.ts, including the additivity proof.
import { describe, it, expect } from "vitest";
import {
  buildHeadlineKpis,
  buildHighlights,
  buildKpis,
  buildNarrative,
  computeHeaderWarnings,
  formatPeriodLabel,
  matchesScope,
  mondayOnOrBefore,
  previousPeriodRange,
  resolveCalendarRange,
  rowGrainShape,
} from "./document-builder";
import type { RollupRow } from "../contract";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "99999999-9999-4999-8999-999999999999";

describe("resolveCalendarRange", () => {
  it("day: start === end === the given date", () => {
    expect(resolveCalendarRange("day", "2026-07-16")).toEqual({ start: "2026-07-16", end: "2026-07-16" });
  });

  it("week: Monday..Sunday of the ISO week containing the given date, regardless of which weekday was passed", () => {
    // 2026-07-16 is a Thursday.
    expect(resolveCalendarRange("week", "2026-07-16")).toEqual({ start: "2026-07-13", end: "2026-07-19" });
    // Passing the Monday itself must resolve to the identical week.
    expect(resolveCalendarRange("week", "2026-07-13")).toEqual({ start: "2026-07-13", end: "2026-07-19" });
    // Passing the Sunday itself must ALSO resolve to the identical week.
    expect(resolveCalendarRange("week", "2026-07-19")).toEqual({ start: "2026-07-13", end: "2026-07-19" });
  });

  it("month: 1st..last day of the calendar month containing the given date", () => {
    expect(resolveCalendarRange("month", "2026-07-16")).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    // February in a non-leap year (2026) has 28 days.
    expect(resolveCalendarRange("month", "2026-02-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    // 2028 is a leap year.
    expect(resolveCalendarRange("month", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("mondayOnOrBefore is idempotent on a Monday", () => {
    expect(mondayOnOrBefore("2026-07-13")).toBe("2026-07-13");
  });
});

describe("previousPeriodRange — the comparison baseline", () => {
  it("day: the single preceding day", () => {
    expect(previousPeriodRange("day", "2026-07-16", "2026-07-16", 1)).toEqual({ start: "2026-07-15", end: "2026-07-15", dayCount: 1 });
  });

  it("week: exactly 7 days earlier on both ends", () => {
    expect(previousPeriodRange("week", "2026-07-13", "2026-07-19", 7)).toEqual({ start: "2026-07-06", end: "2026-07-12", dayCount: 7 });
  });

  it("month: the previous CALENDAR month, with its OWN day count — proves the month-boundary acceptance bar", () => {
    // March (31 days) -> February (2026, non-leap, 28 days). This is the exact "comparison deltas
    // correct across month boundaries" case: the two windows are NOT equal length, which is
    // correct, not a bug (§5.4 ratios recompute over their own actual day count either side).
    expect(previousPeriodRange("month", "2026-03-01", "2026-03-31", 31)).toEqual({ start: "2026-02-01", end: "2026-02-28", dayCount: 28 });
    // A year boundary: January's previous month is the PRIOR year's December.
    expect(previousPeriodRange("month", "2026-01-01", "2026-01-31", 31)).toEqual({ start: "2025-12-01", end: "2025-12-31", dayCount: 31 });
  });

  it("custom: the immediately preceding EQUAL-LENGTH window ([start - dayCount, start - 1])", () => {
    expect(previousPeriodRange("custom", "2026-07-16", "2026-07-22", 7)).toEqual({ start: "2026-07-09", end: "2026-07-15", dayCount: 7 });
  });
});

describe("formatPeriodLabel", () => {
  it("matches §6.1's display examples", () => {
    expect(formatPeriodLabel("day", "2026-07-16", "2026-07-16")).toBe("16 Jul 2026");
    expect(formatPeriodLabel("week", "2026-07-13", "2026-07-19")).toBe("Week 29 2026");
    expect(formatPeriodLabel("month", "2026-07-01", "2026-07-31")).toBe("July 2026");
    expect(formatPeriodLabel("custom", "2026-07-16", "2026-08-03")).toBe("16 Jul 2026 - 3 Aug 2026");
  });
});

describe("matchesScope + rowGrainShape — exact single-key dimension matching", () => {
  it("person: matches on userId alone", () => {
    expect(matchesScope("person", { userId: ALICE }, ALICE)).toBe(true);
    expect(matchesScope("person", { userId: BOB }, ALICE)).toBe(false);
  });
  it("project: matches on projectId alone", () => {
    expect(matchesScope("project", { projectId: PROJECT }, PROJECT)).toBe(true);
  });
  it("company: matches ONLY the empty-dimensions row", () => {
    expect(matchesScope("company", {}, "anything")).toBe(true);
    expect(matchesScope("company", { unit: "d-eng" }, "anything")).toBe(false);
  });
  it("department: own numbers require servedTenant to be ABSENT; a servedTenant slice requires an exact match", () => {
    expect(matchesScope("department", { unit: "d-eng" }, "d-eng")).toBe(true);
    expect(matchesScope("department", { unit: "d-eng", servedTenant: "co-b" }, "d-eng")).toBe(false); // own read excludes served rows
    expect(matchesScope("department", { unit: "d-eng", servedTenant: "co-b" }, "d-eng", "co-b")).toBe(true);
    expect(matchesScope("department", { unit: "d-eng", servedTenant: "co-b" }, "d-eng", "co-c")).toBe(false); // wrong served tenant
    expect(matchesScope("department", { unit: "d-eng" }, "d-eng", "co-b")).toBe(false); // asked for a served slice that doesn't exist
  });
  it("rowGrainShape classifies the same exact-shape dimensions", () => {
    expect(rowGrainShape({ userId: ALICE })).toBe("person");
    expect(rowGrainShape({ projectId: PROJECT })).toBe("project");
    expect(rowGrainShape({ unit: "d-eng" })).toBe("department");
    expect(rowGrainShape({})).toBe("company");
  });
});

describe("buildKpis", () => {
  const currentRows: RollupRow[] = [
    { metricKey: "delivery.tasks_completed", numerator: 4, dimensions: { userId: ALICE } },
    { metricKey: "delivery.on_time_rate", numerator: 3, denominator: 4, dimensions: { userId: ALICE } },
    { metricKey: "discipline.overdue_open", numerator: 2, dimensions: { userId: ALICE } },
  ];
  const previousRows: RollupRow[] = [
    { metricKey: "delivery.tasks_completed", numerator: 2, dimensions: { userId: ALICE } },
    { metricKey: "delivery.on_time_rate", numerator: 1, denominator: 2, dimensions: { userId: ALICE } },
  ];

  it("carries numerator/denominator for a ratio metric, and computes value = n/d (never re-averaged)", () => {
    const kpis = buildKpis("person", ALICE, currentRows, previousRows, undefined, { current: 0, previous: 0 });
    const onTime = kpis.find((k) => k.metricKey === "delivery.on_time_rate")!;
    expect(onTime.numerator).toBe(3);
    expect(onTime.denominator).toBe(4);
    expect(onTime.value).toBeCloseTo(0.75);
  });

  it("computes delta vs the comparison period's value in the same unit", () => {
    const kpis = buildKpis("person", ALICE, currentRows, previousRows, undefined, { current: 0, previous: 0 });
    const completed = kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.value).toBe(4);
    expect(completed.delta).toBe(2); // 4 - 2
  });

  it("never emits a plain-sum metric with a denominator, and #20 carries pointInTime (never a KPI text unit)", () => {
    const kpis = buildKpis("person", ALICE, currentRows, previousRows, undefined, { current: 0, previous: 0 });
    const completed = kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.denominator).toBeUndefined();
    expect(completed.unit).not.toBe("text");
    const overdue = kpis.find((k) => k.metricKey === "discipline.overdue_open")!;
    expect(overdue.pointInTime).toBe(true);
    expect(overdue.denominator).toBeUndefined();
    for (const k of kpis) expect(k.unit).not.toBe("text");
  });

  it("#22 evidence.source_diversity carries distinctOver and reads from the dedicated diversity pair, not currentRows", () => {
    const kpis = buildKpis("person", ALICE, [], [], undefined, { current: 3, previous: 1 });
    const diversity = kpis.find((k) => k.metricKey === "evidence.source_diversity")!;
    expect(diversity.distinctOver).toBe(true);
    expect(diversity.value).toBe(3);
    expect(diversity.delta).toBe(2);
  });

  it("a metric with no matching row reads as an honest zero (empty-but-valid), never throws", () => {
    const kpis = buildKpis("person", BOB, currentRows, previousRows, undefined, { current: 0, previous: 0 });
    const completed = kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.value).toBe(0);
    const onTime = kpis.find((k) => k.metricKey === "delivery.on_time_rate")!;
    expect(onTime.value).toBe(0);
    expect(onTime.numerator).toBe(0);
    expect(onTime.denominator).toBe(0);
  });

  it("only emits KPIs applicable to the requested grain", () => {
    // milestone_hit_rate is project/department/company only, never person.
    const kpis = buildKpis("person", ALICE, [], [], undefined, { current: 0, previous: 0 });
    expect(kpis.some((k) => k.metricKey === "delivery.milestone_hit_rate")).toBe(false);
  });
});

describe("buildHeadlineKpis (overview listing)", () => {
  it("omits delta entirely (no comparison fan-out for a listing)", () => {
    const rows: RollupRow[] = [{ metricKey: "delivery.tasks_completed", numerator: 5, dimensions: { userId: ALICE } }];
    const kpis = buildHeadlineKpis("person", ALICE, rows);
    const completed = kpis.find((k) => k.metricKey === "delivery.tasks_completed")!;
    expect(completed.value).toBe(5);
    expect(completed.delta).toBeUndefined();
  });
});

describe("computeHeaderWarnings", () => {
  const base = { periodKind: "month" as const, start: "2026-07-01", end: "2026-07-31", today: "2026-08-15", firstFactDate: null };

  it("no warnings for a fully-elapsed, in-history calendar month", () => {
    expect(computeHeaderWarnings(base)).toBeUndefined();
  });

  it("flags endsInFuture when periodEnd is after today", () => {
    const w = computeHeaderWarnings({ ...base, today: "2026-07-20" });
    expect(w?.endsInFuture).toBe(true);
    expect(w?.partialPeriod).toBe(true); // the current month hasn't fully elapsed yet
  });

  it("always flags adHoc for a custom range", () => {
    const w = computeHeaderWarnings({ periodKind: "custom", start: "2026-07-01", end: "2026-07-31", today: "2026-08-15", firstFactDate: null });
    expect(w?.adHoc).toBe(true);
    expect(w?.partialPeriod).toBeUndefined(); // this custom range happens to equal a whole month
  });

  it("flags partialPeriod for a custom range that does not align to a whole week or month", () => {
    const w = computeHeaderWarnings({ periodKind: "custom", start: "2026-07-05", end: "2026-07-10", today: "2026-08-15", firstFactDate: null });
    expect(w?.partialPeriod).toBe(true);
  });

  it("flags precedesFactHistory with the correct affected day count", () => {
    const w = computeHeaderWarnings({ ...base, firstFactDate: "2026-07-15" });
    expect(w?.precedesFactHistory).toEqual({ firstFactDate: "2026-07-15", affectedDays: 14 }); // Jul 1..14
  });

  it("flags spansMembershipChange when passed true", () => {
    const w = computeHeaderWarnings({ ...base, spansMembershipChange: true });
    expect(w?.spansMembershipChange).toBe(true);
  });
});

describe("buildHighlights + buildNarrative — deterministic, never AI", () => {
  it("achievement highlight names the completed/on-time counts", () => {
    const kpis = buildKpis(
      "person",
      ALICE,
      [
        { metricKey: "delivery.tasks_completed", numerator: 4, dimensions: { userId: ALICE } },
        { metricKey: "delivery.on_time_rate", numerator: 3, denominator: 4, dimensions: { userId: ALICE } },
      ],
      [],
      undefined,
      { current: 0, previous: 0 },
    );
    const highlights = buildHighlights(kpis, "2026-07-31", "2026-08-15");
    const achievement = highlights.find((h) => h.kind === "achievement");
    expect(achievement?.text).toContain("Completed 4 tasks");
    expect(achievement?.text).toContain("3 of 4 on time");

    const narrative = buildNarrative(kpis);
    expect(narrative.source).toBe("deterministic");
    expect(narrative.text).toContain("Completed 4 tasks");
  });

  it("the overdue-open highlight carries the point-in-time honesty note on a PAST unsealed range", () => {
    const kpis = buildKpis("person", ALICE, [{ metricKey: "discipline.overdue_open", numerator: 2, dimensions: { userId: ALICE } }], [], undefined, { current: 0, previous: 0 });
    const past = buildHighlights(kpis, "2026-07-20", "2026-08-15");
    const compliance = past.find((h) => h.kind === "compliance");
    expect(compliance?.text).toContain("point-in-time, unsealed");

    // On a range ending TODAY, the reading is exact — no caveat needed.
    const currentEnd = buildHighlights(kpis, "2026-08-15", "2026-08-15");
    expect(currentEnd.find((h) => h.kind === "compliance")?.text).not.toContain("point-in-time");
  });

  it("an empty KPI set narrates honestly rather than fabricating activity", () => {
    const narrative = buildNarrative([]);
    expect(narrative.text).toBe("No activity recorded for this period.");
  });
});
