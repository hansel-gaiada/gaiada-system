import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  taskProgressFromSubtasks, projectProgress, resolveResponsible, groupByStatus, suggestFromTask,
  computeTimeline, wouldCreateCycle, openDependencies, timeSummary,
  groupTimelineBars, offsetPctForDate, milestoneMarkers, dependencyEdges, dependencyConflict,
  resolveTags, distinctTagLabels, filterTasksByTagLabels, parseTagFilterParam,
  statusFlags, isDoneStatus, isBlockedStatus, isSynthDefaultStatuses, synthDefaultStatuses,
  distinctStatusLabels, unionStatusColumns,
  addRecurrenceFreq, nextRecurrenceOccurrence, titleWithRecurrenceGlyph,
  transitiveDependents, burndownOverlay, aggregateBurndown, getBurndown, aggregateFlow,
  type PmTask, type Assignee, type Subtask, type TimeLog, type Milestone, type Tag, type ProjectStatus,
  type BurndownPoint, type FlowPoint,
} from "./pm";

// A custom status set where "Done" was renamed to "Shipped" (still isDone) and
// "Blocked" to "Stuck" (still isBlocked), with fresh non-legacy ids — the exact
// shape the flag-driven refactor must handle correctly (P2-05 acceptance).
const CUSTOM: ProjectStatus[] = [
  { id: "s-back",  label: "Backlog",     color: "#A39174", isDone: false, isBlocked: false, position: 0 },
  { id: "s-doing", label: "Doing",       color: "#6E5A43", isDone: false, isBlocked: false, position: 1 },
  { id: "s-stuck", label: "Stuck",       color: "#B5622F", isDone: false, isBlocked: true,  position: 2 },
  { id: "s-ship",  label: "Shipped",     color: "#4B7A5A", isDone: true,  isBlocked: false, position: 3 },
];

const sub = (done: boolean): Subtask => ({ id: Math.random().toString(36), title: "s", done });
const task = (over: Partial<PmTask>): PmTask => ({
  id: "t", projectId: "p", projectName: "P", title: "T", description: "", status: "todo",
  priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
  startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, dependsOn: [], tags: [], customFields: {}, updatedAt: null,
  recurrence: null, projectShortCode: null, seq: null, displayCode: null,
  ...over,
});

describe("progress helpers", () => {
  it("taskProgressFromSubtasks = done ratio, 0 when empty", () => {
    expect(taskProgressFromSubtasks([])).toBe(0);
    expect(taskProgressFromSubtasks([sub(true), sub(false), sub(false), sub(false)])).toBe(25);
    expect(taskProgressFromSubtasks([sub(true), sub(true)])).toBe(100);
  });
  it("projectProgress averages task progress", () => {
    expect(projectProgress([])).toBe(0);
    expect(projectProgress([{ progress: 100 }, { progress: 0 }, { progress: 50 }])).toBe(50);
  });
});

describe("resolveResponsible", () => {
  it("returns the responsible person or null", () => {
    const a: Assignee = { kind: "division", refId: "d1", refName: "Frontend", responsibleId: "u-dev", responsibleName: "Made" };
    expect(resolveResponsible(a)).toEqual({ id: "u-dev", name: "Made" });
    expect(resolveResponsible(null)).toBeNull();
  });
});

