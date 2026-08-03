import { describe, it, expect } from "vitest";
import {
  addDays, counts, dayNumber, endOfMonth, groupByDate, isOverdue, monthGrid, parseAnchor,
  parseView, rangeLabel, sameMonth, shiftAnchor, startOfMonth, startOfWeek, weekDays, weekdayIndex,
  type CalItem,
} from "./calendar";

const item = (date: string, id = date): CalItem => ({ id, title: `t-${id}`, status: "todo", date, href: `/tasks/${id}` });

describe("parseView / parseAnchor", () => {
  it("defaults to month and rejects an unknown view", () => {
    expect(parseView(undefined)).toBe("month");
    expect(parseView("gantt")).toBe("month");
    expect(parseView("week")).toBe("week");
  });

  it("falls back to today for a malformed or absent anchor", () => {
    // A hand-edited URL must degrade to the default, never render an Invalid Date grid.
    expect(parseAnchor(undefined, "2026-08-03")).toBe("2026-08-03");
    expect(parseAnchor("not-a-date", "2026-08-03")).toBe("2026-08-03");
    expect(parseAnchor("2026-02-30", "2026-08-03")).toBe("2026-08-03"); // Date.parse rejects it
    expect(parseAnchor("2026-12-25", "2026-08-03")).toBe("2026-12-25");
  });
});

describe("week maths", () => {
  it("treats Monday as the first day of the week", () => {
    expect(weekdayIndex("2026-08-03")).toBe(0); // Monday
    expect(weekdayIndex("2026-08-09")).toBe(6); // Sunday
    expect(startOfWeek("2026-08-09")).toBe("2026-08-03");
    expect(startOfWeek("2026-08-03")).toBe("2026-08-03");
  });

  it("returns seven consecutive days", () => {
    expect(weekDays("2026-08-06")).toEqual([
      "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08", "2026-08-09",
    ]);
  });
});

describe("month boundaries", () => {
  it("finds the last day without a per-month length table", () => {
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(endOfMonth("2024-02-10")).toBe("2024-02-29"); // leap year
    expect(endOfMonth("2026-12-01")).toBe("2026-12-31");
    expect(startOfMonth("2026-08-31")).toBe("2026-08-01");
  });

  it("builds whole Monday-start weeks that cover the month", () => {
    const weeks = monthGrid("2026-08-15");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // August 2026 starts on a Saturday, so the first row begins in July.
    expect(weeks[0][0]).toBe("2026-07-27");
    expect(weeks.at(-1)!.at(-1)!).toBe("2026-09-06");
    const flat = weeks.flat();
    expect(flat).toContain("2026-08-01");
    expect(flat).toContain("2026-08-31");
    // No gaps or repeats anywhere in the grid.
    expect(new Set(flat).size).toBe(flat.length);
    for (let i = 1; i < flat.length; i++) expect(flat[i]).toBe(addDays(flat[i - 1], 1));
  });

  it("covers a month that starts exactly on a Monday without a blank leading row", () => {
    const weeks = monthGrid("2026-06-10"); // 1 June 2026 is a Monday
    expect(weeks[0][0]).toBe("2026-06-01");
  });

  it("marks which cells belong to the anchor month", () => {
    expect(sameMonth("2026-07-31", "2026-08-01")).toBe(false);
    expect(sameMonth("2026-08-31", "2026-08-01")).toBe(true);
    expect(dayNumber("2026-08-09")).toBe(9);
  });
});

describe("shiftAnchor", () => {
  it("steps a day and a week", () => {
    expect(shiftAnchor("2026-08-03", "day", 1)).toBe("2026-08-04");
    expect(shiftAnchor("2026-08-03", "week", -1)).toBe("2026-07-27");
  });

  it("steps by calendar month and clamps a short target month", () => {
    // 31 Jan + 1 month must be 28 Feb, not 3 March — the bug you get from adding 30 days.
    expect(shiftAnchor("2026-01-31", "month", 1)).toBe("2026-02-28");
    expect(shiftAnchor("2024-01-31", "month", 1)).toBe("2024-02-29");
    expect(shiftAnchor("2026-03-15", "month", -1)).toBe("2026-02-15");
  });

  it("crosses a year boundary in both directions", () => {
    expect(shiftAnchor("2026-12-15", "month", 1)).toBe("2027-01-15");
    expect(shiftAnchor("2026-01-15", "month", -1)).toBe("2025-12-15");
  });
});

describe("rangeLabel", () => {
  it("labels each view, spanning months and years where needed", () => {
    expect(rangeLabel("2026-08-15", "month")).toBe("August 2026");
    expect(rangeLabel("2026-08-03", "day")).toBe("Monday 3 August 2026");
    expect(rangeLabel("2026-08-05", "week")).toBe("3 – 9 August 2026");
    expect(rangeLabel("2026-09-02", "week")).toBe("31 August – 6 September 2026");
    expect(rangeLabel("2026-12-31", "week")).toBe("28 December 2026 – 3 January 2027");
  });
});

describe("groupByDate", () => {
  it("keys items by due date, preserving multiples on one day", () => {
    const g = groupByDate([item("2026-08-03", "a"), item("2026-08-03", "b"), item("2026-08-04", "c")]);
    expect(g.get("2026-08-03")!.map((i) => i.id)).toEqual(["a", "b"]);
    expect(g.get("2026-08-04")!).toHaveLength(1);
    expect(g.has("2026-08-05")).toBe(false);
  });
});

describe("counts", () => {
  it("never double-counts a task across the three figures", () => {
    const c = counts(
      [item("2026-08-01"), item("2026-08-02"), item("2026-08-03"), item("2026-08-06"), item("2026-08-20")],
      "2026-08-03",
    );
    expect(c).toEqual({ total: 5, overdue: 2, today: 1, thisWeek: 2 });
    // overdue + thisWeek + later == total, with today included inside thisWeek exactly once.
    expect(c.overdue + c.thisWeek + 1).toBe(c.total);
  });

  it("treats the 7th day ahead as beyond this week", () => {
    expect(counts([item("2026-08-09")], "2026-08-03").thisWeek).toBe(1); // day 6
    expect(counts([item("2026-08-10")], "2026-08-03").thisWeek).toBe(0); // day 7
  });

  it("flags overdue by date only", () => {
    expect(isOverdue("2026-08-02", "2026-08-03")).toBe(true);
    expect(isOverdue("2026-08-03", "2026-08-03")).toBe(false);
  });
});
