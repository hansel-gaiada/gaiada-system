// SCP-5 W5-A5 — report automation's timing, on golden tables (BFF §63.24.9's proofs: each kind and form across a month end, a holiday on
// the N-th working day, the year turn, February, the company's zone, and UTC while REPORTS_TZ is unset). Pure: no database, no clock.
import { describe, it, expect } from "vitest";
import type { WorkingCalendar } from "../../hr/working-days";
import type { PeriodicKind } from "./rules";
import { periodRange } from "./rules-periods";
import {
  dueAt, lastEndedPeriod, localDateOf, nextOccurrence, nthWorkingDayOfMonth, occurrenceFor, ordinal, parseTiming, runDayOf, timingText,
  zonedInstant, type ScheduleTiming, type TimingContext,
} from "./report-schedule-timing";

const UTC: TimingContext = { tz: "UTC", fiscalYearStartMonth: 1, calendar: {} };
const holidays = (...days: string[]): WorkingCalendar => ({ weekendDays: [6, 7], holidays: days.map((day) => ({ day, kind: "public" as const })) });
const iso = (d: Date) => d.toISOString();

describe("parseTiming: the kind's shape, or the first bad field", () => {
  const ok: Array<[PeriodicKind, unknown, ScheduleTiming]> = [
    ["daily", { at: "00:00" }, { at: "00:00" }],
    ["daily", { at: "23:59" }, { at: "23:59" }],
    ["weekly", { weekday: 1, at: "08:00" }, { weekday: 1, at: "08:00" }],
    ["weekly", { weekday: 7, at: "08:00" }, { weekday: 7, at: "08:00" }],
    ["monthly", { on: "day", day: 28, at: "08:00" }, { on: "day", day: 28, at: "08:00" }],
    ["monthly", { on: "working_day", n: 20, at: "08:00" }, { on: "working_day", n: 20, at: "08:00" }],
    ["quarterly", { on: "day", day: 1, at: "08:00" }, { on: "day", day: 1, at: "08:00" }],
    ["semester", { on: "working_day", n: 1, at: "08:00" }, { on: "working_day", n: 1, at: "08:00" }],
    ["yearly", { on: "day", day: 15, at: "06:45" }, { on: "day", day: 15, at: "06:45" }],
  ];
  for (const [kind, raw, want] of ok) {
    it(`${kind} ${JSON.stringify(raw)}`, () => expect(parseTiming(kind, raw)).toEqual({ ok: true, timing: want }));
  }
  const bad: Array<[PeriodicKind, unknown, string]> = [
    ["daily", null, "timing"],
    ["daily", "08:00", "timing"],
    ["daily", [], "timing"],
    ["daily", {}, "timing.at"],
    ["daily", { at: "24:00" }, "timing.at"],
    ["daily", { at: "8:00" }, "timing.at"],
    ["daily", { at: "08:60" }, "timing.at"],
    ["daily", { at: 800 }, "timing.at"],
    ["daily", { at: "08:00", weekday: 1 }, "timing.weekday"], // a weekly's key on a daily: wrong kind
    ["daily", { at: "08:00", colour: "red" }, "timing"], // a key no kind has
    ["weekly", { at: "08:00" }, "timing.weekday"],
    ["weekly", { weekday: 0, at: "08:00" }, "timing.weekday"],
    ["weekly", { weekday: 8, at: "08:00" }, "timing.weekday"],
    ["weekly", { weekday: 1.5, at: "08:00" }, "timing.weekday"],
    ["weekly", { weekday: "1", at: "08:00" }, "timing.weekday"],
    ["weekly", { weekday: 1, at: "08:00", day: 3 }, "timing.day"],
    ["monthly", { at: "08:00" }, "timing.on"],
    ["monthly", { on: "week", at: "08:00" }, "timing.on"],
    ["monthly", { on: "day", day: 29, at: "08:00" }, "timing.day"], // not every month has a 29th
    ["monthly", { on: "day", day: 0, at: "08:00" }, "timing.day"],
    ["monthly", { on: "day", at: "08:00" }, "timing.day"],
    ["monthly", { on: "working_day", n: 21, at: "08:00" }, "timing.n"],
    ["monthly", { on: "working_day", n: 0, at: "08:00" }, "timing.n"],
    ["monthly", { on: "working_day", day: 3, at: "08:00" }, "timing.day"], // the other form's key
    ["monthly", { on: "day", day: 3, n: 2, at: "08:00" }, "timing.n"],
    ["monthly", { on: "day", day: 3, weekday: 2, at: "08:00" }, "timing.weekday"],
    ["quarterly", { weekday: 1, at: "08:00" }, "timing.weekday"],
    ["yearly", { on: "day", day: 3 }, "timing.at"],
  ];
  for (const [kind, raw, field] of bad) {
    it(`${kind} ${JSON.stringify(raw)} -> ${field}`, () => expect(parseTiming(kind, raw)).toEqual({ ok: false, field }));
  }
});

