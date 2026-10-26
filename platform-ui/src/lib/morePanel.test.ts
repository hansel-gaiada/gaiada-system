import { describe, it, expect } from "vitest";
import { countResults, exactResult, filterMore, moreCountOf, resultHref, resultLabel, resultsAnnouncement, rowSubline, type MoreGroup } from "./morePanel";
import type { ConcreteRow } from "./workspaceAccess";

// SCP-Kd: the More panel's pure rules.

const tab = (key: string, label: string, href = `/${key}`) => ({ key, label, href, icon: "home" as const });
const row = (key: string, label: string, tabs: ReturnType<typeof tab>[], count?: number): ConcreteRow => ({ key, label, icon: "home", tabs, ...(count ? { count } : {}) });

const pm = row("pm", "Project Management", [tab("projects", "Projects"), tab("board", "Board"), tab("timeline", "Timeline")]);
const tasks = row("tasks", "My tasks", [tab("tasks", "My tasks", "/me/tasks")]);
const inbox = row("inbox", "Inbox", [tab("inbox", "Notifications", "/me/inbox"), tab("mail", "Mail", "/me/mail")], 4);
const groups: MoreGroup[] = [
  { key: "work", label: "Work", rows: [pm] },
  { key: "you", label: "You", rows: [tasks, inbox] },
];

describe("rowSubline", () => {
  it("lists the tab labels of a row that holds several pages, and nothing for a row with one", () => {
    expect(rowSubline(pm)).toBe("Projects, Board, Timeline");
    expect(rowSubline(tasks)).toBeNull();
  });
});

describe("filterMore", () => {
  it("with no query gives every row of every group in order, and no tab results", () => {
    const s = filterMore(groups, "  ");
    expect(s.map((x) => [x.label, x.results.map((r) => [r.kind, r.row.key])])).toEqual([
      ["Work", [["row", "pm"]]],
      ["You", [["row", "tasks"], ["row", "inbox"]]],
    ]);
  });

  it("matches a row's label, case-insensitively, and drops sections with nothing", () => {
    const s = filterMore(groups, "MY TASKS");
    expect(s.map((x) => x.key)).toEqual(["you"]);
    expect(s[0].results.map(resultLabel)).toEqual(["My tasks"]);
  });

  it("gives a matching tab its own result linking to that tab, after its row when the row matches too", () => {
    const s = filterMore(groups, "board");
    expect(s[0].results).toEqual([{ kind: "tab", row: pm, tab: pm.tabs[1] }]);
    expect(resultHref(s[0].results[0])).toBe("/board");
    const both = filterMore([{ key: "work", label: "Work", rows: [row("calendar", "Calendar", [tab("calendar", "Calendar", "/c"), tab("meetings", "Meetings", "/m")])] }], "c");
    // "Calendar" matches by row; the first tab has the same page, so it is not repeated; "Meetings" has no c.
    expect(both[0].results.map((r) => r.kind)).toEqual(["row"]);
  });

  it("does not repeat a row's first tab when the row already matches, but shows another matching tab", () => {
    const s = filterMore(groups, "o");
    const inboxResults = s.find((x) => x.key === "you")!.results.filter((r) => r.row.key === "inbox");
    // "Inbox" matches "o"; its tabs Notifications (has "o"), Mail (no "o"): Notifications is the first tab (same page as the row), so only the row.
    expect(inboxResults.map((r) => r.kind)).toEqual(["row"]);
    const pmResults = s.find((x) => x.key === "work")!.results.map((r) => (r.kind === "row" ? "row" : r.tab.key));
    expect(pmResults).toEqual(["row", "board"]);
  });

  it("finds nothing for a query no label holds", () => {
    expect(filterMore(groups, "zzz")).toEqual([]);
  });
});

describe("the filter's answers", () => {
  it("counts results across sections", () => {
    expect(countResults(filterMore(groups, ""))).toBe(3);
    expect(countResults(filterMore(groups, "zzz"))).toBe(0);
  });

  it("an exact match is a result whose label is the query, ignoring case and outer spaces", () => {
    const s = filterMore(groups, "my tasks");
    expect(exactResult(s, " My Tasks ")).toMatchObject({ kind: "row", row: { key: "tasks" } });
    expect(exactResult(filterMore(groups, "task"), "task")).toBeNull();
    expect(exactResult(s, "")).toBeNull();
  });

  it("announces nothing until something is typed, then how many pages were found", () => {
    expect(resultsAnnouncement("", 5)).toBe("");
    expect(resultsAnnouncement("  ", 5)).toBe("");
    expect(resultsAnnouncement("x", 0)).toBe("No pages found");
    expect(resultsAnnouncement("x", 1)).toBe("1 page found");
    expect(resultsAnnouncement("x", 7)).toBe("7 pages found");
  });

  it("the badge on More is the sum of the counts inside the panel's rows", () => {
    expect(moreCountOf(groups)).toBe(4);
    expect(moreCountOf([{ key: "a", label: "A", rows: [row("x", "X", [tab("x", "X")], 2), row("y", "Y", [tab("y", "Y")], 3)] }, { key: "b", label: "B", rows: [row("z", "Z", [tab("z", "Z")])] }])).toBe(5);
    expect(moreCountOf([])).toBe(0);
  });
});
