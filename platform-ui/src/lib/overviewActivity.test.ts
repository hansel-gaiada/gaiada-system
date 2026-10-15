import { describe, it, expect } from "vitest";
import { ACTIVITY_WEEKS, activityWindowStart, buildMyActivity, todayCounts, weekStart } from "./overviewActivity";
import { addDaysIso } from "./checkins";
import type { ActivityKind, ActivitySeries } from "./activitySeriesFormat";

// 2026-10-13 is a Tuesday: its Monday is 2026-10-12.
const TODAY = "2026-10-13";

const KINDS: ActivityKind[] = [
  { key: "pm.tasks_completed", label: "Tasks completed", source: "pm" },
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
];

/** A zero-filled series from `from` to `to`, with `over` on chosen days. */
const series = (from: string, to: string, over: Record<string, Record<string, number>> = {}, kinds = KINDS): ActivitySeries => {
  const days: ActivitySeries["days"] = [];
  const totals: Record<string, number> = {};
  for (let d = from; d <= to; d = addDaysIso(d, 1)) {
    const counts = over[d] ?? {};
    days.push({ date: d, counts });
    for (const [k, n] of Object.entries(counts)) totals[k] = (totals[k] ?? 0) + n;
  }
  return { userId: "u-1", from, to, timezone: "Asia/Makassar", kinds, days, totals };
};
const fmt = (iso: string) => `<${iso}>`;

describe("the 16-week window", () => {
  it("starts on the Monday 16 whole weeks before this week's", () => {
    expect(ACTIVITY_WEEKS).toBe(16);
    expect(weekStart(TODAY)).toBe("2026-10-12");
    expect(weekStart("2026-10-11")).toBe("2026-10-05"); // a Sunday belongs to the week before it
    expect(activityWindowStart(TODAY)).toBe("2026-06-22");
  });

  it("keeps 16 full weeks plus the current week up to the server's today, and drops the days before", () => {
    const m = buildMyActivity(series("2026-06-15", TODAY), fmt);
    const days = m.cells.filter((c) => c !== null);
    expect(days[0]?.date).toBe("2026-06-22");
    expect(days[days.length - 1]?.date).toBe(TODAY);
    expect(days).toHaveLength(16 * 7 + 2); // the current week holds Monday and Tuesday
    expect(m.weekCount).toBe(17);
    expect(m.from).toBe("2026-06-22");
    expect(m.to).toBe(TODAY);
    expect(m.today).toBe(TODAY);
  });

  it("ends on the SERVER's `to`, whatever day this machine thinks it is", () => {
    const m = buildMyActivity(series("2026-06-15", "2026-10-14"), fmt);
    expect(m.today).toBe("2026-10-14");
    expect(m.to).toBe("2026-10-14");
    expect(m.from).toBe("2026-06-22"); // the Monday 16 weeks before the week of the 14th
  });

  it("works from a full default year (365 days), as the server answers it", () => {
    const m = buildMyActivity(series(addDaysIso(TODAY, -364), TODAY), fmt);
    expect(m.cells.filter((c) => c !== null)).toHaveLength(16 * 7 + 2);
    expect(m.from).toBe("2026-06-22");
  });

  it("pads the first column to its weekday row, Monday first", () => {
    // A short series starting on a Wednesday: two blanks, then the days.
    const m = buildMyActivity(series("2026-10-07", TODAY), fmt);
    expect(m.cells.slice(0, 3).map((c) => c?.date ?? null)).toEqual([null, null, "2026-10-07"]);
    expect(m.weekCount).toBe(2);
  });

  it("says nothing about today when the series holds no day in the window", () => {
    const m = buildMyActivity({ ...series("2026-06-15", TODAY), days: [] }, fmt);
    expect(m).toEqual({ cells: [], weekCount: 0, from: null, to: null, today: null, counts: [] });
  });
});

describe("the cells", () => {
  it("shades a day against the busiest day in the window, and a quiet day is level 0", () => {
    const m = buildMyActivity(series("2026-06-15", TODAY, {
      "2026-09-01": { "github.commits": 8 }, "2026-09-02": { "github.commits": 5 }, "2026-09-03": { "github.commits": 3 }, "2026-09-04": { "github.commits": 1 },
    }), fmt);
    const level = (date: string) => m.cells.find((c) => c?.date === date)?.level;
    expect(level("2026-09-01")).toBe(4);
    expect(level("2026-09-02")).toBe(3);
    expect(level("2026-09-03")).toBe(2);
    expect(level("2026-09-04")).toBe(1);
    expect(level("2026-09-05")).toBe(0);
  });

  it("sums ALL kinds of a day for its shade, and words it as things done with the kinds named by the server's labels", () => {
    const m = buildMyActivity(series("2026-06-15", TODAY, { "2026-09-01": { "github.commits": 2, "webdesk.edits": 1 }, "2026-09-02": { "pm.tasks_completed": 1 } }), fmt);
    const label = (date: string) => m.cells.find((c) => c?.date === date)?.label;
    expect(label("2026-09-01")).toBe("<2026-09-01>: 3 things done. Commits 2, Site edits 1");
    expect(label("2026-09-02")).toBe("<2026-09-02>: 1 thing done. Tasks completed 1");
    expect(label("2026-09-03")).toBe("<2026-09-03>: nothing recorded");
  });

  it("shades against the window's own busiest day, not a busier day before it", () => {
    const m = buildMyActivity(series("2026-06-15", TODAY, { "2026-06-16": { "github.commits": 100 }, "2026-09-01": { "github.commits": 2 } }), fmt);
    expect(m.cells.find((c) => c?.date === "2026-09-01")?.level).toBe(4);
  });
});

describe("today so far", () => {
  it("counts by the server's kinds, in the server's order, and drops the kinds at zero", () => {
    const counts = todayCounts({ date: TODAY, counts: { "webdesk.edits": 1, "pm.tasks_completed": 2 } }, KINDS);
    expect(counts.map((c) => [c.label, c.value])).toEqual([["Tasks completed", 2], ["Site edits", 1]]);
  });

  it("follows whatever kinds the server lists: nothing here is a fixed list", () => {
    const kinds = [{ key: "seo.briefs", label: "Content briefs", source: "seo" }];
    expect(todayCounts({ date: TODAY, counts: { "seo.briefs": 2 } }, kinds).map((c) => c.label)).toEqual(["Content briefs"]);
  });

  it("is empty for a day with nothing, and for no day at all", () => {
    expect(todayCounts({ date: TODAY, counts: {} }, KINDS)).toEqual([]);
    expect(todayCounts(null, KINDS)).toEqual([]);
  });

  it("reads today's counts from the series' own `to`, not from the last day by position", () => {
    const m = buildMyActivity(series("2026-06-15", TODAY, { [TODAY]: { "github.commits": 2 }, "2026-10-12": { "pm.tasks_completed": 9 } }), fmt);
    expect(m.counts.map((c) => [c.label, c.value])).toEqual([["Commits", 2]]);
  });
});