describe("the zone: a wall time to its instant", () => {
  const table: Array<[string, string, string, string]> = [
    ["UTC", "2026-03-01", "08:00", "2026-03-01T08:00:00.000Z"],
    ["Asia/Jakarta", "2026-03-02", "08:00", "2026-03-02T01:00:00.000Z"], // UTC+7, no DST
    ["Asia/Jakarta", "2027-01-01", "00:30", "2026-12-31T17:30:00.000Z"], // the year turn in the zone
    ["Europe/Berlin", "2026-03-30", "08:00", "2026-03-30T06:00:00.000Z"], // summer time
    ["Europe/Berlin", "2026-01-15", "08:00", "2026-01-15T07:00:00.000Z"], // winter time
    ["Europe/Berlin", "2026-03-29", "02:30", "2026-03-29T01:30:00.000Z"], // the gap 02:00 -> 03:00: 03:30 CEST
    ["Europe/Berlin", "2026-10-25", "02:30", "2026-10-25T00:30:00.000Z"], // the overlap: the FIRST 02:30 (CEST)
    ["America/New_York", "2026-03-08", "02:30", "2026-03-08T07:30:00.000Z"], // the gap: 03:30 EDT
    ["America/New_York", "2026-11-01", "01:30", "2026-11-01T05:30:00.000Z"], // the overlap: 01:30 EDT, not EST
  ];
  for (const [tz, day, at, want] of table) {
    it(`${day} ${at} ${tz}`, () => expect(iso(zonedInstant(day, at, tz))).toBe(want));
  }
  it("the company day of an instant", () => {
    expect(localDateOf(new Date("2026-03-01T23:30:00Z"), "UTC")).toBe("2026-03-01");
    expect(localDateOf(new Date("2026-03-01T23:30:00Z"), "Asia/Jakarta")).toBe("2026-03-02");
    expect(localDateOf(new Date("2026-03-01T03:30:00Z"), "America/New_York")).toBe("2026-02-28");
  });
});

