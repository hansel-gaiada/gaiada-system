import { describe, it, expect } from "vitest";
import {
  isOverdue, isDueSoon, computeDeptKpis, computeProjectHealth,
  toRailPriority, myDeptTasksToday, myBlockedTasks,
  parseBoardFocus, encodeBoardFocus, filterTasksByFocus,
  priorityColumns, assigneeColumns, divisionColumns, divisionStatusGrid, assigneeStatusGrid,
  type DeptDivision,
} from "./departments";
import { DEFAULT_STATUSES } from "./pm";
import type { PmTask, ProjectStatus } from "./pm";

const NOW = new Date("2026-07-22T12:00:00Z");

// A project that renamed Done→Shipped (isDone) and Blocked→Stuck (isBlocked)
// with non-legacy ids — the KPI/health/rail math must key off the FLAGS.
const SHIPPED: ProjectStatus = { id: "s-ship", label: "Shipped", color: "var(--status-ok-fg)", isDone: true, isBlocked: false, position: 3 };
const STUCK: ProjectStatus = { id: "s-stuck", label: "Stuck", color: "var(--status-critical-fg)", isDone: false, isBlocked: true, position: 2 };
const DOING: ProjectStatus = { id: "s-doing", label: "Doing", color: "var(--accent)", isDone: false, isBlocked: false, position: 1 };
const CUSTOM_STATUSES: Record<string, ProjectStatus[]> = { pc: [DOING, STUCK, SHIPPED] };

const task = (over: Partial<PmTask>): PmTask => ({
  id: "t", projectId: "p", projectName: "P", title: "T", description: "", status: "todo",
  priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
  startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, dependsOn: [], tags: [], customFields: {}, updatedAt: null,
  recurrence: null, projectShortCode: null, seq: null, displayCode: null,
  ...over,
});

describe("isOverdue / isDueSoon", () => {
  it("null dueDate is neither overdue nor due soon", () => {
    expect(isOverdue(null, NOW)).toBe(false);
    expect(isDueSoon(null, NOW)).toBe(false);
  });
  it("a past date is overdue AND counts as due soon (no lower bound)", () => {
    expect(isOverdue("2026-07-01", NOW)).toBe(true);
    expect(isDueSoon("2026-07-01", NOW)).toBe(true);
  });
  it("a few days out is not overdue but is due soon", () => {
    expect(isOverdue("2026-07-25", NOW)).toBe(false);
    expect(isDueSoon("2026-07-25", NOW)).toBe(true);
  });
  it("well beyond the 7-day window is neither overdue nor due soon", () => {
    expect(isDueSoon("2026-08-15", NOW)).toBe(false);
    expect(isOverdue("2026-08-15", NOW)).toBe(false);
  });
});

describe("computeDeptKpis", () => {
  it("computes active/dueSoon/blocked from tasks and progress from the passed-in project percentages", () => {
    const tasks = [
      task({ id: "a", status: "todo", dueDate: "2026-07-20" }), // overdue -> active, dueSoon
      task({ id: "b", status: "in_progress", dueDate: "2026-08-01" }), // active, not dueSoon
      task({ id: "c", status: "blocked", dueDate: "2026-07-23" }), // blocked, dueSoon
      task({ id: "d", status: "done", dueDate: "2026-07-01" }), // done -> excluded everywhere
    ];
    const kpis = computeDeptKpis(tasks, [40, 60], NOW);
    expect(kpis).toEqual({ active: 2, dueSoon: 2, blocked: 1, progressPct: 50 });
  });
  it("progressPct is 0 with no owned projects", () => {
    expect(computeDeptKpis([], [], NOW).progressPct).toBe(0);
  });
  it("counts a RENAMED custom isDone/isBlocked status by FLAG, not id (P2-05)", () => {
    const tasks = [
      task({ id: "a", projectId: "pc", status: "s-doing", dueDate: "2026-07-23" }), // active + dueSoon
      task({ id: "b", projectId: "pc", status: "s-stuck", dueDate: "2026-08-01" }), // blocked (not active)
      task({ id: "c", projectId: "pc", status: "s-ship", dueDate: "2026-07-01" }),  // done -> excluded
    ];
    const kpis = computeDeptKpis(tasks, [80], NOW, CUSTOM_STATUSES);
    expect(kpis).toEqual({ active: 1, dueSoon: 1, blocked: 1, progressPct: 80 });
  });
});

