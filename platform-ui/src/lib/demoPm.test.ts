import { describe, it, expect } from "vitest";
import { pmDemo, allTrackerNotifications } from "./demoPm";
import type { PmTask, TrackerSuggestion, Comment } from "./pm";

const T = "co-agency";
function call(method: string, path: string, body?: unknown) {
  const url = new URL(path, "http://demo");
  return pmDemo(method, url.pathname, url.searchParams, body === undefined ? undefined : JSON.stringify(body));
}
const json = <X,>(r: { status: number; json: unknown } | null) => (r as { json: X }).json;

describe("demoPm stateful flow", () => {
  it("creates → adds subtasks → recomputes progress → tracker suggests → confirm applies", () => {
    // create
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Wire footer" }));
    const id = created.id;
    expect(id).toBeTruthy();

    // assign a responsible person so the tracker can notify
    call("PATCH", `/api/${T}/pm/tasks/${id}`, { assignee: { kind: "person", refId: "u-dev", refName: "Made Putra", responsibleId: "u-dev", responsibleName: "Made Putra" } });

    // two subtasks, complete one -> 50%
    call("PATCH", `/api/${T}/pm/tasks/${id}`, { addSubtask: "markup" });
    call("PATCH", `/api/${T}/pm/tasks/${id}`, { addSubtask: "styles" });
    let task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${id}`));
    call("PATCH", `/api/${T}/pm/tasks/${id}`, { toggleSubtask: task.subtasks[0].id });
    task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${id}`));
    expect(task.progress).toBe(50);
    expect(task.status).toBe("todo");

    // run tracker -> at least a status suggestion (todo -> in_progress), an AI comment, a notification
    call("POST", `/api/${T}/pm/tasks/${id}/tracker/run`, {});
    const suggestions = json<TrackerSuggestion[]>(call("GET", `/api/${T}/pm/tasks/${id}/suggestions`));
    const statusSugg = suggestions.find((s) => s.kind === "status");
    expect(statusSugg?.proposed).toBe("in_progress");
    expect(statusSugg?.status).toBe("pending");

    const comments = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=${id}`));
    expect(comments.some((c) => c.ai)).toBe(true);
    expect(allTrackerNotifications().some((n) => n.payload.title.includes("Wire footer"))).toBe(true);

    // confirm the status suggestion -> task moves to in_progress
    call("POST", `/api/${T}/pm/suggestions/${statusSugg!.id}/confirm`, {});
    task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${id}`));
    expect(task.status).toBe("in_progress");
    const after = json<TrackerSuggestion[]>(call("GET", `/api/${T}/pm/tasks/${id}/suggestions`));
    expect(after.find((s) => s.id === statusSugg!.id)?.status).toBe("applied");
  });

  it("moving a task changes its column via groupByStatus input", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Move me" }));
    call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { status: "blocked" });
    const task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${created.id}`));
    expect(task.status).toBe("blocked");
  });

  it("adds/removes a dependency and logs time (bumping loggedMinutes)", () => {
    const a = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Dep A" }));
    const b = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Dep B" }));

    call("PATCH", `/api/${T}/pm/tasks/${b.id}`, { addDependency: a.id });
    let task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${b.id}`));
    expect(task.dependsOn).toContain(a.id);

    call("PATCH", `/api/${T}/pm/tasks/${b.id}`, { removeDependency: a.id });
    task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${b.id}`));
    expect(task.dependsOn).not.toContain(a.id);

    call("POST", `/api/${T}/pm/tasks/${b.id}/time`, { minutes: 90, billable: true, spentOn: "2026-07-16", userId: "u-dev" });
    call("POST", `/api/${T}/pm/tasks/${b.id}/time`, { minutes: 30, billable: false, spentOn: "2026-07-16", userId: "u-dev" });
    task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${b.id}`));
    expect(task.loggedMinutes).toBe(120);
    const logs = json<unknown[]>(call("GET", `/api/${T}/pm/tasks/${b.id}/time`));
    expect(logs).toHaveLength(2);
  });

  it("returns null for non-PM paths", () => {
    expect(call("GET", `/api/${T}/projects`)).toBeNull();
  });
});