describe("each kind's run day and moment, on the golden table", () => {
  const T = {
    daily: { at: "08:00" },
    mondays: { weekday: 1, at: "08:00" },
    fridays: { weekday: 5, at: "17:30" },
    day5: { on: "day", day: 5, at: "09:30" },
    wd3: { on: "working_day", n: 3, at: "08:00" },
    wd20: { on: "working_day", n: 20, at: "08:00" },
    day10: { on: "day", day: 10, at: "07:00" },
    wd1: { on: "working_day", n: 1, at: "08:00" },
    day15: { on: "day", day: 15, at: "08:00" },
  } as const satisfies Record<string, ScheduleTiming>;
  const rows: Array<[string, PeriodicKind, ScheduleTiming, string, Partial<TimingContext>, string]> = [
    // daily: the day after, across a month end, February, a leap day and the year turn.
    ["daily, month end", "daily", T.daily, "2026-02-28", {}, "2026-03-01T08:00:00.000Z"],
    ["daily, leap day", "daily", T.daily, "2028-02-28", {}, "2028-02-29T08:00:00.000Z"],
    ["daily, year turn", "daily", T.daily, "2026-12-31", {}, "2027-01-01T08:00:00.000Z"],
    ["daily, a holiday changes nothing (every day)", "daily", T.daily, "2026-11-03", { calendar: holidays("2026-11-04") }, "2026-11-04T08:00:00.000Z"],
    // weekly: the weekday of the week after (the contract's example: Monday 16 November for 9 to 15 November).
    ["weekly, Monday after W46", "weekly", T.mondays, "2026-W46", {}, "2026-11-16T08:00:00.000Z"],
    ["weekly, Friday after W53 (the ISO year turn)", "weekly", T.fridays, "2026-W53", {}, "2027-01-08T17:30:00.000Z"],
    ["weekly, W01 begins in the year before", "weekly", T.mondays, "2026-W01", {}, "2026-01-05T08:00:00.000Z"],
    // monthly, day N: the month after; the year turn; February.
    ["monthly day 5, year turn", "monthly", T.day5, "2026-12", {}, "2027-01-05T09:30:00.000Z"],
    ["monthly day 5, into February", "monthly", T.day5, "2027-01", {}, "2027-02-05T09:30:00.000Z"],
    // monthly, N-th working day: November 2026 begins on a Sunday.
    ["monthly 3rd working day", "monthly", T.wd3, "2026-10", {}, "2026-11-04T08:00:00.000Z"],
    ["monthly 3rd working day, a holiday ON it", "monthly", T.wd3, "2026-10", { calendar: holidays("2026-11-04") }, "2026-11-05T08:00:00.000Z"],
    ["monthly 3rd working day, a holiday on the 1st working day", "monthly", T.wd3, "2026-10", { calendar: holidays("2026-11-02") }, "2026-11-05T08:00:00.000Z"],
    ["monthly 20th working day of February 2027 (exactly 20 weekdays)", "monthly", T.wd20, "2027-01", {}, "2027-02-26T08:00:00.000Z"],
    ["monthly 20th working day, a holiday pushes it into March", "monthly", T.wd20, "2027-01", { calendar: holidays("2027-02-15") }, "2027-03-01T08:00:00.000Z"],
    // the long kinds: the month after the period ends.
    ["quarterly day 10, the year turn", "quarterly", T.day10, "2026-Q4", {}, "2027-01-10T07:00:00.000Z"],
    ["quarterly day 10, Q1", "quarterly", T.day10, "2026-Q1", {}, "2026-04-10T07:00:00.000Z"],
    ["quarterly with an April fiscal year: Q4 is January to March", "quarterly", T.day10, "2026-Q4", { fiscalYearStartMonth: 4 }, "2027-04-10T07:00:00.000Z"],
    ["semester 1st working day, H1", "semester", T.wd1, "2026-H1", {}, "2026-07-01T08:00:00.000Z"],
    ["semester 1st working day, H2 over New Year's Day", "semester", T.wd1, "2026-H2", { calendar: holidays("2027-01-01") }, "2027-01-04T08:00:00.000Z"],
    ["yearly day 15", "yearly", T.day15, "2026", {}, "2027-01-15T08:00:00.000Z"],
    // the company's zone: the same wall time, another instant.
    ["daily in Jakarta", "daily", T.daily, "2026-03-01", { tz: "Asia/Jakarta" }, "2026-03-02T01:00:00.000Z"],
    ["monthly 3rd working day in Jakarta", "monthly", T.wd3, "2026-10", { tz: "Asia/Jakarta" }, "2026-11-04T01:00:00.000Z"],
    ["weekly in Berlin across the spring change", "weekly", { weekday: 1, at: "08:00" }, "2026-W13", { tz: "Europe/Berlin" }, "2026-03-30T06:00:00.000Z"],
  ];
  for (const [label, kind, timing, period, ctx, want] of rows) {
    it(label, () => {
      const o = occurrenceFor(kind, timing, period, { ...UTC, ...ctx });
      expect(o.period).toBe(period);
      expect(iso(o.runAt)).toBe(want);
    });
  }

  it("a run day is always after its period's last day", () => {
    for (const [label, kind, timing, period, ctx] of rows) {
      const c = { ...UTC, ...ctx };
      const day = runDayOf(kind, timing, period, c);
      expect(day > periodRange(kind, period, c.fiscalYearStartMonth)!.end, label).toBe(true);
      expect(occurrenceFor(kind, timing, period, c).runDay).toBe(day);
    }
  });

  it("the N-th working day of a month", () => {
    expect(nthWorkingDayOfMonth("2026-11", 1, {})).toBe("2026-11-02");
    expect(nthWorkingDayOfMonth("2026-11", 5, {})).toBe("2026-11-06");
    expect(nthWorkingDayOfMonth("2026-11", 6, {})).toBe("2026-11-09");
    expect(nthWorkingDayOfMonth("2026-11", 1, holidays("2026-11-02", "2026-11-03"))).toBe("2026-11-04");
  });
});