describe("computeProjectHealth", () => {
  it("flags atRisk when overdue>0 or blocked>0 and builds the reason string", () => {
    const tasks = [
      task({ id: "a", status: "in_progress", dueDate: "2026-07-01" }), // overdue
      task({ id: "b", status: "blocked", dueDate: "2026-08-01" }), // blocked, not overdue
      task({ id: "c", status: "done" }),
    ];
    const health = computeProjectHealth(tasks, [], NOW);
    expect(health.atRisk).toBe(true);
    expect(health.atRiskReason).toBe("1 overdue · 1 blocked");
    expect(health.openCount).toBe(2); // a + b, not the done one
  });
  it("is not at-risk with no overdue/blocked tasks", () => {
    const health = computeProjectHealth([task({ status: "in_progress", dueDate: "2026-08-01" })], [], NOW);
    expect(health.atRisk).toBe(false);
    expect(health.atRiskReason).toBeUndefined();
  });
  it("picks the earliest not-done milestone as nextMilestone, ignoring done ones", () => {
    const milestones = [
      { name: "Kickoff", dueDate: "2026-06-01", status: "done" },
      { name: "Beta", dueDate: "2026-08-15", status: "active" },
      { name: "Launch", dueDate: "2026-07-30", status: "active" },
    ];
    const health = computeProjectHealth([], milestones, NOW);
    expect(health.nextMilestone).toEqual({ label: "Launch", dueDate: "2026-07-30" });
  });
  it("nextMilestone is null when every milestone is done or unset", () => {
    expect(computeProjectHealth([], [{ name: "Kickoff", dueDate: "2026-06-01", status: "done" }], NOW).nextMilestone).toBeNull();
    expect(computeProjectHealth([], [], NOW).nextMilestone).toBeNull();
  });
  it("derives open/overdue/blocked from a RENAMED custom status set (flags, P2-05)", () => {
    const tasks = [
      task({ id: "a", status: "s-doing", dueDate: "2026-07-01" }), // overdue, open
      task({ id: "b", status: "s-stuck", dueDate: "2026-08-01" }), // blocked, open
      task({ id: "c", status: "s-ship" }),                          // done -> not open, not overdue
    ];
    const health = computeProjectHealth(tasks, [], NOW, [DOING, STUCK, SHIPPED]);
    expect(health.openCount).toBe(2);
    expect(health.atRisk).toBe(true);
    expect(health.atRiskReason).toBe("1 overdue · 1 blocked");
  });
});

describe("toRailPriority", () => {
  it("maps normal->medium and urgent->critical; passes high/low through", () => {
    expect(toRailPriority("normal")).toBe("medium");
    expect(toRailPriority("urgent")).toBe("critical");
    expect(toRailPriority("high")).toBe("high");
    expect(toRailPriority("low")).toBe("low");
  });
});

describe("myDeptTasksToday", () => {
  it("filters to this person's not-done tasks, sorted by due date then priority desc", () => {
    const mkA = (id: string, dueDate: string | null, priority: PmTask["priority"]) =>
      task({ id, dueDate, priority, assignee: { kind: "person", refId: "u-1", refName: "Me", responsibleId: "u-1", responsibleName: "Me" } });
    const tasks = [
      mkA("late-low", "2026-07-25", "low"),
      mkA("late-high", "2026-07-25", "high"),
      mkA("early", "2026-07-20", "normal"),
      task({ id: "not-mine", dueDate: "2026-07-01", assignee: { kind: "person", refId: "u-2", refName: "Other", responsibleId: "u-2", responsibleName: "Other" } }),
      task({ id: "done", status: "done", assignee: { kind: "person", refId: "u-1", refName: "Me", responsibleId: "u-1", responsibleName: "Me" } }),
    ];
    const result = myDeptTasksToday(tasks, "u-1").map((t) => t.id);
    expect(result).toEqual(["early", "late-high", "late-low"]);
  });
  it("puts undated tasks last", () => {
    const mine = (id: string, dueDate: string | null) =>
      task({ id, dueDate, assignee: { kind: "person", refId: "u-1", refName: "Me", responsibleId: "u-1", responsibleName: "Me" } });
    const result = myDeptTasksToday([mine("undated", null), mine("dated", "2026-07-20")], "u-1").map((t) => t.id);
    expect(result).toEqual(["dated", "undated"]);
  });
});

