import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  flowSeries, tagBreakdown, timelineFromDates, getFlow,
  type FlowPoint, type ProjectStatus, type PmTask, type Tag,
} from "./pm";

// ---- P3-06 Project Charts: pure helpers ----

const STATUSES: ProjectStatus[] = [
  { id: "todo", label: "To do", color: "var(--status-idle-fg)", isDone: false, isBlocked: false, position: 0 },
  { id: "in_progress", label: "In progress", color: "var(--accent)", isDone: false, isBlocked: false, position: 1 },
  { id: "done", label: "Done", color: "var(--status-ok-fg)", isDone: true, isBlocked: false, position: 2 },
];

const task = (over: Partial<PmTask>): PmTask => ({
  id: "t", projectId: "p", projectName: "P", title: "T", description: "", status: "todo",
  priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
  startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, dependsOn: [], tags: [],
  customFields: {}, updatedAt: null, recurrence: null,
  projectShortCode: null, seq: null, displayCode: null,
  ...over,
});

describe("timelineFromDates", () => {
  it("spans exactly [start, end] with no bars", () => {
    const tl = timelineFromDates("2026-07-01", "2026-07-11");
    expect(tl).toEqual({ start: "2026-07-01", end: "2026-07-11", days: 10, bars: [] });
  });
  it("never returns fewer than 1 day, even for a same-day range", () => {
    expect(timelineFromDates("2026-07-01", "2026-07-01").days).toBe(1);
  });
});

describe("flowSeries", () => {
  it("empty input -> an empty series (caller shows EmptyNote, never a degenerate area)", () => {
    expect(flowSeries([], STATUSES)).toEqual({ dates: [], bands: [], counts: [], stacked: [] });
  });

  it("orders bands by the project's own status POSITION, not the raw points' key order", () => {
    const points: FlowPoint[] = [
      { date: "2026-07-01", counts: { done: 1, todo: 2, in_progress: 0 } },
      { date: "2026-07-02", counts: { done: 1, todo: 1, in_progress: 1 } },
    ];
    const s = flowSeries(points, STATUSES);
    expect(s.bands.map((b) => b.statusId)).toEqual(["todo", "in_progress", "done"]);
    expect(s.bands.map((b) => b.label)).toEqual(["To do", "In progress", "Done"]);
    expect(s.bands.map((b) => b.color)).toEqual(["var(--status-idle-fg)", "var(--accent)", "var(--status-ok-fg)"]);
  });

  it("fills date gaps by carrying the last known snapshot forward", () => {
    const points: FlowPoint[] = [
      { date: "2026-07-01", counts: { todo: 3, in_progress: 0, done: 0 } },
      // 2026-07-02 missing — should carry 2026-07-01's snapshot forward
      { date: "2026-07-03", counts: { todo: 1, in_progress: 1, done: 1 } },
    ];
    const s = flowSeries(points, STATUSES);
    expect(s.dates).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    const todoIdx = s.bands.findIndex((b) => b.statusId === "todo");
    expect(s.counts[todoIdx]).toEqual([3, 3, 1]); // day 2 carries day 1's count forward
  });

  it("stacked[i][d] is the cumulative sum of bands[0..i] on date d", () => {
    const points: FlowPoint[] = [{ date: "2026-07-01", counts: { todo: 2, in_progress: 3, done: 1 } }];
    const s = flowSeries(points, STATUSES);
    expect(s.stacked[0][0]).toBe(2);     // todo alone
    expect(s.stacked[1][0]).toBe(5);     // todo + in_progress
    expect(s.stacked[2][0]).toBe(6);     // todo + in_progress + done (= total tasks that day)
  });
});

describe("tagBreakdown", () => {
  const registry: Tag[] = [
    { id: "tg-a", label: "Design", color: "bronze" },
    { id: "tg-b", label: "Urgent", color: "clay" },
  ];

  it("empty project -> []", () => {
    expect(tagBreakdown([], registry)).toEqual([]);
  });

  it("ranks desc by count, computes % of total tasks, and appends a trailing Untagged row", () => {
    const tasks = [
      task({ id: "1", tags: ["tg-a"] }),
      task({ id: "2", tags: ["tg-a"] }),
      task({ id: "3", tags: ["tg-b"] }),
      task({ id: "4", tags: [] }),
    ];
    const rows = tagBreakdown(tasks, registry);
    expect(rows.map((r) => r.label)).toEqual(["Design", "Urgent", "Untagged"]);
    expect(rows[0]).toMatchObject({ count: 2, pct: 50 });
    expect(rows[1]).toMatchObject({ count: 1, pct: 25 });
    expect(rows[2]).toMatchObject({ tagId: null, color: null, count: 1, pct: 25 });
  });

  it("a task with several tags counts once toward EACH tag (percentages can sum past 100)", () => {
    const tasks = [task({ id: "1", tags: ["tg-a", "tg-b"] })];
    const rows = tagBreakdown(tasks, registry);
    expect(rows.find((r) => r.label === "Design")?.pct).toBe(100);
    expect(rows.find((r) => r.label === "Urgent")?.pct).toBe(100);
    expect(rows.find((r) => r.label === "Untagged")?.count).toBe(0);
  });

  it("drops stale/foreign tag ids (not in this project's registry) — those tasks count as untagged", () => {
    const tasks = [task({ id: "1", tags: ["tg-ghost"] })];
    const rows = tagBreakdown(tasks, registry);
    expect(rows).toEqual([{ tagId: null, label: "Untagged", color: null, count: 1, pct: 100 }]);
  });

  it("breaks ties by label", () => {
    const tasks = [task({ id: "1", tags: ["tg-b"] }), task({ id: "2", tags: ["tg-a"] })];
    const rows = tagBreakdown(tasks, registry);
    expect(rows.map((r) => r.label)).toEqual(["Design", "Urgent", "Untagged"]);
  });
});

// ---- getFlow reader (DEMO_MODE integration — exercises the real query-string + skipUnavailable
// degrade path through demoPm's /flow route, same pattern as pm.test.ts's getBurndown coverage) ----
describe("getFlow reader", () => {
  const prevDemo = process.env.DEMO_MODE;
  beforeEach(() => { process.env.DEMO_MODE = "1"; });
  afterEach(() => {
    if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo;
  });

  it("returns a multi-day series for a seeded demo project, ending at the fixed demo 'today'", async () => {
    const rows = await getFlow("demo-hansel", "co-agency", "p-web-1");
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.at(-1)?.date).toBe("2026-07-16");
    expect(rows[0].counts).toBeTruthy();
  });

  it("degrades to [] for a project with no tasks at all", async () => {
    const rows = await getFlow("demo-hansel", "co-agency", "p-totally-unknown");
    expect(rows).toEqual([]);
  });
});