describe("nextOccurrence: the first run strictly after a moment", () => {
  it("daily: the run of the day before, until its moment passes", () => {
    const t = { at: "08:00" };
    expect(nextOccurrence("daily", t, new Date("2026-03-01T07:59:00Z"), UTC)).toMatchObject({ period: "2026-02-28", runDay: "2026-03-01" });
    expect(nextOccurrence("daily", t, new Date("2026-03-01T08:00:00Z"), UTC)).toMatchObject({ period: "2026-03-01", runDay: "2026-03-02" });
  });
  it("daily in the company's zone: Jakarta's morning is UTC's night before", () => {
    const after = new Date("2026-03-01T23:30:00Z");
    const jkt = nextOccurrence("daily", { at: "08:00" }, after, { ...UTC, tz: "Asia/Jakarta" });
    expect(jkt).toMatchObject({ period: "2026-03-01", runDay: "2026-03-02" });
    expect(iso(jkt.runAt)).toBe("2026-03-02T01:00:00.000Z");
    // UTC while REPORTS_TZ is unset: the same moment is still the 1st there.
    expect(iso(nextOccurrence("daily", { at: "08:00" }, after, UTC).runAt)).toBe("2026-03-02T08:00:00.000Z");
  });
  it("weekly: written on a Tuesday, the next Monday drafts the week that just ended", () => {
    const o = nextOccurrence("weekly", { weekday: 1, at: "08:00" }, new Date("2026-11-10T12:00:00Z"), UTC);
    expect(o).toMatchObject({ period: "2026-W46", runDay: "2026-11-16" });
  });
  it("monthly working day: written on the 1st, before the 3rd working day, drafts the month before", () => {
    const o = nextOccurrence("monthly", { on: "working_day", n: 3, at: "08:00" }, new Date("2026-11-01T00:00:00Z"), UTC);
    expect(o).toMatchObject({ period: "2026-10", runDay: "2026-11-04" });
    const later = nextOccurrence("monthly", { on: "working_day", n: 3, at: "08:00" }, new Date("2026-11-04T08:00:00Z"), UTC);
    expect(later).toMatchObject({ period: "2026-11", runDay: "2026-12-03" });
  });
  it("yearly: written mid-year waits for next January", () => {
    expect(nextOccurrence("yearly", { on: "day", day: 15, at: "08:00" }, new Date("2026-06-01T00:00:00Z"), UTC)).toMatchObject({ period: "2026", runDay: "2027-01-15" });
    expect(nextOccurrence("yearly", { on: "day", day: 15, at: "08:00" }, new Date("2027-01-10T00:00:00Z"), UTC)).toMatchObject({ period: "2026", runDay: "2027-01-15" });
  });
  it("quarterly and semester across their turns", () => {
    expect(nextOccurrence("quarterly", { on: "day", day: 10, at: "07:00" }, new Date("2026-12-20T00:00:00Z"), UTC)).toMatchObject({ period: "2026-Q4", runDay: "2027-01-10" });
    expect(nextOccurrence("semester", { on: "working_day", n: 1, at: "08:00" }, new Date("2026-07-01T08:00:00Z"), UTC)).toMatchObject({ period: "2026-H2", runDay: "2027-01-01" });
  });
});

