// Working-day arithmetic. Pure — no database, no Cerbos, no clock — so this file runs everywhere.
import { describe, it, expect } from "vitest";
import {
  addDays, chargeableLeaveDays, completedMonths, countWorkingDays, daysToMinutes,
  eachDay, isoDayOfWeek, parseIsoDate, serviceYears, type WorkingCalendar,
} from "./working-days";

describe("date primitives", () => {
  it("rejects a non-date string rather than coercing it", () => {
    expect(() => parseIsoDate("2026-8-1")).toThrow(/YYYY-MM-DD/);
    expect(() => parseIsoDate("tomorrow")).toThrow();
  });

  it("rejects a date that looks well-formed but is not on the calendar", () => {
    // Date.UTC happily rolls 31 February into March. Silently shifting a leave request by a few
    // days is far worse than refusing it, so the round-trip check is load-bearing.
    expect(() => parseIsoDate("2026-02-31")).toThrow(/not a real calendar date/);
    expect(() => parseIsoDate("2026-13-01")).toThrow();
  });

  it("accepts a real leap day and rejects a fake one", () => {
    expect(() => parseIsoDate("2024-02-29")).not.toThrow();  // 2024 is a leap year
    expect(() => parseIsoDate("2026-02-29")).toThrow();      // 2026 is not
  });

  it("gives ISO weekday numbers, Monday = 1 through Sunday = 7", () => {
    expect(isoDayOfWeek("2026-08-24")).toBe(1); // a Monday
    expect(isoDayOfWeek("2026-08-29")).toBe(6); // Saturday
    expect(isoDayOfWeek("2026-08-30")).toBe(7); // Sunday
  });

  it("crosses month and year boundaries without drifting", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("enumerates an inclusive range, and returns nothing for an inverted one", () => {
    expect(eachDay("2026-08-24", "2026-08-26")).toEqual(["2026-08-24", "2026-08-25", "2026-08-26"]);
    expect(eachDay("2026-08-24", "2026-08-24")).toEqual(["2026-08-24"]);
    expect(eachDay("2026-08-26", "2026-08-24")).toEqual([]);
  });
});

describe("countWorkingDays", () => {
  it("excludes the weekend from a full calendar week", () => {
    // Mon 2026-08-24 .. Sun 2026-08-30
    const c = countWorkingDays("2026-08-24", "2026-08-30");
    expect(c.calendarDays).toBe(7);
    expect(c.workingDays).toBe(5);
    expect(c.weekendDays).toBe(2);
  });

  it("the buckets always sum to the calendar days — a holiday on a weekend is counted ONCE", () => {
    // 2026-08-29 is a Saturday. A public holiday declared on it must not be counted as both a
    // weekend day and a holiday day, or every consumer that sums the buckets over-counts.
    const calendar: WorkingCalendar = { holidays: [{ day: "2026-08-29", kind: "public" }] };
    const c = countWorkingDays("2026-08-24", "2026-08-30", calendar);
    expect(c.weekendDays + c.workingDays + c.holidayDays).toBe(c.calendarDays);
    expect(c.holidayDays).toBe(0);   // it fell on a weekend, so it is a weekend day
    expect(c.workingDays).toBe(5);
  });

  it("a public holiday on a weekday removes a working day", () => {
    const calendar: WorkingCalendar = { holidays: [{ day: "2026-08-26", kind: "public" }] };
    const c = countWorkingDays("2026-08-24", "2026-08-28", calendar);
    expect(c.workingDays).toBe(4);
    expect(c.holidayDays).toBe(1);
    expect(c.chargeableDays).toBe(4);
  });

  it("cuti bersama is NOT worked but IS charged — the two facts are reported separately", () => {
    // The distinction that makes joint_leave its own kind. An Indonesian bridging day is a day off
    // that still comes out of the annual entitlement, so it must lower workingDays AND keep
    // chargeableDays where it was.
    const calendar: WorkingCalendar = {
      holidays: [{ day: "2026-08-26", kind: "joint_leave", deductsEntitlement: true }],
    };
    const c = countWorkingDays("2026-08-24", "2026-08-28", calendar);
    expect(c.workingDays).toBe(4);
    expect(c.jointLeaveChargedDays).toBe(1);
    expect(c.chargeableDays).toBe(5);
  });

  it("a joint-leave day that does NOT deduct behaves like an ordinary holiday", () => {
    const calendar: WorkingCalendar = {
      holidays: [{ day: "2026-08-26", kind: "joint_leave", deductsEntitlement: false }],
    };
    expect(countWorkingDays("2026-08-24", "2026-08-28", calendar).chargeableDays).toBe(4);
  });

  it("honours a non-standard working week", () => {
    // A Friday/Saturday weekend, which is normal in parts of the region.
    const c = countWorkingDays("2026-08-24", "2026-08-30", { weekendDays: [5, 6] });
    expect(c.workingDays).toBe(5);
    expect(c.weekendDays).toBe(2);
  });

  it("a six-day working week leaves only Sunday off", () => {
    expect(countWorkingDays("2026-08-24", "2026-08-30", { weekendDays: [7] }).workingDays).toBe(6);
  });
});

describe("chargeableLeaveDays", () => {
  const calendar: WorkingCalendar = { holidays: [{ day: "2026-08-26", kind: "public" }] };

  it("excludes holidays when the policy says to", () => {
    expect(chargeableLeaveDays("2026-08-24", "2026-08-30", calendar, { excludesHolidays: true })).toBe(4);
  });

  it("counts CALENDAR days when the policy does not — the unpaid-leave case", () => {
    // Unpaid leave is often counted in calendar days: you are away, the employer is not paying, and
    // the weekend does not make you present.
    expect(chargeableLeaveDays("2026-08-24", "2026-08-30", calendar, { excludesHolidays: false })).toBe(7);
  });

  it("defaults to excluding holidays when the flag is absent", () => {
    expect(chargeableLeaveDays("2026-08-24", "2026-08-30", calendar)).toBe(4);
  });
});

describe("daysToMinutes", () => {
  it("uses a 480-minute day by default", () => {
    expect(daysToMinutes(1)).toBe(480);
    expect(daysToMinutes(12)).toBe(5760);   // the Indonesian statutory annual entitlement
    expect(daysToMinutes(0.5)).toBe(240);
  });

  it("honours a shorter day, so a part-timer is not over-charged for the same absence", () => {
    expect(daysToMinutes(1, 240)).toBe(240);
  });
});

describe("completedMonths", () => {
  it("counts whole months only", () => {
    expect(completedMonths("2026-01-15", "2026-02-14")).toBe(0);
    expect(completedMonths("2026-01-15", "2026-02-15")).toBe(1);
    expect(completedMonths("2026-01-15", "2027-01-15")).toBe(12);
  });

  it("does not credit a month to somebody hired on the 31st on the 1st", () => {
    // The day-of-month guard. Without it, 31 January -> 1 February reads as a completed month.
    expect(completedMonths("2026-01-31", "2026-02-01")).toBe(0);
    expect(completedMonths("2026-01-31", "2026-03-31")).toBe(2);
  });

  it("returns 0 rather than a negative for an inverted range", () => {
    expect(completedMonths("2026-06-01", "2026-01-01")).toBe(0);
  });
});

describe("serviceYears", () => {
  it("is fractional, so the severance bracketing can floor it deliberately", () => {
    expect(serviceYears("2020-01-01", "2026-01-01")).toBeCloseTo(6, 1);
    expect(serviceYears("2025-07-01", "2026-01-01")).toBeCloseTo(0.5, 1);
  });

  it("never returns a negative", () => {
    expect(serviceYears("2026-01-01", "2020-01-01")).toBe(0);
  });

  it("stays just under the next whole year the day before an anniversary", () => {
    // This is the property the severance table depends on: 364 days of service must NOT bracket as
    // one completed year, because that bracket is worth a month of wage.
    expect(Math.floor(serviceYears("2025-01-01", "2025-12-31"))).toBe(0);
    expect(Math.floor(serviceYears("2025-01-01", "2026-01-01"))).toBe(1);
  });
});
