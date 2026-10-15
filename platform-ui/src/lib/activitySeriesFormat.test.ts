import { describe, it, expect } from "vitest";
import {
  buildYearMap, countsByKind, countsPhrase, dayLabel, dayVolume, doneWords, groupDayItems, kindsLegend, safeLink, timeOfItem,
  type ActivityDayCounts, type ActivityDayItem, type ActivityKind,
} from "./activitySeriesFormat";

const KINDS: ActivityKind[] = [
  { key: "pm.tasks_completed", label: "Tasks completed", source: "pm" },
  { key: "github.commits", label: "Commits", source: "github" },
  { key: "webdesk.edits", label: "Site edits", source: "webdesk" },
  { key: "seo.briefs", label: "Content briefs", source: "seo" },
];
const fmt = (iso: string) => `<${iso}>`;
const day = (date: string, counts: Record<string, number> = {}): ActivityDayCounts => ({ date, counts });

describe("volume and words", () => {
  it("a day's volume is the sum of its counts, and 0 for a quiet day", () => {
    expect(dayVolume({ "github.commits": 2, "webdesk.edits": 1 })).toBe(3);
    expect(dayVolume({})).toBe(0);
  });

  it("words a volume as things done, in the singular too, never as a rating", () => {
    expect(doneWords(5)).toBe("5 things done");
    expect(doneWords(1)).toBe("1 thing done");
  });
});

describe("counts by kind", () => {
  it("follows the SERVER's kind order, not the order of the counts, and drops zero kinds", () => {
    const rows = countsByKind({ "webdesk.edits": 1, "github.commits": 2, "seo.briefs": 0 }, KINDS);
    expect(rows).toEqual([{ key: "github.commits", label: "Commits", n: 2 }, { key: "webdesk.edits", label: "Site edits", n: 1 }]);
  });

  it("names a kind the list does not know by its key instead of dropping its count", () => {
    expect(countsByKind({ "future.kind": 3 }, KINDS)).toEqual([{ key: "future.kind", label: "future.kind", n: 3 }]);
  });

  it("words the counts with the server's labels and never pluralises them", () => {
    expect(countsPhrase({ "github.commits": 2, "webdesk.edits": 1 }, KINDS)).toBe("Commits 2, Site edits 1");
    expect(countsPhrase({}, KINDS)).toBe("");
  });
});

describe("the tooltip of a day", () => {
  it("says the volume then the counts by kind", () => {
    expect(dayLabel(day("2026-10-14", { "github.commits": 2, "webdesk.edits": 1 }), KINDS, fmt)).toBe("<2026-10-14>: 3 things done. Commits 2, Site edits 1");
  });

  it("says nothing recorded on a quiet day, never 0 things", () => {
    expect(dayLabel(day("2026-10-14"), KINDS, fmt)).toBe("<2026-10-14>: nothing recorded");
  });
});

