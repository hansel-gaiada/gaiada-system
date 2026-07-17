import { describe, it, expect } from "vitest";
import {
  taskProgressFromSubtasks, projectProgress, resolveResponsible, groupByStatus, suggestFromTask,
  computeTimeline, wouldCreateCycle, openDependencies, timeSummary,
  type PmTask, type Assignee, type Subtask, type TimeLog,
} from "./pm";

const sub = (done: boolean): Subtask => ({ id: Math.random().toString(36), title: "s", done });
const task = (over: Partial<PmTask>): PmTask => ({
  id: "t", projectId: "p", projectName: "P", title: "T", description: "", status: "todo",
  priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
  startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, dependsOn: [], updatedAt: null,
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
  it("buckets tasks into the four ordered columns", () => {
    const cols = groupByStatus([task({ id: "a", status: "todo" }), task({ id: "b", status: "done" }), task({ id: "c", status: "todo" })]);
    expect(cols.map((c) => c.status)).toEqual(["todo", "in_progress", "blocked", "done"]);
    expect(cols[0].tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(cols[3].tasks.map((t) => t.id)).toEqual(["b"]);
  });
});

describe("suggestFromTask", () => {
  it("derives progress from subtasks and moves todo→in_progress", () => {
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