describe("groupByStatus", () => {
  it("defaults to the synth legacy 4 ordered columns (un-customized project)", () => {
    const cols = groupByStatus([task({ id: "a", status: "todo" }), task({ id: "b", status: "done" }), task({ id: "c", status: "todo" })]);
    expect(cols.map((c) => c.key)).toEqual(["todo", "in_progress", "blocked", "done"]);
    expect(cols.map((c) => c.label)).toEqual(["To do", "In progress", "Blocked", "Done"]);
    expect(cols[0].tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(cols[3].tasks.map((t) => t.id)).toEqual(["b"]);
  });
  it("is driven by the project's own ordered ProjectStatus[] (custom ids/labels)", () => {
    const cols = groupByStatus([task({ id: "a", status: "s-ship" }), task({ id: "b", status: "s-back" })], CUSTOM);
    expect(cols.map((c) => c.key)).toEqual(["s-back", "s-doing", "s-stuck", "s-ship"]);
    expect(cols.map((c) => c.label)).toEqual(["Backlog", "Doing", "Stuck", "Shipped"]);
    expect(cols[3].tasks.map((t) => t.id)).toEqual(["a"]);
    expect(cols[0].color).toBe("#A39174");
  });
  it("carries a status's wipLimit onto its column and keeps an unknown-status task in a trailing column", () => {
    const withWip: ProjectStatus[] = [{ id: "todo", label: "To do", color: "#A39174", isDone: false, isBlocked: false, position: 0, wipLimit: 2 }];
    const cols = groupByStatus([task({ id: "a", status: "todo" }), task({ id: "orphan", status: "ghost" })], withWip);
    expect(cols[0].wipLimit).toBe(2);
    expect(cols.at(-1)?.tasks.map((t) => t.id)).toEqual(["orphan"]); // never dropped
  });
});

describe("status flags (P2-05)", () => {
  it("resolves done/blocked from the project's flags, not the id string", () => {
    expect(isDoneStatus("s-ship", CUSTOM)).toBe(true);       // renamed done id
    expect(isBlockedStatus("s-stuck", CUSTOM)).toBe(true);   // renamed blocked id
    expect(isDoneStatus("s-back", CUSTOM)).toBe(false);
    expect(statusFlags("s-ship", CUSTOM)).toEqual({ isDone: true, isBlocked: false });
  });
  it("falls back to legacy-id semantics when no registry is passed", () => {
    expect(isDoneStatus("done")).toBe(true);
    expect(isBlockedStatus("blocked")).toBe(true);
    expect(isDoneStatus("todo")).toBe(false);
  });
  it("isSynthDefaultStatuses is true only for the unmodified legacy 4", () => {
    expect(isSynthDefaultStatuses(synthDefaultStatuses())).toBe(true);
    expect(isSynthDefaultStatuses(CUSTOM)).toBe(false);
  });
});

describe("suggestFromTask", () => {
  it("derives progress from subtasks and moves todo→in_progress (defaults)", () => {
    const s = suggestFromTask(task({ status: "todo", subtasks: [sub(true), sub(false)] }));
    expect(s.progress).toBe(50);
    expect(s.status).toBe("in_progress");
  });
  it("moves to done at 100% and explains", () => {
    const s = suggestFromTask(task({ status: "in_progress", subtasks: [sub(true), sub(true)] }));
    expect(s.progress).toBe(100);
    expect(s.status).toBe("done");
    expect(s.rationale).toContain("2/2");
  });
  it("targets the project's isDone status by FLAG even when renamed (Shipped, not 'done')", () => {
    const s = suggestFromTask(task({ status: "s-doing", subtasks: [sub(true), sub(true)] }), CUSTOM);
    expect(s.progress).toBe(100);
    expect(s.status).toBe("s-ship");           // the isDone status, whatever its id
    expect(s.rationale).toContain("“Shipped”"); // rationale uses its label
  });
  it("advances the first flow status to the second on any progress (renamed spine)", () => {
    const s = suggestFromTask(task({ status: "s-back", subtasks: [sub(true), sub(false)] }), CUSTOM);
    expect(s.status).toBe("s-doing");
  });
});

describe("dependencies", () => {
  const a = task({ id: "a" });
  const b = task({ id: "b", dependsOn: ["a"] });
  const c = task({ id: "c", dependsOn: ["b"] });
  const all = [a, b, c];

  it("wouldCreateCycle detects direct and transitive cycles", () => {
    // c depends on b depends on a; making a depend on c would loop.
    expect(wouldCreateCycle(all, "a", "c")).toBe(true);
    expect(wouldCreateCycle(all, "a", "a")).toBe(true); // self
    expect(wouldCreateCycle(all, "a", "b")).toBe(true); // b already needs a
    expect(wouldCreateCycle(all, "c", "a")).toBe(false); // fine (c already needs a transitively, but a doesn't need c)
  });

  it("openDependencies returns only unfinished blockers", () => {
    const done = task({ id: "a", status: "done" });
    const byId = new Map([[done.id, done], ["x", task({ id: "x", status: "todo" })]]);
    const t = task({ id: "t", dependsOn: ["a", "x"] });
    expect(openDependencies(t, byId).map((d) => d.id)).toEqual(["x"]);
  });
});

// ---- P2-02 tags ----
const tag = (over: Partial<Tag>): Tag => ({ id: "tg-1", label: "Design", color: "bronze", ...over });

describe("resolveTags", () => {
  it("resolves ids to Tag objects via the registry, dropping unknown ids", () => {
    const registry = [tag({ id: "a", label: "Design" }), tag({ id: "b", label: "Urgent", color: "clay" })];
    expect(resolveTags(["a", "ghost", "b"], registry).map((t) => t.label)).toEqual(["Design", "Urgent"]);
    expect(resolveTags([], registry)).toEqual([]);
  });
});

describe("distinctTagLabels + filterTasksByTagLabels (cross-project, D-1)", () => {
  const registriesByProject = {
    p1: [tag({ id: "a", label: "Design" }), tag({ id: "b", label: "Frontend", color: "slate" })],
    p2: [tag({ id: "c", label: "Frontend", color: "slate" }), tag({ id: "d", label: "Research", color: "olive" })],
  };
  it("distinctTagLabels dedups the same label across projects' different ids", () => {
    expect(distinctTagLabels(registriesByProject)).toEqual(["Design", "Frontend", "Research"]);
  });
  it("filterTasksByTagLabels matches by label across projects despite different tag ids", () => {
    const tasks = [
      task({ id: "1", projectId: "p1", tags: ["b"] }), // p1's Frontend (id "b")
      task({ id: "2", projectId: "p2", tags: ["c"] }), // p2's Frontend (id "c") — same label, different id
      task({ id: "3", projectId: "p2", tags: ["d"] }), // Research
    ];
    expect(filterTasksByTagLabels(tasks, registriesByProject, ["Frontend"]).map((t) => t.id)).toEqual(["1", "2"]);
    expect(filterTasksByTagLabels(tasks, registriesByProject, [])).toEqual(tasks); // no filter = passthrough
  });
});

describe("union-by-label status columns (dept board, D-4)", () => {
  // Two projects whose status sets share labels ("To do"/"Done") under DIFFERENT
  // ids, plus a label unique to one project.
  const statusesByProject: Record<string, ProjectStatus[]> = {
    p1: [
      { id: "p1-todo", label: "To do", color: "#A39174", isDone: false, isBlocked: false, position: 0 },
      { id: "p1-done", label: "Done", color: "#4B7A5A", isDone: true, isBlocked: false, position: 1 },
    ],
    p2: [
      { id: "p2-todo", label: "To do", color: "#A39174", isDone: false, isBlocked: false, position: 0 },
      { id: "p2-rev", label: "Review", color: "#6E5A43", isDone: false, isBlocked: false, position: 1 },
      { id: "p2-done", label: "Done", color: "#4B7A5A", isDone: true, isBlocked: false, position: 2 },
    ],
  };
  it("distinctStatusLabels dedups shared labels and orders by average position", () => {
    // To do avg 0; Review avg 1; Done avg (1+2)/2 = 1.5
    expect(distinctStatusLabels(statusesByProject)).toEqual(["To do", "Review", "Done"]);
  });
  it("buckets each task by ITS OWN project's status label despite different ids", () => {
    const tasks = [
      task({ id: "1", projectId: "p1", status: "p1-todo" }),
      task({ id: "2", projectId: "p2", status: "p2-todo" }),
      task({ id: "3", projectId: "p1", status: "p1-done" }),
      task({ id: "4", projectId: "p2", status: "p2-rev" }),
    ];
    const cols = unionStatusColumns(tasks, statusesByProject);
    expect(cols.map((c) => c.label)).toEqual(["To do", "Review", "Done"]);
    expect(cols[0].tasks.map((t) => t.id)).toEqual(["1", "2"]); // both projects' "To do"
    expect(cols[1].tasks.map((t) => t.id)).toEqual(["4"]);      // p2-only "Review"
    expect(cols[2].tasks.map((t) => t.id)).toEqual(["3"]);      // p1's "Done"
  });
});

describe("parseTagFilterParam", () => {
  it("normalizes undefined/string/string[] to an array", () => {
    expect(parseTagFilterParam(undefined)).toEqual([]);
    expect(parseTagFilterParam("Design")).toEqual(["Design"]);
    expect(parseTagFilterParam(["Design", "Urgent"])).toEqual(["Design", "Urgent"]);
  });
});

describe("timeSummary", () => {
  it("totals minutes and billable minutes", () => {
    const logs: TimeLog[] = [
      { id: "1", taskId: "t", userId: "u", userName: "U", minutes: 120, spentOn: "2026-07-01", billable: true, note: "" },
      { id: "2", taskId: "t", userId: "u", userName: "U", minutes: 60, spentOn: "2026-07-02", billable: false, note: "" },
    ];
    expect(timeSummary(logs)).toEqual({ total: 180, billable: 120, entries: 2 });
  });
});

describe("computeTimeline", () => {
  it("returns null when nothing is dated", () => {
    expect(computeTimeline([task({ id: "a" })])).toBeNull();
  });
  it("lays dated tasks on a shared axis with padding", () => {
    const tl = computeTimeline([
      task({ id: "a", startDate: "2026-07-01", dueDate: "2026-07-03" }),
      task({ id: "b", startDate: "2026-07-05", dueDate: "2026-07-06" }),
    ])!;
    expect(tl).not.toBeNull();
    expect(tl.bars).toHaveLength(2);
    // first bar starts after the left padding (offset > 0), all within bounds
    expect(tl.bars.every((bar) => bar.offsetPct >= 0 && bar.offsetPct + bar.widthPct <= 100.01)).toBe(true);
  });
});

// ---- P1-04 Gantt aggregation helpers ----
const ms = (over: Partial<Milestone>): Milestone => ({ id: "m", projectId: "p", name: "M", dueDate: null, status: "open", ...over });

describe("groupTimelineBars", () => {
  const tl = computeTimeline([
    task({ id: "a", projectId: "p1", projectName: "Alpha", startDate: "2026-07-01", dueDate: "2026-07-03" }),
    task({ id: "b", projectId: "p2", projectName: "Beta", startDate: "2026-07-04", dueDate: "2026-07-06" }),
    task({ id: "c", projectId: "p1", projectName: "Alpha", startDate: "2026-07-05", dueDate: "2026-07-08" }),
  ])!;

  it("flat = one unlabelled group with all bars (legacy view)", () => {
    const g = groupTimelineBars(tl.bars, "flat");
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("");
    expect(g[0].bars).toHaveLength(3);
  });

  it("project groups sort by label and keep their bars", () => {
    const g = groupTimelineBars(tl.bars, "project");
    expect(g.map((x) => x.label)).toEqual(["Alpha", "Beta"]);
    expect(g[0].bars.map((b) => b.task.id)).toEqual(["a", "c"]);
  });

  it("assignee groups push unassigned last", () => {
    const withAssignee = computeTimeline([
      task({ id: "a", startDate: "2026-07-01", dueDate: "2026-07-02", assignee: { kind: "person", refId: "u1", refName: "Zed", responsibleId: "u1", responsibleName: "Zed" } }),
      task({ id: "b", startDate: "2026-07-03", dueDate: "2026-07-04" }),
    ])!;
    const g = groupTimelineBars(withAssignee.bars, "assignee");
    expect(g[g.length - 1].label).toBe("Unassigned");
    expect(g[0].label).toBe("Zed");
  });

  it("milestone groups resolve names and bucket the unlinked last", () => {
    const t = computeTimeline([
      task({ id: "a", milestoneId: "m1", startDate: "2026-07-01", dueDate: "2026-07-02" }),
      task({ id: "b", milestoneId: null, startDate: "2026-07-03", dueDate: "2026-07-04" }),
    ])!;
    const g = groupTimelineBars(t.bars, "milestone", [{ id: "m1", name: "Launch" }]);
    expect(g[0].label).toBe("Launch");
    expect(g[g.length - 1].label).toBe("No milestone");
  });
});

describe("offsetPctForDate + milestoneMarkers", () => {
  const tl = computeTimeline([task({ id: "a", startDate: "2026-07-01", dueDate: "2026-07-11" })])!;

  it("start/end of the padded axis map near 0 and 100", () => {
    expect(offsetPctForDate(tl, tl.start)).toBeCloseTo(0, 5);
    expect(offsetPctForDate(tl, tl.end)).toBeCloseTo(100, 5);
  });
  it("a mid date lands between the ends", () => {
    const mid = offsetPctForDate(tl, "2026-07-06");
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });
  it("milestoneMarkers drops undated milestones and positions the rest", () => {
    const markers = milestoneMarkers(tl, [ms({ id: "m1", name: "Beta", dueDate: "2026-07-06" }), ms({ id: "m2", name: "None", dueDate: null })]);
    expect(markers.map((m) => m.id)).toEqual(["m1"]);
    expect(markers[0].offsetPct).toBeGreaterThan(0);
    expect(markers[0].offsetPct).toBeLessThan(100);
  });
});

describe("dependencyConflict + dependencyEdges", () => {
  it("conflict when the blocker's due is after the blocked's start", () => {
    const blocker = task({ id: "x", dueDate: "2026-07-10" });
    const blockedLate = task({ id: "y", startDate: "2026-07-05" });
    const blockedOk = task({ id: "z", startDate: "2026-07-12" });
    expect(dependencyConflict(blocker, blockedLate)).toBe(true);
    expect(dependencyConflict(blocker, blockedOk)).toBe(false);
    expect(dependencyConflict(task({ id: "x", dueDate: null }), blockedLate)).toBe(false);
  });

  it("edges run blocker→blocked and flag conflicts, skipping absent endpoints", () => {
    const tl = computeTimeline([
      task({ id: "x", startDate: "2026-07-01", dueDate: "2026-07-10" }),
      task({ id: "y", startDate: "2026-07-05", dueDate: "2026-07-08", dependsOn: ["x", "ghost"] }),
    ])!;
    const edges = dependencyEdges(tl.bars);
    expect(edges).toHaveLength(1); // "ghost" isn't in the bar set
    expect(edges[0]).toMatchObject({ fromId: "x", toId: "y", conflict: true });
  });
});

// ---- P2-06 recurring tasks (design spec §8) ----
describe("addRecurrenceFreq / nextRecurrenceOccurrence", () => {
  it("daily/weekly/biweekly shift by fixed day counts", () => {
    expect(addRecurrenceFreq("2026-07-16", "daily")).toBe("2026-07-17");
    expect(addRecurrenceFreq("2026-07-16", "weekly")).toBe("2026-07-23");
    expect(addRecurrenceFreq("2026-07-16", "biweekly")).toBe("2026-07-30");
  });

  it("monthly shifts by one calendar month, clamping day-of-month overflow (Jan 31 -> Feb 28)", () => {
    expect(addRecurrenceFreq("2026-01-15", "monthly")).toBe("2026-02-15");
    expect(addRecurrenceFreq("2026-01-31", "monthly")).toBe("2026-02-28"); // 2026 is not a leap year
    expect(addRecurrenceFreq("2026-12-15", "monthly")).toBe("2027-01-15"); // year rollover
  });

  it("shifts both startDate and dueDate by the same freq, preserving their offset", () => {
    const next = nextRecurrenceOccurrence("2026-07-20", "2026-07-15", { freq: "weekly" });
    expect(next).toEqual({ startDate: "2026-07-22", dueDate: "2026-07-27" });
  });

  it("shifts only dueDate when there's no startDate", () => {
    const next = nextRecurrenceOccurrence("2026-07-20", null, { freq: "daily" });
    expect(next).toEqual({ startDate: null, dueDate: "2026-07-21" });
  });

  it("returns null with no dueDate to anchor on", () => {
    expect(nextRecurrenceOccurrence(null, "2026-07-15", { freq: "weekly" })).toBeNull();
  });

  it("respects `until`: no next occurrence once the shifted due date would land after it", () => {
    expect(nextRecurrenceOccurrence("2026-07-30", null, { freq: "weekly", until: "2026-08-01" })).toBeNull();
    expect(nextRecurrenceOccurrence("2026-07-20", null, { freq: "weekly", until: "2026-08-01" })).toEqual({ startDate: null, dueDate: "2026-07-27" });
  });
});

describe("titleWithRecurrenceGlyph", () => {
  it("prefixes ↻ only when recurrence is set", () => {
    expect(titleWithRecurrenceGlyph({ title: "Weekly report", recurrence: { freq: "weekly" } })).toBe("↻ Weekly report");
    expect(titleWithRecurrenceGlyph({ title: "One-off", recurrence: null })).toBe("One-off");
  });
});

// ---- P2-08 move-together ----
describe("transitiveDependents", () => {
  it("finds direct + transitive dependents (walking dependsOn BACKWARD)", () => {
    // a <- b <- c  (b depends on a, c depends on b): dragging a should carry b and c.
    const tasks = [
      task({ id: "a" }),
      task({ id: "b", dependsOn: ["a"] }),
      task({ id: "c", dependsOn: ["b"] }),
      task({ id: "unrelated" }),
    ];
    expect(new Set(transitiveDependents(tasks, "a"))).toEqual(new Set(["b", "c"]));
    expect(transitiveDependents(tasks, "c")).toEqual([]); // nothing depends ON c
    expect(transitiveDependents(tasks, "unrelated")).toEqual([]);
  });

  it("a task can have multiple direct dependents, all included", () => {
    const tasks = [task({ id: "a" }), task({ id: "b", dependsOn: ["a"] }), task({ id: "c", dependsOn: ["a"] })];
    expect(new Set(transitiveDependents(tasks, "a"))).toEqual(new Set(["b", "c"]));
  });

  it("terminates on a dependsOn cycle instead of recursing forever", () => {
    // x <-> y (mutually "depend" on each other) — malformed data the UI must never hang on.
    const tasks = [task({ id: "x", dependsOn: ["y"] }), task({ id: "y", dependsOn: ["x"] })];
    expect(new Set(transitiveDependents(tasks, "x"))).toEqual(new Set(["y"]));
  });

  it("returns [] for a task nobody depends on, including one with no dependsOn edges at all", () => {
    expect(transitiveDependents([task({ id: "solo" })], "solo")).toEqual([]);
    expect(transitiveDependents([], "missing")).toEqual([]);
  });
});

// ---- P2-08 burndown overlay ----
describe("burndownOverlay", () => {
  const tl = computeTimeline([task({ id: "t", startDate: "2026-07-01", dueDate: "2026-07-10" })])!;

  it("empty series -> [] (caller hides the overlay entirely)", () => {
    expect(burndownOverlay(tl, [])).toEqual([]);
  });

  it("positions each point on the timeline's date axis and derives ideal/actual remaining %", () => {
    const series: BurndownPoint[] = [
      { date: "2026-07-01", open: 10, done: 0, avgProgress: 0 },
      { date: "2026-07-05", open: 6, done: 4, avgProgress: 40 },
      { date: "2026-07-10", open: 2, done: 8, avgProgress: 80 },
    ];
    const overlay = burndownOverlay(tl, series);
    expect(overlay).toHaveLength(3);
    expect(overlay[0].x).toBe(offsetPctForDate(tl, "2026-07-01"));
    // ideal is a straight line from 100 at the first point to 0 at the last.
    expect(overlay[0].idealPct).toBe(100);
    expect(overlay[1].idealPct).toBe(50);
    expect(overlay[2].idealPct).toBe(0);
    // actual is each day's open count against the FIRST point's total (10).
    expect(overlay[0].actualPct).toBe(100);
    expect(overlay[1].actualPct).toBe(60);
    expect(overlay[2].actualPct).toBe(20);
  });

  it("a single-point series doesn't divide by zero computing the ideal line", () => {
    const overlay = burndownOverlay(tl, [{ date: "2026-07-05", open: 5, done: 5, avgProgress: 50 }]);
    expect(overlay).toHaveLength(1);
    expect(overlay[0].idealPct).toBe(50);
    expect(overlay[0].actualPct).toBe(50);
  });

  it("a series whose first point has zero total tasks never NaNs the percentages", () => {
    const overlay = burndownOverlay(tl, [{ date: "2026-07-01", open: 0, done: 0, avgProgress: 0 }]);
    expect(overlay[0].actualPct).toBe(0);
    expect(Number.isNaN(overlay[0].idealPct)).toBe(false);
  });
});

describe("aggregateBurndown", () => {
  it("sums open/done by date across projects and weight-averages avgProgress", () => {
    const a: BurndownPoint[] = [{ date: "2026-07-01", open: 4, done: 0, avgProgress: 0 }];
    const b: BurndownPoint[] = [{ date: "2026-07-01", open: 1, done: 3, avgProgress: 75 }];
    const merged = aggregateBurndown([a, b]);
    expect(merged).toEqual([{ date: "2026-07-01", open: 5, done: 3, avgProgress: Math.round((0 * 4 + 75 * 4) / 8) }]);
  });

  it("a date present in only some projects' series still sums whatever exists that day", () => {
    const a: BurndownPoint[] = [{ date: "2026-07-01", open: 2, done: 0, avgProgress: 0 }, { date: "2026-07-02", open: 1, done: 1, avgProgress: 50 }];
    const b: BurndownPoint[] = [{ date: "2026-07-02", open: 3, done: 0, avgProgress: 0 }];
    const merged = aggregateBurndown([a, b]);
    expect(merged.map((p) => p.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(merged[0]).toEqual({ date: "2026-07-01", open: 2, done: 0, avgProgress: 0 });
    expect(merged[1].open).toBe(4);
    expect(merged[1].done).toBe(1);
  });

  it("empty input -> []", () => {
    expect(aggregateBurndown([])).toEqual([]);
    expect(aggregateBurndown([[], []])).toEqual([]);
  });
});

describe("aggregateFlow", () => {
  const STATUS_A: ProjectStatus[] = [
    { id: "todo", label: "To do", color: "#A39174", isDone: false, isBlocked: false, position: 0 },
    { id: "done", label: "Done", color: "#4B7A5A", isDone: true, isBlocked: false, position: 1 },
  ];
  // Project B renamed "Done" -> its OWN id, but the SAME label — must merge into one band.
  const STATUS_B: ProjectStatus[] = [
    { id: "backlog", label: "To do", color: "#111111", isDone: false, isBlocked: false, position: 0 },
    { id: "shipped", label: "Done", color: "#222222", isDone: true, isBlocked: false, position: 1 },
  ];

  it("sums same-day per-status counts across projects BY LABEL, not raw id", () => {
    const a: FlowPoint[] = [{ date: "2026-07-01", counts: { todo: 2, done: 1 } }];
    const b: FlowPoint[] = [{ date: "2026-07-01", counts: { backlog: 3, shipped: 0 } }];
    const merged = aggregateFlow([{ points: a, statuses: STATUS_A }, { points: b, statuses: STATUS_B }]);
    expect(merged.statuses.map((s) => s.label)).toEqual(["To do", "Done"]);
    expect(merged.points).toEqual([{ date: "2026-07-01", counts: { "To do": 5, "Done": 1 } }]);
  });

  it("colors the merged band from the FIRST registry carrying the label", () => {
    const merged = aggregateFlow([
      { points: [], statuses: STATUS_A },
      { points: [], statuses: STATUS_B },
    ]);
    expect(merged.statuses.find((s) => s.label === "To do")?.color).toBe("#A39174");
    expect(merged.statuses.find((s) => s.label === "Done")?.color).toBe("#4B7A5A");
  });

  it("a date present in only some projects' series still sums whatever exists that day", () => {
    const a: FlowPoint[] = [{ date: "2026-07-01", counts: { todo: 1, done: 0 } }, { date: "2026-07-02", counts: { todo: 0, done: 1 } }];
    const b: FlowPoint[] = [{ date: "2026-07-02", counts: { backlog: 2, shipped: 0 } }];
    const merged = aggregateFlow([{ points: a, statuses: STATUS_A }, { points: b, statuses: STATUS_B }]);
    expect(merged.points.map((p) => p.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(merged.points[0].counts).toEqual({ "To do": 1, "Done": 0 });
    expect(merged.points[1].counts).toEqual({ "To do": 2, "Done": 1 });
  });

  it("empty input -> { points: [], statuses: [] }", () => {
    expect(aggregateFlow([])).toEqual({ points: [], statuses: [] });
  });
});

// ---- P2-08 burndown reader (DEMO_MODE integration — exercises the real query-string +
// skipUnavailable degrade path through demoPm's /burndown route) ----
describe("getBurndown reader", () => {
  const prevDemo = process.env.DEMO_MODE;
  beforeEach(() => { process.env.DEMO_MODE = "1"; });
  afterEach(() => {
    if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo;
  });

  it("returns a non-empty series for a seeded demo project, ending at the fixed demo 'today'", async () => {
    const rows = await getBurndown("demo-hansel", "co-agency", "p-web-1");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.date).toBe("2026-07-16");
  });

  it("applies from/to as an inclusive date-range filter", async () => {
    const rows = await getBurndown("demo-hansel", "co-agency", "p-web-1", "2026-07-15", "2026-07-16");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.date >= "2026-07-15" && r.date <= "2026-07-16")).toBe(true);
  });

  it("a range outside the series -> [], not an error", async () => {
    const rows = await getBurndown("demo-hansel", "co-agency", "p-web-1", "2099-01-01", "2099-01-02");
    expect(rows).toEqual([]);
  });

  it("degrades to [] for a project with no tasks at all", async () => {
    const rows = await getBurndown("demo-hansel", "co-agency", "p-totally-unknown");
    expect(rows).toEqual([]);
  });
});
