import { describe, it, expect } from "vitest";
import { representativeStatusesById, unionTagBreakdown } from "./pmScope-data";
import type { ProjectStatus, PmTask, Tag } from "./pm";

const task = (over: Partial<PmTask>): PmTask => ({
  id: "t", projectId: "p", projectName: "P", title: "T", description: "", status: "todo",
  priority: "normal", progress: 0, assignee: null, subtasks: [], milestoneId: null,
  startDate: null, dueDate: null, estimateMinutes: null, loggedMinutes: 0, dependsOn: [], tags: [],
  customFields: {}, updatedAt: null, recurrence: null,
  projectShortCode: null, seq: null, displayCode: null,
  ...over,
});

describe("representativeStatusesById", () => {
  it("merges a status id shared across projects into ONE entry, ordered by average position", () => {
    const byProject: Record<string, ProjectStatus[]> = {
      "p-1": [
        { id: "todo", label: "ToDo", color: "#8BC34A", isDone: false, isBlocked: false, position: 0 },
        { id: "done", label: "Done", color: "#FFC107", isDone: true, isBlocked: false, position: 1 },
      ],
      // Same shared ladder ids, at DIFFERENT positions (a project that added a custom status
      // in between) — the merge still lands on one row per id, averaged.
      "p-2": [
        { id: "todo", label: "ToDo", color: "#8BC34A", isDone: false, isBlocked: false, position: 0 },
        { id: "custom-1", label: "Client Review", color: "#BA68C8", isDone: false, isBlocked: false, position: 1 },
        { id: "done", label: "Done", color: "#FFC107", isDone: true, isBlocked: false, position: 2 },
      ],
    };
    const merged = representativeStatusesById(byProject);
    // `todo` averages position 0 across both, `custom-1` only exists in p-2 (position 1, average
    // 1), `done` averages (1+2)/2 = 1.5 — so the order is todo, custom-1, done.
    expect(merged.map((s) => s.id)).toEqual(["todo", "custom-1", "done"]);
    // A random per-project custom id is carried through untouched, never dropped or merged with
    // an unrelated status — the whole point of "ids are disjoint by construction" (see the doc on
    // `getTenantFlow`).
    expect(merged.find((s) => s.id === "custom-1")?.label).toBe("Client Review");
    // `position` on the output is a fresh 0..n-1 re-index (the input positions were only used to
    // ORDER the merge, not to survive as literal values).
    expect(merged.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("empty input -> empty output, never throws", () => {
    expect(representativeStatusesById({})).toEqual([]);
  });

  it("a status id appearing in only one project keeps that project's own label/colour/flags", () => {
    const byProject: Record<string, ProjectStatus[]> = {
      "p-1": [{ id: "blocked", label: "Blocked", color: "#FF7043", isDone: false, isBlocked: true, position: 3 }],
    };
    const merged = representativeStatusesById(byProject);
    expect(merged).toEqual([{ id: "blocked", label: "Blocked", color: "#FF7043", isDone: false, isBlocked: true, position: 0 }]);
  });
});

describe("unionTagBreakdown", () => {
  const tagA: Tag = { id: "tag-a-1", label: "Urgent", color: "clay" };
  const tagB: Tag = { id: "tag-b-1", label: "Urgent", color: "slate" }; // same LABEL, different project id
  const tagC: Tag = { id: "tag-c-1", label: "Design", color: "moss" };

  it("merges same-label tags across projects with different ids (D-1) and adds a trailing Untagged row", () => {
    const perProject = [
      { tasks: [task({ id: "t1", tags: ["tag-a-1"] }), task({ id: "t2", tags: [] })], registry: [tagA] },
      { tasks: [task({ id: "t3", tags: ["tag-b-1"] }), task({ id: "t4", tags: ["tag-c-1"] })], registry: [tagB, tagC] },
    ];
    const rows = unionTagBreakdown(perProject);
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    expect(byLabel.get("Urgent")?.count).toBe(2); // t1 + t3, one label despite two distinct ids
    expect(byLabel.get("Design")?.count).toBe(1);
    expect(byLabel.get("Untagged")?.count).toBe(1); // t2
    // Percentages are out of the FULL task count across every project (4), not per-project.
    expect(byLabel.get("Urgent")?.pct).toBe(50);
  });

  it("no registries anywhere -> tagBreakdown's own plain fallback (still counts Untagged)", () => {
    const perProject = [{ tasks: [task({ id: "t1" }), task({ id: "t2" })], registry: [] as Tag[] }];
    const rows = unionTagBreakdown(perProject);
    expect(rows).toEqual([{ tagId: null, label: "Untagged", color: null, count: 2, pct: 100 }]);
  });

  it("empty task list -> [] (caller shows EmptyNote, never a degenerate chart)", () => {
    expect(unionTagBreakdown([])).toEqual([]);
  });
});