describe("the year map", () => {
  const days = [
    day("2026-10-12", { "github.commits": 8 }), // a Monday
    day("2026-10-13", { "github.commits": 5 }),
    day("2026-10-14", { "github.commits": 3 }),
    day("2026-10-15", { "github.commits": 1 }),
    day("2026-10-16"),
  ];

  it("shades each day against the busiest day, and a quiet day is level 0", () => {
    const m = buildYearMap(days, KINDS, fmt);
    const level = (d: string) => m.cells.find((c) => c?.date === d)?.level;
    expect([level("2026-10-12"), level("2026-10-13"), level("2026-10-14"), level("2026-10-15"), level("2026-10-16")]).toEqual([4, 3, 2, 1, 0]);
  });

  it("pads the first column to its weekday row, Monday first, and counts the weeks", () => {
    const m = buildYearMap(days.slice(2), KINDS, fmt); // starts on a Wednesday
    expect(m.cells.slice(0, 3).map((c) => c?.date ?? null)).toEqual([null, null, "2026-10-14"]);
    expect(m.weekCount).toBe(1);
    expect(m.from).toBe("2026-10-14");
    expect(m.to).toBe("2026-10-16");
  });

  it("counts the days with anything recorded, out of the days drawn", () => {
    const m = buildYearMap(days, KINDS, fmt);
    expect(m.activeDays).toBe(4);
    expect(m.dayCount).toBe(5);
  });

  it("gives every cell a label with its date, its volume and its kinds", () => {
    const m = buildYearMap(days, KINDS, fmt);
    expect(m.cells.find((c) => c?.date === "2026-10-13")?.label).toBe("<2026-10-13>: 5 things done. Commits 5");
  });

  it("sorts an unsorted series and says nothing for an empty one", () => {
    expect(buildYearMap([days[1], days[0]], KINDS, fmt).from).toBe("2026-10-12");
    expect(buildYearMap([], KINDS, fmt)).toEqual({ cells: [], weekCount: 0, from: null, to: null, activeDays: 0, dayCount: 0 });
  });

  it("has no score, no total and no rating anywhere in what it draws", () => {
    const m = buildYearMap(days, KINDS, fmt);
    const text = JSON.stringify(m);
    expect(text).not.toMatch(/score|rating|points|"total"/i);
  });
});

describe("the kinds legend", () => {
  it("lists every kind the server lists, with its count, zero included, and nothing the server did not list", () => {
    const legend = kindsLegend({ kinds: KINDS, totals: { "github.commits": 7 } });
    expect(legend.map((k) => [k.key, k.n])).toEqual([["pm.tasks_completed", 0], ["github.commits", 7], ["webdesk.edits", 0], ["seo.briefs", 0]]);
  });

  it("follows a different list when the company has other modules on (never a fixed list)", () => {
    const legend = kindsLegend({ kinds: [{ key: "x.y", label: "Whatever", source: "x" }], totals: { "x.y": 2 } });
    expect(legend).toEqual([{ key: "x.y", label: "Whatever", n: 2 }]);
  });
});

describe("a day's items by kind", () => {
  const items: ActivityDayItem[] = [
    { kind: "webdesk.edits", title: "Edited: Home page", at: "2026-10-14T10:00:00.000Z" },
    { kind: "github.commits", title: "Fix header", at: "2026-10-14T09:00:00.000Z" },
    { kind: "github.commits", title: "Add sitemap", at: "2026-10-14T08:00:00.000Z" },
  ];

  it("groups in the server's kind order, keeps the item order inside a group and leaves out empty kinds", () => {
    const groups = groupDayItems(items, KINDS);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.title)])).toEqual([
      ["Commits", ["Fix header", "Add sitemap"]],
      ["Site edits", ["Edited: Home page"]],
    ]);
  });

  it("keeps an item of a kind the list does not know, named by its key", () => {
    const groups = groupDayItems([{ kind: "future.kind", title: "Thing", at: "2026-10-14T09:00:00.000Z" }], KINDS);
    expect(groups.map((g) => g.label)).toEqual(["future.kind"]);
  });

  it("gives no groups for no items", () => {
    expect(groupDayItems([], KINDS)).toEqual([]);
  });
});

describe("a time and a link", () => {
  it("shows an item's time in the series' own zone, so the hour and the day agree", () => {
    expect(timeOfItem("2026-10-14T23:30:00.000Z", "UTC")).toBe("23:30");
    expect(timeOfItem("2026-10-14T23:30:00.000Z", "Asia/Makassar")).toBe("07:30");
  });

  it("falls back to UTC for a zone it does not know, and to nothing for a bad time", () => {
    expect(timeOfItem("2026-10-14T09:05:00.000Z", "Not/AZone")).toBe("09:05");
    expect(timeOfItem("nope", "UTC")).toBe("");
  });

  it("only follows a path on this site", () => {
    expect(safeLink("/tasks/t-1")).toBe("/tasks/t-1");
    expect(safeLink("https://elsewhere.example/x")).toBeNull();
    expect(safeLink("//elsewhere.example/x")).toBeNull();
    expect(safeLink(undefined)).toBeNull();
  });
});
