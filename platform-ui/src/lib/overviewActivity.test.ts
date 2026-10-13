import { describe, it, expect } from "vitest";
import { ACTIVITY_WEEKS, activityRequestFrom, activityWindowStart, buildMyActivity, todayCounts, weekStart } from "./overviewActivity";
import { addDaysIso } from "./checkins";
import type { ProductivityDayPoint, ProductivityReport } from "./pm";

// 2026-10-13 is a Tuesday: its Monday is 2026-10-12.
const TODAY = "2026-10-13";

const point = (date: string, over: Partial<ProductivityDayPoint> = {}): ProductivityDayPoint => ({
  date, completedTasks: 0, assignedCompleted: 0, involvedCompleted: 0, tasksAccepted: 0,
  reactionsGiven: 0, reactionsReceived: 0, notesContributions: 0, comments: 0, total: 0, ...over,
});
/** A zero-filled series from `from` to `to`, with `over` on chosen days. */
const series = (from: string, to: string, over: Record<string, Partial<ProductivityDayPoint>> = {}) => {
  const out: ProductivityDayPoint[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(point(d, over[d]));
  return out;
};
const report = (s: ProductivityDayPoint[], extra: Partial<ProductivityReport> = {}): ProductivityReport => ({
  userId: "u-1", from: s[0]?.date ?? TODAY, to: s[s.length - 1]?.date ?? TODAY, days: s.length, series: s,
  totals: point("x"), score: null, scoreNote: "", ...extra,
});
const fmt = (iso: string) => `<${iso}>`;

describe("the 16-week window", () => {
  it("starts on the Monday 16 whole weeks before this week's, and asks for a week earlier", () => {
    expect(ACTIVITY_WEEKS).toBe(16);
    expect(weekStart(TODAY)).toBe("2026-10-12");
    expect(weekStart("2026-10-11")).toBe("2026-10-05"); // a Sunday belongs to the week before it
    expect(activityWindowStart(TODAY)).toBe("2026-06-22");
    expect(activityRequestFrom(TODAY)).toBe("2026-06-15");
  });

  it("keeps 16 full weeks plus the current week up to today, and drops the days before", () => {
    const m = buildMyActivity(report(series("2026-06-15", TODAY)), fmt);
    const days = m.cells.filter((c) => c !== null);
    expect(days[0]?.date).toBe("2026-06-22");
    expect(days[days.length - 1]?.date).toBe(TODAY);
    expect(days).toHaveLength(16 * 7 + 2); // the current week holds Monday and Tuesday
    expect(m.weekCount).toBe(17);
    expect(m.from).toBe("2026-06-22");
    expect(m.to).toBe(TODAY);
    expect(m.today).toBe(TODAY);
  });

  it("lets the server decide today: the series' last day is today, whatever the clock here says", () => {
    const m = buildMyActivity(report(series("2026-06-15", "2026-10-14")), fmt);
    expect(m.today).toBe("2026-10-14");
    expect(m.from).toBe("2026-06-22");
  });

  it("pads the first column to its weekday row, Monday first", () => {
    // A short series starting on a Wednesday: two blanks, then the days.
    const m = buildMyActivity(report(series("2026-10-07", TODAY)), fmt);
    expect(m.cells.slice(0, 3).map((c) => c?.date ?? null)).toEqual([null, null, "2026-10-07"]);
    expect(m.weekCount).toBe(2);
  });

  it("says nothing about today when the series holds no day", () => {
    const m = buildMyActivity(report([]), fmt);
    expect(m).toEqual({ cells: [], weekCount: 0, from: null, to: null, today: null, counts: [] });
  });
});

describe("the cells", () => {
  it("shades a day against the person's busiest day in the window, and a quiet day is level 0", () => {
    const m = buildMyActivity(report(series("2026-06-15", TODAY, {
      "2026-09-01": { total: 8 }, "2026-09-02": { total: 5 }, "2026-09-03": { total: 3 }, "2026-09-04": { total: 1 },
    })), fmt);
    const level = (date: string) => m.cells.find((c) => c?.date === date)?.level;
    expect(level("2026-09-01")).toBe(4);
    expect(level("2026-09-02")).toBe(3);
    expect(level("2026-09-03")).toBe(2);
    expect(level("2026-09-04")).toBe(1);
    expect(level("2026-09-05")).toBe(0);
  });

  it("words the tooltip as a count on a date, in the singular too, and never as a score", () => {
    const m = buildMyActivity(report(series("2026-06-15", TODAY, { "2026-09-01": { total: 3 }, "2026-09-02": { total: 1 } })), fmt);
    const title = (date: string) => m.cells.find((c) => c?.date === date)?.title;
    expect(title("2026-09-01")).toBe("3 things on <2026-09-01>");
    expect(title("2026-09-02")).toBe("1 thing on <2026-09-02>");
    expect(title("2026-09-03")).toBe("0 things on <2026-09-03>");
  });

  it("shades against the window's own busiest day, not a busier day before it", () => {
    const m = buildMyActivity(report(series("2026-06-15", TODAY, { "2026-06-16": { total: 100 }, "2026-09-01": { total: 2 } })), fmt);
    expect(m.cells.find((c) => c?.date === "2026-09-01")?.level).toBe(4);
  });
});

describe("today so far", () => {
  it("counts by kind, in a fixed order, and drops the kinds at zero", () => {
    const counts = todayCounts(point(TODAY, { comments: 4, completedTasks: 2, reactionsGiven: 1, total: 7 }));
    expect(counts.map((c) => [c.label, c.value])).toEqual([["Tasks completed", 2], ["Comments", 4], ["Reactions given", 1]]);
  });

  it("names all five kinds when each was recorded", () => {
    const counts = todayCounts(point(TODAY, { completedTasks: 1, tasksAccepted: 2, comments: 3, notesContributions: 4, reactionsGiven: 5 }));
    expect(counts.map((c) => c.label)).toEqual(["Tasks completed", "Tasks accepted", "Comments", "Notes", "Reactions given"]);
  });

  it("does not list the sub-counts or the reactions received as kinds of their own", () => {
    expect(todayCounts(point(TODAY, { assignedCompleted: 2, involvedCompleted: 2, reactionsReceived: 3, total: 7 }))).toEqual([]);
  });

  it("is empty for a day with nothing, and for no point at all", () => {
    expect(todayCounts(point(TODAY))).toEqual([]);
    expect(todayCounts(null)).toEqual([]);
  });

  it("reads today's point from the end of the series", () => {
    const m = buildMyActivity(report(series("2026-06-15", TODAY, { [TODAY]: { comments: 2, total: 2 }, "2026-10-12": { completedTasks: 9, total: 9 } })), fmt);
    expect(m.counts.map((c) => [c.label, c.value])).toEqual([["Comments", 2]]);
  });
});
