// TR-15 — pure tests for report-periods.ts's calendar-candidate enumeration (no database),
// matching the house pattern (metrics.test.ts / fact-job.test.ts pin the pure half of their own
// tickets the same way). `ensureCalendarPeriodRows`/`listPeriods`/`pinCustomPeriod` (the I/O half)
// are covered end-to-end, against live Postgres + Cerbos, in report-seal.db.test.ts.
import { describe, it, expect } from "vitest";
import { enumerateCalendarStarts } from "./report-periods";

describe("TR-15 enumerateCalendarStarts (pure)", () => {
  it("day kind: one start per calendar day, inclusive both ends", () => {
    expect(enumerateCalendarStarts("day", "2026-07-01", "2026-07-04")).toEqual(["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04"]);
  });

  it("day kind: a single-day range yields exactly one start", () => {
    expect(enumerateCalendarStarts("day", "2026-07-01", "2026-07-01")).toEqual(["2026-07-01"]);
  });

  it("week kind: every Monday-aligned start covering the range, including a partial leading week", () => {
    // 2026-07-01 is a Wednesday; the Monday on/before it is 2026-06-29.
    const starts = enumerateCalendarStarts("week", "2026-07-01", "2026-07-20");
    expect(starts).toEqual(["2026-06-29", "2026-07-06", "2026-07-13", "2026-07-20"]);
    for (const s of starts) {
      // every emitted start really IS a Monday (dow===1 in UTC terms via the same convention
      // document-builder.ts's mondayOnOrBefore uses).
      const dow = new Date(`${s}T00:00:00.000Z`).getUTCDay();
      expect(dow, s).toBe(1);
    }
  });

  it("month kind: every month-start covering the range, including a partial leading/trailing month", () => {
    expect(enumerateCalendarStarts("month", "2026-06-15", "2026-08-05")).toEqual(["2026-06-01", "2026-07-01", "2026-08-01"]);
  });

  it("month kind: a range wholly inside one month yields exactly that month's start", () => {
    expect(enumerateCalendarStarts("month", "2026-07-10", "2026-07-20")).toEqual(["2026-07-01"]);
  });

  it("is bounded: a 400-day 'day'-kind window (the controller's own ceiling) yields exactly 400 starts, never more", () => {
    // §6.2's MAX_CUSTOM_RANGE_DAYS ceiling — this function must never be asked to enumerate an
    // unbounded window, but pin the bound here anyway as a regression guard.
    const starts = enumerateCalendarStarts("day", "2026-01-01", "2027-02-04"); // 400 inclusive days
    expect(starts).toHaveLength(400);
    expect(starts[0]).toBe("2026-01-01");
    expect(starts[399]).toBe("2027-02-04");
  });

  it("year boundary: month enumeration crosses December -> January without skipping or duplicating", () => {
    expect(enumerateCalendarStarts("month", "2026-11-15", "2027-01-15")).toEqual(["2026-11-01", "2026-12-01", "2027-01-01"]);
  });
});
