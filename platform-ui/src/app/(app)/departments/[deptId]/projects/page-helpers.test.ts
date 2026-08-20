import { describe, it, expect } from "vitest";
import { tallyProjectTasks, taskDateEnvelope, daysPast, targetNote } from "./page-helpers";
import type { ProjectStatus } from "@/lib/pm";

// P4-H3 inherited-bug fix (found during P4-G5, deliberately not fixed then): this page's
// "Tasks here"/"Done" counts used a literal `t.status === "done"` while the Urgency column next
// to it already resolved done-ness via `isDoneStatus` against each task's OWN project's status
// registry. On a project with a CUSTOM done status (renamed or additional, P2-04) the two columns
// disagreed on the same row. `tallyProjectTasks` is the isolated, exported tally so this is
// testable without rendering the server component.
const CUSTOM_STATUSES: ProjectStatus[] = [
  { id: "backlog", label: "Backlog", position: 0, isDone: false, isBlocked: false, color: "#888888" },
  { id: "in_progress", label: "In progress", position: 1, isDone: false, isBlocked: false, color: "#888888" },
  // Renamed done status — id is "shipped", not the legacy literal "done".
  { id: "shipped", label: "Shipped", position: 2, isDone: true, isBlocked: false, color: "#888888" },
];

describe("tallyProjectTasks", () => {
  it("counts a custom-status project's done tasks correctly, not by the literal id \"done\"", () => {
    const tasks = [
      { projectId: "p1", status: "backlog" },
      { projectId: "p1", status: "in_progress" },
      { projectId: "p1", status: "shipped" }, // done under the CUSTOM registry, not the literal "done"
      { projectId: "p1", status: "shipped" },
    ];
    const byProject = tallyProjectTasks(tasks, { p1: CUSTOM_STATUSES });
    expect(byProject.p1).toEqual({ total: 4, done: 2 });
  });

  it("still counts correctly against the legacy default registry (no custom statuses)", () => {
    const tasks = [
      { projectId: "p2", status: "todo" },
      { projectId: "p2", status: "done" },
    ];
    const byProject = tallyProjectTasks(tasks, {});
    expect(byProject.p2).toEqual({ total: 2, done: 1 });
  });

  it("resolves multiple projects independently, each against its OWN registry", () => {
    const tasks = [
      { projectId: "p1", status: "shipped" }, // done only under p1's custom registry
      { projectId: "p2", status: "shipped" }, // NOT done under p2's default (legacy) registry
    ];
    const byProject = tallyProjectTasks(tasks, { p1: CUSTOM_STATUSES });
    expect(byProject.p1).toEqual({ total: 1, done: 1 });
    expect(byProject.p2).toEqual({ total: 1, done: 0 });
  });
});

describe("taskDateEnvelope", () => {
  it("returns the min start / max due across the given tasks", () => {
    const env = taskDateEnvelope([
      { startDate: "2026-08-10", dueDate: "2026-08-15" },
      { startDate: "2026-08-01", dueDate: "2026-08-20" },
      { startDate: null, dueDate: "2026-08-05" },
    ]);
    expect(env).toEqual({ start: "2026-08-01", end: "2026-08-20" });
  });

  it("returns nulls for an empty or fully-undated task list", () => {
    expect(taskDateEnvelope([])).toEqual({ start: null, end: null });
    expect(taskDateEnvelope([{ startDate: null, dueDate: null }])).toEqual({ start: null, end: null });
  });
});

describe("daysPast / targetNote", () => {
  const TODAY = "2026-08-19";

  it("counts whole days, positive into the past", () => {
    expect(daysPast("2026-07-20", TODAY)).toBe(30);
    expect(daysPast("2026-08-19", TODAY)).toBe(0);
    expect(daysPast("2026-08-28", TODAY)).toBe(-9);
  });

  it("returns null for a missing or unparseable date rather than 0", () => {
    // "no target" and "due today" are different facts, and 0 would render as "today".
    expect(daysPast(null, TODAY)).toBeNull();
    expect(daysPast(undefined, TODAY)).toBeNull();
    expect(daysPast("not-a-date", TODAY)).toBeNull();
  });

  it("tolerates a full timestamp on either side", () => {
    expect(daysPast("2026-07-20T09:00:00Z", TODAY)).toBe(30);
    expect(daysPast("2026-07-20", "2026-08-19T23:30:00Z")).toBe(30);
  });

  it("words the note and flags only the late side", () => {
    expect(targetNote("2026-07-20", TODAY)).toEqual({ text: "30d past", late: true });
    expect(targetNote("2026-08-19", TODAY)).toEqual({ text: "today", late: false });
    expect(targetNote("2026-08-28", TODAY)).toEqual({ text: "in 9d", late: false });
    expect(targetNote(null, TODAY)).toBeNull();
  });
});