describe("myBlockedTasks", () => {
  it("only this person's blocked tasks", () => {
    const blocked = (id: string, respId: string) =>
      task({ id, status: "blocked", assignee: { kind: "person", refId: respId, refName: "X", responsibleId: respId, responsibleName: "X" } });
    const tasks = [blocked("mine", "u-1"), blocked("theirs", "u-2"), task({ id: "not-blocked", status: "todo", assignee: { kind: "person", refId: "u-1", refName: "Me", responsibleId: "u-1", responsibleName: "Me" } })];
    expect(myBlockedTasks(tasks, "u-1").map((t) => t.id)).toEqual(["mine"]);
  });
  it("resolves 'blocked' by FLAG against each task's project registry (renamed 'Stuck')", () => {
    const mine = (id: string, status: string) =>
      task({ id, projectId: "pc", status, assignee: { kind: "person", refId: "u-1", refName: "Me", responsibleId: "u-1", responsibleName: "Me" } });
    const tasks = [mine("stuck", "s-stuck"), mine("doing", "s-doing")];
    expect(myBlockedTasks(tasks, "u-1", CUSTOM_STATUSES).map((t) => t.id)).toEqual(["stuck"]);
  });
});

// ---------------- Board focus model (WSUX-7) ----------------
const divisions: DeptDivision[] = [
  { id: "div-seo", name: "SEO", people: [{ id: "u-1", name: "Ada" }] },
  { id: "div-video", name: "Video", people: [{ id: "u-2", name: "Ben" }] },
];

describe("parseBoardFocus / encodeBoardFocus", () => {
  it("round-trips dept/me/division:<id>", () => {
    expect(parseBoardFocus(undefined)).toEqual({ mode: "dept" });
    expect(parseBoardFocus("dept")).toEqual({ mode: "dept" });
    expect(parseBoardFocus("me")).toEqual({ mode: "me" });
    expect(parseBoardFocus("division:div-seo")).toEqual({ mode: "division", divisionId: "div-seo" });
  });
  it("falls back to dept on garbage input", () => {
    expect(parseBoardFocus("nonsense")).toEqual({ mode: "dept" });
  });
  it("encodeBoardFocus is the inverse", () => {
    expect(encodeBoardFocus({ mode: "dept" })).toBe("dept");
    expect(encodeBoardFocus({ mode: "me" })).toBe("me");
    expect(encodeBoardFocus({ mode: "division", divisionId: "div-seo" })).toBe("division:div-seo");
  });
});

describe("filterTasksByFocus", () => {
  const divAssignee = (kind: "division" | "person", refId: string, responsibleId?: string) =>
    ({ kind, refId, refName: "X", responsibleId: responsibleId ?? refId, responsibleName: "X" }) as PmTask["assignee"];
  const tasks: PmTask[] = [
    task({ id: "seo-direct", assignee: divAssignee("division", "div-seo") }),
    task({ id: "seo-person", assignee: divAssignee("person", "u-1") }),
    task({ id: "video-task", assignee: divAssignee("division", "div-video") }),
    task({ id: "mine", assignee: { kind: "person", refId: "u-9", refName: "X", responsibleId: "u-1", responsibleName: "Ada" } }),
  ];

  it("mode dept returns everything unfiltered", () => {
    expect(filterTasksByFocus(tasks, divisions, { mode: "dept" }, "u-1").map((t) => t.id)).toEqual(
      tasks.map((t) => t.id),
    );
  });
  it("mode me filters to responsibleId === userId", () => {
    expect(filterTasksByFocus(tasks, divisions, { mode: "me" }, "u-1").map((t) => t.id)).toEqual(["seo-person", "mine"]);
  });
  it("mode division includes direct division assignment, its people's tasks, and responsible-in-division", () => {
    const result = filterTasksByFocus(tasks, divisions, { mode: "division", divisionId: "div-seo" }, "u-9").map((t) => t.id);
    expect(result).toEqual(["seo-direct", "seo-person", "mine"]);
  });
  it("an unknown division id yields no tasks (never silently falls back to whole dept)", () => {
    expect(filterTasksByFocus(tasks, divisions, { mode: "division", divisionId: "does-not-exist" }, "u-1")).toEqual([]);
  });
});

