import { describe, it, expect } from "vitest";
import {
  isOverdue, isDueSoon, computeDeptKpis, computeProjectHealth,
  toRailPriority, myDeptTasksToday, myBlockedTasks,
} from "./departments";
import type { PmTask } from "./pm";

const NOW = new Date("2026-07-22T12:00:00Z");

const task = (over: Partial<PmTask>): PmTask => ({
  id: "t", projectId: "p", projectName: "P", title: "T", description: "", status: "todo",
  priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
  startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, dependsOn: [], updatedAt: null,
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
});
