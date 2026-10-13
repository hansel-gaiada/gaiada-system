// DW-4a — pure tests for report-calendar.ts, the one calendar resolver (§15, DW-4a entry). No
// database, no clock. The GOLDEN table below is pinned byte-for-byte by its twin
// platform-ui/src/lib/demoReports.test.ts (the UI demo backend re-implements this math, so both
// sides must produce the same snapped range, label and comparison for the same input). Change one
// side's table and you must change the other.
import { describe, it, expect } from "vitest";
import {
  CALENDAR_KINDS,
  enumerateCalendarStarts,
  formatPeriodLabel,
  isCalendarKind,
  previousPeriodRange,
  resolveCalendarRange,
} from "./report-calendar";
import { inclusiveDayCount } from "./metrics";

// ---- GOLDEN TABLE (byte-identical twin) ----
const GOLDEN = [
  { kind: "day", input: "2026-10-14", start: "2026-10-14", end: "2026-10-14", dayCount: 1, label: "14 Oct 2026", prevStart: "2026-10-13", prevEnd: "2026-10-13", prevDayCount: 1 },
  { kind: "week", input: "2026-10-14", start: "2026-10-12", end: "2026-10-18", dayCount: 7, label: "Week 42 2026", prevStart: "2026-10-05", prevEnd: "2026-10-11", prevDayCount: 7 },
  { kind: "month", input: "2026-02-10", start: "2026-02-01", end: "2026-02-28", dayCount: 28, label: "February 2026", prevStart: "2026-01-01", prevEnd: "2026-01-31", prevDayCount: 31 },
  { kind: "quarter", input: "2026-08-17", start: "2026-07-01", end: "2026-09-30", dayCount: 92, label: "Q3 2026", prevStart: "2026-04-01", prevEnd: "2026-06-30", prevDayCount: 91 },
  { kind: "quarter", input: "2027-01-15", start: "2027-01-01", end: "2027-03-31", dayCount: 90, label: "Q1 2027", prevStart: "2026-10-01", prevEnd: "2026-12-31", prevDayCount: 92 },
  { kind: "quarter", input: "2026-12-31", start: "2026-10-01", end: "2026-12-31", dayCount: 92, label: "Q4 2026", prevStart: "2026-07-01", prevEnd: "2026-09-30", prevDayCount: 92 },
  { kind: "quarter", input: "2028-02-29", start: "2028-01-01", end: "2028-03-31", dayCount: 91, label: "Q1 2028", prevStart: "2027-10-01", prevEnd: "2027-12-31", prevDayCount: 92 },
  { kind: "semester", input: "2026-03-03", start: "2026-01-01", end: "2026-06-30", dayCount: 181, label: "Semester 1 2026", prevStart: "2025-07-01", prevEnd: "2025-12-31", prevDayCount: 184 },
  { kind: "semester", input: "2026-12-31", start: "2026-07-01", end: "2026-12-31", dayCount: 184, label: "Semester 2 2026", prevStart: "2026-01-01", prevEnd: "2026-06-30", prevDayCount: 181 },
  { kind: "semester", input: "2028-02-29", start: "2028-01-01", end: "2028-06-30", dayCount: 182, label: "Semester 1 2028", prevStart: "2027-07-01", prevEnd: "2027-12-31", prevDayCount: 184 },
  { kind: "year", input: "2026-06-15", start: "2026-01-01", end: "2026-12-31", dayCount: 365, label: "Year 2026", prevStart: "2025-01-01", prevEnd: "2025-12-31", prevDayCount: 365 },
  { kind: "year", input: "2028-07-01", start: "2028-01-01", end: "2028-12-31", dayCount: 366, label: "Year 2028", prevStart: "2027-01-01", prevEnd: "2027-12-31", prevDayCount: 365 },
  { kind: "year", input: "2029-01-01", start: "2029-01-01", end: "2029-12-31", dayCount: 365, label: "Year 2029", prevStart: "2028-01-01", prevEnd: "2028-12-31", prevDayCount: 366 },
] as const;
// ---- END GOLDEN TABLE ----

describe("DW-4a report-calendar golden table", () => {
  it.each(GOLDEN)("$kind $input -> $label", (row) => {
    const range = resolveCalendarRange(row.kind, row.input);
    expect(range).toEqual({ start: row.start, end: row.end });
    const dayCount = inclusiveDayCount(range.start, range.end);
    expect(dayCount).toBe(row.dayCount);
    expect(formatPeriodLabel(row.kind, range.start, range.end)).toBe(row.label);
    expect(previousPeriodRange(row.kind, range.start, range.end, dayCount)).toEqual({
      start: row.prevStart,
      end: row.prevEnd,
      dayCount: row.prevDayCount,
    });
  });

  it("any date inside a period snaps to the same range (first day, last day, a mid date)", () => {
    for (const [first, mid, last] of [
      ["2026-07-01", "2026-08-17", "2026-09-30"],
      ["2026-10-01", "2026-11-11", "2026-12-31"],
    ]) {
      const want = resolveCalendarRange("quarter", mid);
      expect(resolveCalendarRange("quarter", first)).toEqual(want);
      expect(resolveCalendarRange("quarter", last)).toEqual(want);
    }
    expect(resolveCalendarRange("semester", "2026-07-01")).toEqual(resolveCalendarRange("semester", "2026-12-31"));
    expect(resolveCalendarRange("year", "2026-01-01")).toEqual(resolveCalendarRange("year", "2026-12-31"));
  });

  it("a custom range keeps the equal-length preceding window", () => {
    expect(previousPeriodRange("custom", "2026-07-16", "2026-08-03", 19)).toEqual({ start: "2026-06-27", end: "2026-07-15", dayCount: 19 });
  });
});

describe("DW-4a enumerateCalendarStarts (quarter, semester, year)", () => {
  it("quarter: starts from the quarter containing `from`, one per quarter up to `to`", () => {
    expect(enumerateCalendarStarts("quarter", "2026-02-10", "2026-11-30")).toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
  });

  it("semester: crosses the year boundary", () => {
    expect(enumerateCalendarStarts("semester", "2026-05-01", "2027-02-01")).toEqual(["2026-01-01", "2026-07-01", "2027-01-01"]);
  });

  it("year: a two-day window across New Year yields both years", () => {
    expect(enumerateCalendarStarts("year", "2025-12-31", "2026-01-01")).toEqual(["2025-01-01", "2026-01-01"]);
  });

  it("a window wholly inside one quarter yields exactly that quarter's start", () => {
    expect(enumerateCalendarStarts("quarter", "2026-08-01", "2026-08-31")).toEqual(["2026-07-01"]);
  });
});

describe("DW-4a isCalendarKind", () => {
  it("accepts the six calendar kinds, in order, and rejects custom and junk", () => {
    expect([...CALENDAR_KINDS]).toEqual(["day", "week", "month", "quarter", "semester", "year"]);
    for (const k of CALENDAR_KINDS) expect(isCalendarKind(k)).toBe(true);
    expect(isCalendarKind("custom")).toBe(false);
    expect(isCalendarKind("decade")).toBe(false);
    expect(isCalendarKind(undefined)).toBe(false);
  });
});