describe("divisionColumns", () => {
  const tasks: PmTask[] = [
    task({ id: "a", assignee: { kind: "division", refId: "div-seo", refName: "SEO", responsibleId: "u-1", responsibleName: "Ada" } }),
    task({ id: "b", assignee: { kind: "division", refId: "div-video", refName: "Video", responsibleId: "u-2", responsibleName: "Ben" } }),
    task({ id: "c", assignee: null }),
  ];

  it("groups by division, buckets unmatched into a people-less 'No division' column", () => {
    const cols = divisionColumns(tasks, divisions);
    expect(cols.map((c) => [c.label, c.tasks.map((t) => t.id)])).toEqual([
      ["SEO", ["a"]],
      ["Video", ["b"]],
      ["No division", ["c"]],
    ]);
    expect(cols[0].people).toEqual(divisions[0].people);
    expect(cols[1].people).toEqual(divisions[1].people);
    expect(cols.find((c) => c.label === "No division")?.people).toBeUndefined();
  });
  it("omits the 'No division' bucket when every task is placed", () => {
    const placed = [task({ id: "a", assignee: { kind: "division", refId: "div-seo", refName: "SEO", responsibleId: "u-1", responsibleName: "Ada" } })];
    expect(divisionColumns(placed, divisions).map((c) => c.label)).toEqual(["SEO", "Video"]);
  });
});

describe("assigneeColumns", () => {
  const tasks: PmTask[] = [
    task({ id: "a", assignee: { kind: "person", refId: "u-1", refName: "Ada", responsibleId: "u-1", responsibleName: "Ada" } }),
    task({ id: "b", assignee: { kind: "person", refId: "u-2", refName: "Ben", responsibleId: "u-2", responsibleName: "Ben" } }),
    task({ id: "c", assignee: null }),
  ];

  it("groups by responsibleId, sorted by label, with an Unassigned column and no `people`", () => {
    const cols = assigneeColumns(tasks);
    expect(cols.map((c) => c.label)).toEqual(["Ada", "Ben", "Unassigned"]);
    expect(cols.find((c) => c.label === "Unassigned")?.tasks.map((t) => t.id)).toEqual(["c"]);
    expect(cols.every((c) => c.people === undefined)).toBe(true);
  });
});

// ---------------- True 2-axis swimlane grid (P2-09, design spec §8) ----------------
describe("divisionStatusGrid", () => {
  const statusesByProject: Record<string, ProjectStatus[]> = { p: DEFAULT_STATUSES };
  const tasks: PmTask[] = [
    task({ id: "seo-todo", status: "todo", assignee: { kind: "division", refId: "div-seo", refName: "SEO", responsibleId: "u-1", responsibleName: "Ada" } }),
    task({ id: "seo-done", status: "done", assignee: { kind: "division", refId: "div-seo", refName: "SEO", responsibleId: "u-1", responsibleName: "Ada" } }),
    task({ id: "video-todo", status: "todo", assignee: { kind: "division", refId: "div-video", refName: "Video", responsibleId: "u-2", responsibleName: "Ben" } }),
    task({ id: "unplaced", status: "todo", assignee: null }),
  ];

  it("builds one row per division + a people-less 'No division' row, every row sharing the SAME uniform status columns", () => {
    const rows = divisionStatusGrid(tasks, divisions, statusesByProject);
    expect(rows.map((r) => r.label)).toEqual(["SEO", "Video", "No division"]);
    const seo = rows.find((r) => r.label === "SEO")!;
    const video = rows.find((r) => r.label === "Video")!;
    const noDiv = rows.find((r) => r.label === "No division")!;
    // Uniform columns (P2-05 reuse): identical key/label set on every row regardless of which
    // tasks that row actually has.
    expect(seo.columns.map((c) => c.key)).toEqual(video.columns.map((c) => c.key));
    expect(seo.columns.map((c) => c.key)).toEqual(noDiv.columns.map((c) => c.key));
    // Tasks land in the right (row, column) cell.
    expect(seo.columns.find((c) => c.label === "ToDo")?.tasks.map((t) => t.id)).toEqual(["seo-todo"]);
    expect(seo.columns.find((c) => c.label === "Done")?.tasks.map((t) => t.id)).toEqual(["seo-done"]);
    expect(video.columns.find((c) => c.label === "ToDo")?.tasks.map((t) => t.id)).toEqual(["video-todo"]);
    expect(noDiv.columns.find((c) => c.label === "ToDo")?.tasks.map((t) => t.id)).toEqual(["unplaced"]);
    // `people` only on real division rows — BoardGrid's cross-row ambiguity check needs this to
    // be absent on the synthetic bucket (same contract as `divisionColumns`).
    expect(seo.people).toEqual(divisions[0].people);
    expect(video.people).toEqual(divisions[1].people);
    expect(noDiv.people).toBeUndefined();
  });

  it("omits the 'No division' row when every task is placed", () => {
    const placed = [task({ id: "a", assignee: { kind: "division", refId: "div-seo", refName: "SEO", responsibleId: "u-1", responsibleName: "Ada" } })];
    expect(divisionStatusGrid(placed, divisions, statusesByProject).map((r) => r.label)).toEqual(["SEO", "Video"]);
  });
});

