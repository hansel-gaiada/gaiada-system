import { describe, it, expect } from "vitest";
import { DEFAULT_ROUTE_BY_KIND, linkedArtifactHref, sortQueue, suggestedRoute, type ChangeRequestRow, type CrStatus } from "./webdevChangeRequests";

function row(over: Partial<ChangeRequestRow> & { id: string; status: CrStatus; createdAt: string }): ChangeRequestRow {
  return {
    clientId: null, clientName: null, projectId: null, projectName: null,
    source: "portal", kind: "feature", title: "t", route: null,
    pipelineRunId: null, pmTaskId: null, requestedBy: null, requestedByName: null,
    triagedBy: null, triagedByName: null, triagedAt: null, declinedReason: null,
    updatedAt: over.createdAt,
    ...over,
  };
}

describe("sortQueue", () => {
  it("puts every 'new' row before any other status, preserving each half's given order", () => {
    const rows = [
      row({ id: "declined-1", status: "declined", createdAt: "2026-08-01T00:00:00Z" }),
      row({ id: "new-1", status: "new", createdAt: "2026-08-03T00:00:00Z" }),
      row({ id: "in-progress-1", status: "in_progress", createdAt: "2026-08-02T00:00:00Z" }),
      row({ id: "new-2", status: "new", createdAt: "2026-08-04T00:00:00Z" }),
    ];
    const sorted = sortQueue(rows);
    expect(sorted.map((r) => r.id)).toEqual(["new-1", "new-2", "declined-1", "in-progress-1"]);
  });

  it("is a no-op on an all-new or all-other list", () => {
    const allNew = [row({ id: "a", status: "new", createdAt: "2026-08-01T00:00:00Z" }), row({ id: "b", status: "new", createdAt: "2026-08-02T00:00:00Z" })];
    expect(sortQueue(allNew).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("handles an empty list", () => {
    expect(sortQueue([])).toEqual([]);
  });
});

describe("suggestedRoute / DEFAULT_ROUTE_BY_KIND — §2.3's table, verbatim", () => {
  it("matches the design doc's routing table exactly", () => {
    expect(DEFAULT_ROUTE_BY_KIND).toEqual({
      content: "pm_task",
      design: "mini_run",
      feature: "mini_run",
      bug: "pm_task",
    });
  });

  it("suggestedRoute reads straight from the table (a suggestion, not a forced value)", () => {
    expect(suggestedRoute("content")).toBe("pm_task");
    expect(suggestedRoute("design")).toBe("mini_run");
    expect(suggestedRoute("feature")).toBe("mini_run");
    expect(suggestedRoute("bug")).toBe("pm_task");
  });
});

describe("linkedArtifactHref", () => {
  it("links to the pipeline run for a mini_run conversion", () => {
    expect(linkedArtifactHref({ route: "mini_run", pipelineRunId: "run-1", pmTaskId: null })).toBe("/pipeline/run-1");
  });
  it("links to the task for a pm_task conversion", () => {
    expect(linkedArtifactHref({ route: "pm_task", pipelineRunId: null, pmTaskId: "task-1" })).toBe("/tasks/task-1");
  });
  it("returns null when nothing is spawned yet (new/declined rows)", () => {
    expect(linkedArtifactHref({ route: null, pipelineRunId: null, pmTaskId: null })).toBeNull();
  });
});