describe("dueAt: the job's question, with the catch-up and the moved holiday", () => {
  const mondays: ScheduleTiming = { weekday: 1, at: "08:00" };
  it("not yet due: the stored period's moment is still ahead", () => {
    const a = dueAt("weekly", mondays, "2026-W43", new Date("2026-10-26T07:00:00Z"), UTC);
    expect(a).toMatchObject({ due: false, next: { period: "2026-W43", runDay: "2026-10-26" } });
  });
  it("on time: drafts the stored period, nothing missed, and the next is the week after", () => {
    const a = dueAt("weekly", mondays, "2026-W43", new Date("2026-10-26T08:00:30Z"), UTC);
    expect(a).toMatchObject({ due: true, period: "2026-W43", missed: 0, next: { period: "2026-W44", runDay: "2026-11-02" } });
  });
  it("an outage of three periods drafts only the latest, once, with missed: 2", () => {
    const a = dueAt("weekly", mondays, "2026-W41", new Date("2026-10-27T09:00:00Z"), UTC);
    expect(a).toMatchObject({ due: true, period: "2026-W43", missed: 2, next: { period: "2026-W44" } });
  });
  it("a daily behind by a month still drafts one day", () => {
    const a = dueAt("daily", { at: "08:00" }, "2026-09-01", new Date("2026-10-02T09:00:00Z"), UTC);
    expect(a).toMatchObject({ due: true, period: "2026-10-01", missed: 30, next: { period: "2026-10-02" } });
  });
  it("a holiday added on the stored day moves a working-day schedule instead of running on the old day", () => {
    // Stored when the 4th was the 3rd working day; then the 4th became a holiday. At 09:00 on the 4th nothing is due.
    const a = dueAt("monthly", { on: "working_day", n: 3, at: "08:00" }, "2026-10", new Date("2026-11-04T09:00:00Z"), { ...UTC, calendar: holidays("2026-11-04") });
    expect(a).toMatchObject({ due: false, next: { period: "2026-10", runDay: "2026-11-05" } });
  });
});

describe("Run now and the words", () => {
  it("the period that ended last before today", () => {
    const today = "2026-10-30"; // a Friday in W44
    const want: Record<PeriodicKind, string> = {
      daily: "2026-10-29", weekly: "2026-W43", monthly: "2026-09", quarterly: "2026-Q3", semester: "2026-H1", yearly: "2025",
    };
    for (const kind of Object.keys(want) as PeriodicKind[]) expect(lastEndedPeriod(kind, today), kind).toBe(want[kind]);
    expect(lastEndedPeriod("weekly", "2027-01-04")).toBe("2026-W53");
    expect(lastEndedPeriod("daily", "2028-03-01")).toBe("2028-02-29");
    expect(lastEndedPeriod("quarterly", "2027-02-01", 4)).toBe("2026-Q3"); // April fiscal year: Q3 is October to December
  });
  it("the timing in words", () => {
    expect(timingText("daily", { at: "07:00" })).toBe("Every day at 07:00, for the day before");
    expect(timingText("weekly", { weekday: 1, at: "08:00" })).toBe("Every Monday at 08:00, for the week before");
    expect(timingText("weekly", { weekday: 7, at: "08:00" })).toBe("Every Sunday at 08:00, for the week before");
    expect(timingText("monthly", { on: "day", day: 5, at: "09:30" })).toBe("On day 5 of each month at 09:30, for the month before");
    expect(timingText("monthly", { on: "working_day", n: 3, at: "08:00" })).toBe("On the 3rd working day of each month at 08:00, for the month before");
    expect(timingText("quarterly", { on: "day", day: 10, at: "07:00" })).toBe("On day 10 of the month after each quarter at 07:00, for the quarter that ended");
    expect(timingText("semester", { on: "working_day", n: 1, at: "08:00" })).toBe("On the 1st working day of the month after each half year at 08:00, for the half year that ended");
    expect(timingText("yearly", { on: "working_day", n: 12, at: "08:00" })).toBe("On the 12th working day of the month after each year at 08:00, for the year that ended");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
  });
});