describe("assigneeStatusGrid", () => {
  const statusesByProject: Record<string, ProjectStatus[]> = { p: DEFAULT_STATUSES };
  const tasks: PmTask[] = [
    task({ id: "a", status: "todo", assignee: { kind: "person", refId: "u-1", refName: "Ada", responsibleId: "u-1", responsibleName: "Ada" } }),
    task({ id: "b", status: "in_progress", assignee: { kind: "person", refId: "u-2", refName: "Ben", responsibleId: "u-2", responsibleName: "Ben" } }),
    task({ id: "c", status: "todo", assignee: null }),
  ];

  it("builds one row per responsible person (sorted) + Unassigned, uniform status columns, no `people`", () => {
    const rows = assigneeStatusGrid(tasks, statusesByProject);
    expect(rows.map((r) => r.label)).toEqual(["Ada", "Ben", "Unassigned"]);
    expect(rows.every((r) => r.people === undefined)).toBe(true);
    const ada = rows.find((r) => r.label === "Ada")!;
    const ben = rows.find((r) => r.label === "Ben")!;
    expect(ada.columns.map((c) => c.key)).toEqual(ben.columns.map((c) => c.key));
    expect(ada.columns.find((c) => c.label === "ToDo")?.tasks.map((t) => t.id)).toEqual(["a"]);
    expect(ben.columns.find((c) => c.label === "Doing")?.tasks.map((t) => t.id)).toEqual(["b"]);
    expect(rows.find((r) => r.label === "Unassigned")?.columns.find((c) => c.label === "ToDo")?.tasks.map((t) => t.id)).toEqual(["c"]);
  });

  it("stays uniform at any status count — a renamed custom registry (P2-05) still produces the same columns on every row", () => {
    const custom: Record<string, ProjectStatus[]> = { pc: CUSTOM_STATUSES.pc };
    const tasks2 = [
      task({ id: "x", projectId: "pc", status: "s-doing", assignee: { kind: "person", refId: "u-1", refName: "Ada", responsibleId: "u-1", responsibleName: "Ada" } }),
      task({ id: "y", projectId: "pc", status: "s-stuck", assignee: { kind: "person", refId: "u-2", refName: "Ben", responsibleId: "u-2", responsibleName: "Ben" } }),
    ];
    const rows = assigneeStatusGrid(tasks2, custom);
    expect(rows.map((r) => r.columns.map((c) => c.label))).toEqual([
      ["Doing", "Stuck", "Shipped"],
      ["Doing", "Stuck", "Shipped"],
    ]);
  });
});

describe("priorityColumns", () => {
  it("buckets tasks into the four priority columns in fixed order, no `people`", () => {
    const tasks = [
      task({ id: "a", priority: "urgent" }),
      task({ id: "b", priority: "low" }),
      task({ id: "c", priority: "urgent" }),
    ];
    const cols = priorityColumns(tasks);
    expect(cols.map((c) => c.key)).toEqual(["low", "normal", "high", "urgent"]);
    expect(cols.find((c) => c.key === "urgent")?.tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(cols.every((c) => c.people === undefined)).toBe(true);
  });
});
