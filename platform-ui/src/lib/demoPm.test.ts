import { describe, it, expect } from "vitest";
import { pmDemo, allTrackerNotifications, synthBurndownSeries } from "./demoPm";
import type { PmTask, PmProject, ProjectStatus, TrackerSuggestion, Comment, BurndownPoint, Template, ProjectDoc, DocVersion, DocVersionFull } from "./pm";

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

// ---- TR-32 (backend TR-02) — task contributors ----
describe("demoPm contributors", () => {
  it("adds a contributor idempotently, then removes them", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Contrib task" }));
    let task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${created.id}`));
    expect(task.contributors).toEqual([]); // seeded present-but-empty, never omitted, in DEMO_MODE

    call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { addContributor: "u-dev" });
    call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { addContributor: "u-dev" }); // idempotent, no dup row
    task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${created.id}`));
    expect(task.contributors).toEqual([{ userId: "u-dev", name: "Made Putra" }]);

    call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { removeContributor: "u-dev" });
    task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${created.id}`));
    expect(task.contributors).toEqual([]);
  });

  it("ignores an unknown user id (mirrors the backend's active-member check)", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Contrib guard" }));
    call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { addContributor: "not-a-real-user" });
    const task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${created.id}`));
    expect(task.contributors).toEqual([]);
  });

  it("does NOT copy contributors on duplicate (matches pm.controller.ts)", () => {
    const orig = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Contrib source" }));
    call("PATCH", `/api/${T}/pm/tasks/${orig.id}`, { addContributor: "u-dev" });
    const dup = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks/${orig.id}/duplicate`, {}));
    const dupTask = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${dup.id}`));
    expect(dupTask.contributors).toEqual([]);
  });
});

// ---- P2-02 tags — per-project registry ----
describe("demoPm tags", () => {
  it("creates, lists, and renames a tag scoped to its project", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/tags`, { label: "Design", color: "moss" }));
    expect(created.id).toBeTruthy();
    const list = json<{ id: string; label: string; color: string }[]>(call("GET", `/api/${T}/pm/projects/p-web-1/tags`));
    expect(list.some((t) => t.id === created.id && t.label === "Design" && t.color === "moss")).toBe(true);

    call("PATCH", `/api/${T}/pm/projects/p-web-1/tags/${created.id}`, { label: "Design system", color: "dust" });
    const after = json<{ id: string; label: string; color: string }[]>(call("GET", `/api/${T}/pm/projects/p-web-1/tags`));
    const tg = after.find((t) => t.id === created.id);
    expect(tg?.label).toBe("Design system");
    expect(tg?.color).toBe("dust");
  });

  it("rejects a blank label and an invalid color", () => {
    const blank = call("POST", `/api/${T}/pm/projects/p-web-1/tags`, { label: "  ", color: "moss" });
    expect(blank?.status).toBe(400);
  });

  it("a project's tag list never includes another project's tags", () => {
    call("POST", `/api/${T}/pm/projects/p-web-1/tags`, { label: "Only web", color: "slate" });
    const seoList = json<{ label: string }[]>(call("GET", `/api/${T}/pm/projects/p-seo-1/tags`));
    expect(seoList.some((t) => t.label === "Only web")).toBe(false);
  });

  it("409s a guarded delete when the tag is in use, then force-deletes and strips it off the task", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/tags`, { label: "In use", color: "clay" }));
    const task = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Tagged task" }));
    call("PATCH", `/api/${T}/pm/tasks/${task.id}`, { tags: [created.id] });

    const blocked = call("DELETE", `/api/${T}/pm/projects/p-web-1/tags/${created.id}`);
    expect(blocked?.status).toBe(409);
    expect((blocked?.json as { inUse?: boolean }).inUse).toBe(true);

    const forced = call("DELETE", `/api/${T}/pm/projects/p-web-1/tags/${created.id}?force=1`);
    expect(forced?.status).toBe(200);

    const list = json<{ id: string }[]>(call("GET", `/api/${T}/pm/projects/p-web-1/tags`));
    expect(list.some((t) => t.id === created.id)).toBe(false);
    const reloaded = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${task.id}`));
    expect(reloaded.tags).not.toContain(created.id);
  });

  it("deletes cleanly (no 409) when the tag isn't attached to any task", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/tags`, { label: "Unused", color: "ink" }));
    const deleted = call("DELETE", `/api/${T}/pm/projects/p-web-1/tags/${created.id}`);
    expect(deleted?.status).toBe(200);
  });

  it("commits a task's tags when every id belongs to its own project's registry", () => {
    const tg = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/tags`, { label: "Backend", color: "slate" }));
    const task = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Own-project tags" }));
    const patched = call("PATCH", `/api/${T}/pm/tasks/${task.id}`, { tags: [tg.id] });
    expect(patched?.status).toBe(200);
    const reloaded = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${task.id}`));
    expect(reloaded.tags).toEqual([tg.id]);
  });

  it("rejects a task PATCH carrying a tag id from a DIFFERENT project's registry", () => {
    const foreignTag = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-seo-1/tags`, { label: "SEO-only", color: "olive" }));
    const task = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Cross-project attempt" }));
    const rejected = call("PATCH", `/api/${T}/pm/tasks/${task.id}`, { tags: [foreignTag.id] });
    expect(rejected?.status).toBe(400);
    const reloaded = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${task.id}`));
    expect(reloaded.tags).toEqual([]); // rejected PATCH must not have applied
  });
});

// ---- P2-05 custom statuses — per-project registry ----
describe("demoPm custom statuses", () => {
  const P = "p-status-demo"; // fresh project so its registry starts empty (synth defaults)

  it("synthesizes the legacy 4 for a project with no rows, and on the PmProject", () => {
    const rows = json<ProjectStatus[]>(call("GET", `/api/${T}/pm/projects/${P}/statuses`));
    expect(rows.map((s) => s.id)).toEqual(["todo", "in_progress", "blocked", "done"]);
    expect(rows.find((s) => s.id === "done")?.isDone).toBe(true);
    expect(rows.find((s) => s.id === "blocked")?.isBlocked).toBe(true);
    const proj = json<PmProject>(call("GET", `/api/${T}/pm/projects/${P}`));
    expect(proj.statuses.map((s) => s.id)).toEqual(["todo", "in_progress", "blocked", "done"]);
  });

  it("adds a 5th status (materializing the defaults first) and appends it in position", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/${P}/statuses`, { label: "Review", color: "#6E5A43", isDone: false, isBlocked: false }));
    expect(created.id).toBeTruthy();
    const rows = json<ProjectStatus[]>(call("GET", `/api/${T}/pm/projects/${P}/statuses`));
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)?.label).toBe("Review");
    expect(rows.at(-1)?.position).toBe(4);
  });

  it("renames + reflags a status (Done→Shipped stays isDone); a task recomputes to it at 100%", () => {
    call("PATCH", `/api/${T}/pm/projects/${P}/statuses/done`, { label: "Shipped" });
    const rows = json<ProjectStatus[]>(call("GET", `/api/${T}/pm/projects/${P}/statuses`));
    const shipped = rows.find((s) => s.id === "done");
    expect(shipped?.label).toBe("Shipped");
    expect(shipped?.isDone).toBe(true);
    // a task in this project driven to 100% lands in the isDone status (id "done", now "Shipped")
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: P, title: "Finish me" }));
    call("PATCH", `/api/${T}/pm/tasks/${t.id}`, { progress: 100 });
    const reloaded = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${t.id}`));
    expect(reloaded.status).toBe("done");
  });

  it("guards delete of an in-use status (400 { inUse }) then reassigns via ?moveTo", () => {
    const review = json<ProjectStatus[]>(call("GET", `/api/${T}/pm/projects/${P}/statuses`)).find((s) => s.label === "Review")!;
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: P, title: "In review" }));
    call("PATCH", `/api/${T}/pm/tasks/${t.id}`, { status: review.id });

    const blocked = call("DELETE", `/api/${T}/pm/projects/${P}/statuses/${review.id}`);
    expect(blocked?.status).toBe(400);
    expect((blocked?.json as { inUse?: number }).inUse).toBe(1);

    const moved = call("DELETE", `/api/${T}/pm/projects/${P}/statuses/${review.id}?moveTo=todo`);
    expect(moved?.status).toBe(200);
    const reloaded = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${t.id}`));
    expect(reloaded.status).toBe("todo"); // reassigned, not orphaned
    expect(json<ProjectStatus[]>(call("GET", `/api/${T}/pm/projects/${P}/statuses`)).some((s) => s.id === review.id)).toBe(false);
  });

  it("reorders via position PATCH", () => {
    call("PATCH", `/api/${T}/pm/projects/${P}/statuses/in_progress`, { position: 0 });
    call("PATCH", `/api/${T}/pm/projects/${P}/statuses/todo`, { position: 1 });
    const rows = json<ProjectStatus[]>(call("GET", `/api/${T}/pm/projects/${P}/statuses`));
    expect(rows[0].id).toBe("in_progress");
    expect(rows[1].id).toBe("todo");
  });
});

// ---- P2-06 recurring tasks (design spec §8) ----
describe("demoPm recurring tasks", () => {
  it("completing a recurring task spawns exactly one next occurrence, shifted by freq", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, {
      projectId: "p-web-1", title: "Weekly report", dueDate: "2026-07-16", recurrence: { freq: "weekly" },
    }));
    const patch = json<{ ok: boolean; spawned: { id: string; dueDate: string } | null }>(
      call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { status: "done" }),
    );
    expect(patch.spawned).not.toBeNull();
    expect(patch.spawned!.dueDate).toBe("2026-07-23");

    const child = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${patch.spawned!.id}`));
    expect(child.title).toBe("Weekly report");
    expect(child.status).toBe("todo"); // first non-done status
    expect(child.progress).toBe(0);
    expect(child.recurrence).toEqual({ freq: "weekly" });
  });

  it("re-completing an already-done recurring task does NOT double-spawn (idempotency)", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, {
      projectId: "p-web-1", title: "Standup notes", dueDate: "2026-07-16", recurrence: { freq: "daily" },
    }));
    const first = json<{ spawned: { id: string } | null }>(call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { status: "done" }));
    expect(first.spawned).not.toBeNull();

    // re-PATCHing the same completion (not-done -> done edge no longer fires: already done)
    const second = json<{ spawned: { id: string } | null }>(call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { status: "done" }));
    expect(second.spawned).toBeNull();

    const all = json<PmTask[]>(call("GET", `/api/${T}/pm/projects/p-web-1/tasks`));
    const children = all.filter((t) => t.title === "Standup notes" && t.id !== created.id);
    expect(children).toHaveLength(1); // exactly one child, never two
  });

  it("respects `until`: no spawn once the next occurrence would land after it", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, {
      projectId: "p-web-1", title: "Last one", dueDate: "2026-07-30", recurrence: { freq: "weekly", until: "2026-08-01" },
    }));
    const patch = json<{ spawned: { id: string } | null }>(call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { status: "done" }));
    expect(patch.spawned).toBeNull(); // 2026-07-30 + 7d = 2026-08-06, past the 2026-08-01 until
  });

  it("a non-recurring task's completion never spawns anything", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "One-off", dueDate: "2026-07-16" }));
    const patch = json<{ spawned: { id: string } | null }>(call("PATCH", `/api/${T}/pm/tasks/${created.id}`, { status: "done" }));
    expect(patch.spawned).toBeNull();
  });
});

// ---- P2-08 burndown (design spec §4 phase-2) ----
describe("demoPm burndown", () => {
  // A fresh project, isolated from every other describe block's task mutations (same isolation
  // reasoning as "p-status-demo" above) — this block builds its own known open/done counts.
  const P = "p-burndown-demo";

  it("synthesizes a declining series ending at the project's CURRENT real open/done/avgProgress", () => {
    const a = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: P, title: "A" }));
    json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: P, title: "B" }));
    call("PATCH", `/api/${T}/pm/tasks/${a.id}`, { status: "done" });
    // now: 1 done ("A"), 1 open ("B"), total 2.

    const series = synthBurndownSeries(P, 10, "2026-07-16");
    expect(series).toHaveLength(10);
    expect(series[0].date).toBe("2026-07-07"); // 9 days before the end date
    expect(series.at(-1)?.date).toBe("2026-07-16");
    const last = series.at(-1)!;
    expect(last.done).toBe(1);
    expect(last.open).toBe(1);
    // the series starts at "everything open, nothing done" (the classic burndown shape).
    expect(series[0].done).toBe(0);
    expect(series[0].open).toBe(2); // total tasks, all open at series-start
  });

  it("dates strictly increase day-by-day with no gaps", () => {
    const series = synthBurndownSeries(P, 5, "2026-07-16");
    const dates = series.map((pt) => pt.date);
    expect(dates).toEqual(["2026-07-12", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"]);
  });

  it("a project with no tasks at all burns down to nothing -> []", () => {
    expect(synthBurndownSeries("p-burndown-demo-empty", 10, "2026-07-16")).toEqual([]);
  });

  it("the /burndown route mirrors the real backend's shape and its from/to range filter", () => {
    const all = json<BurndownPoint[]>(call("GET", `/api/${T}/pm/projects/${P}/burndown`));
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]).toHaveProperty("date");
    expect(all[0]).toHaveProperty("open");
    expect(all[0]).toHaveProperty("done");
    expect(all[0]).toHaveProperty("avgProgress");

    const ranged = json<BurndownPoint[]>(call("GET", `/api/${T}/pm/projects/${P}/burndown?from=2026-07-15&to=2026-07-16`));
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged.every((pt) => pt.date >= "2026-07-15" && pt.date <= "2026-07-16")).toBe(true);
  });

  it("the /burndown route returns [] (never an error) for an out-of-range window or a taskless project", () => {
    const outOfRange = call("GET", `/api/${T}/pm/projects/${P}/burndown?from=2099-01-01&to=2099-01-02`);
    expect(outOfRange?.status).toBe(200);
    expect(outOfRange?.json).toEqual([]);

    const noProject = call("GET", `/api/${T}/pm/projects/p-does-not-exist/burndown`);
    expect(noProject?.status).toBe(200);
    expect(noProject?.json).toEqual([]);
  });
});

// ---- P3-03 task templates + duplicate ----
describe("demoPm task templates", () => {
  it("creates, lists (scoped by kind), renames, and deletes a task template", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/templates`, {
      kind: "task", title: "Bug triage", description: "Reproduce, fix, retest.", priority: "high",
      estimateMinutes: 90, subtasks: ["Reproduce", "Fix", "Retest"], tagLabels: ["Bug"],
    }));
    expect(created.id).toBeTruthy();

    const list = json<Template[]>(call("GET", `/api/${T}/pm/templates?kind=task`));
    const tpl = list.find((t) => t.id === created.id)!;
    expect(tpl.title).toBe("Bug triage");
    expect(tpl.subtasks).toEqual(["Reproduce", "Fix", "Retest"]);
    expect(tpl.tagLabels).toEqual(["Bug"]);
    expect(tpl.estimateMinutes).toBe(90);

    call("PATCH", `/api/${T}/pm/templates/${created.id}`, { title: "Bug triage — renamed" });
    const renamed = json<Template>(call("GET", `/api/${T}/pm/templates/${created.id}`));
    expect(renamed.title).toBe("Bug triage — renamed");

    const deleted = call("DELETE", `/api/${T}/pm/templates/${created.id}`);
    expect(deleted?.status).toBe(200);
    const afterDelete = json<Template[]>(call("GET", `/api/${T}/pm/templates?kind=task`));
    expect(afterDelete.some((t) => t.id === created.id)).toBe(false);
  });

  it("rejects a blank template title", () => {
    const blank = call("POST", `/api/${T}/pm/templates`, { kind: "task", title: "   " });
    expect(blank?.status).toBe(400);
  });

  it("creating a task carries subtask titles + estimateMinutes + only its OWN project's valid tag ids", () => {
    const tg = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/tags`, { label: "From template", color: "olive" }));
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, {
      projectId: "p-web-1", title: "From a template", estimateMinutes: 120,
      subtasks: ["Step one", "Step two"], tags: [tg.id],
    }));
    const task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${created.id}`));
    expect(task.subtasks.map((s) => s.title)).toEqual(["Step one", "Step two"]);
    expect(task.subtasks.every((s) => !s.done)).toBe(true);
    expect(task.estimateMinutes).toBe(120);
    expect(task.tags).toEqual([tg.id]);
    // progress derives from the (all-incomplete) subtasks, not a bare 0 default
    expect(task.progress).toBe(0);
  });

  it("silently drops a tag id from a different project on create (never a 400 — same drop rule as resolveTags)", () => {
    const foreignTag = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-seo-1/tags`, { label: "SEO tag", color: "slate" }));
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Cross-project create", tags: [foreignTag.id] }));
    const task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${created.id}`));
    expect(task.tags).toEqual([]);
  });
});

describe("demoPm task duplicate", () => {
  it("clones a task into the same project, reset to the first status and 0% progress, subtasks unstarted", () => {
    const orig = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Original task" }));
    call("PATCH", `/api/${T}/pm/tasks/${orig.id}`, { addSubtask: "One" });
    call("PATCH", `/api/${T}/pm/tasks/${orig.id}`, { addSubtask: "Two" });
    let task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${orig.id}`));
    call("PATCH", `/api/${T}/pm/tasks/${orig.id}`, { toggleSubtask: task.subtasks[0].id });
    call("PATCH", `/api/${T}/pm/tasks/${orig.id}`, { status: "blocked" });
    task = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${orig.id}`));
    expect(task.status).toBe("blocked");
    expect(task.progress).toBe(50);

    const dup = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks/${orig.id}/duplicate`));
    expect(dup.id).toBeTruthy();
    expect(dup.id).not.toBe(orig.id);

    const copy = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${dup.id}`));
    expect(copy.title).toBe("Original task (copy)");
    expect(copy.projectId).toBe("p-web-1");
    expect(copy.status).toBe("todo"); // reset to the first status
    expect(copy.progress).toBe(0); // reset, not carried over from the 50% original
    expect(copy.subtasks).toHaveLength(2);
    expect(copy.subtasks.every((s) => !s.done)).toBe(true); // cloned unstarted
    expect(copy.subtasks.map((s) => s.id)).not.toEqual(task.subtasks.map((s) => s.id)); // fresh ids, not shared

    // the original is untouched by duplicating it
    const reloadedOrig = json<PmTask>(call("GET", `/api/${T}/pm/tasks/${orig.id}`));
    expect(reloadedOrig.status).toBe("blocked");
    expect(reloadedOrig.progress).toBe(50);
  });

  it("404s duplicating a task that doesn't exist", () => {
    const r = call("POST", `/api/${T}/pm/tasks/does-not-exist/duplicate`);
    expect(r?.status).toBe(404);
  });
});

// ---- P3-04 project duplicate ----
// ---- P3-09 followers + comment reactions ----
describe("demoPm task followers", () => {
  it("starts unfollowed, follows, and lists the follower back", () => {
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Follow me" }));
    expect(json<{ id: string }[]>(call("GET", `/api/${T}/pm/tasks/${t.id}/followers`))).toEqual([]);

    call("POST", `/api/${T}/pm/tasks/${t.id}/follow`);
    const followers = json<{ id: string; name: string }[]>(call("GET", `/api/${T}/pm/tasks/${t.id}/followers`));
    expect(followers).toHaveLength(1);
    expect(followers[0].id).toBe("demo-hansel");
  });

  it("following twice stays idempotent (still exactly one follower row)", () => {
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Follow twice" }));
    call("POST", `/api/${T}/pm/tasks/${t.id}/follow`);
    call("POST", `/api/${T}/pm/tasks/${t.id}/follow`);
    expect(json<{ id: string }[]>(call("GET", `/api/${T}/pm/tasks/${t.id}/followers`))).toHaveLength(1);
  });

  it("unfollowing removes the follower", () => {
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Unfollow me" }));
    call("POST", `/api/${T}/pm/tasks/${t.id}/follow`);
    call("DELETE", `/api/${T}/pm/tasks/${t.id}/follow`);
    expect(json<{ id: string }[]>(call("GET", `/api/${T}/pm/tasks/${t.id}/followers`))).toEqual([]);
  });

  it("following a task then moving its status delivers a notification to the follower", () => {
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "Notify on move" }));
    call("POST", `/api/${T}/pm/tasks/${t.id}/follow`);
    call("PATCH", `/api/${T}/pm/tasks/${t.id}`, { status: "in_progress" });
    expect(allTrackerNotifications().some((n) => n.payload.title.includes("Notify on move"))).toBe(true);
  });

  it("a status PATCH with no follower delivers no follower notification for that task", () => {
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "No followers here" }));
    call("PATCH", `/api/${T}/pm/tasks/${t.id}`, { status: "in_progress" });
    expect(allTrackerNotifications().some((n) => n.payload.title.includes("No followers here"))).toBe(false);
  });
});

describe("demoPm comment reactions", () => {
  it("adds a reaction and reads it back with count:1, mine:true", () => {
    call("POST", `/api/${T}/comments?entityType=task&entityId=t-4`, { body: "Nice work" });
    const before = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=t-4`));
    const c = before[before.length - 1];
    expect(c.reactions ?? []).toEqual([]);

    call("POST", `/api/${T}/comments/${c.id}/reactions`, { emoji: "👍" });
    const after = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=t-4`));
    const reloaded = after.find((x) => x.id === c.id)!;
    expect(reloaded.reactions).toEqual([{ emoji: "👍", count: 1, mine: true }]);
  });

  it("reacting twice with the same emoji is idempotent (still count:1)", () => {
    call("POST", `/api/${T}/comments?entityType=task&entityId=t-4`, { body: "Idempotent test" });
    const list = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=t-4`));
    const c = list[list.length - 1];
    call("POST", `/api/${T}/comments/${c.id}/reactions`, { emoji: "🎉" });
    call("POST", `/api/${T}/comments/${c.id}/reactions`, { emoji: "🎉" });
    const reloaded = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=t-4`)).find((x) => x.id === c.id)!;
    expect(reloaded.reactions).toEqual([{ emoji: "🎉", count: 1, mine: true }]);
  });

  it("removing a reaction drops it off the list entirely once its count hits 0", () => {
    call("POST", `/api/${T}/comments?entityType=task&entityId=t-4`, { body: "Remove test" });
    const list = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=t-4`));
    const c = list[list.length - 1];
    call("POST", `/api/${T}/comments/${c.id}/reactions`, { emoji: "🔥" });
    call("DELETE", `/api/${T}/comments/${c.id}/reactions/🔥`);
    const reloaded = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=t-4`)).find((x) => x.id === c.id)!;
    expect(reloaded.reactions ?? []).toEqual([]);
  });

  it("rejects a reaction emoji outside the closed 8-emoji set", () => {
    call("POST", `/api/${T}/comments?entityType=task&entityId=t-4`, { body: "Bad emoji test" });
    const list = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=t-4`));
    const c = list[list.length - 1];
    const r = call("POST", `/api/${T}/comments/${c.id}/reactions`, { emoji: "😀" });
    expect(r?.status).toBe(400);
  });

  it("an AI Tracker comment can also receive a reaction", () => {
    const t = json<{ id: string }>(call("POST", `/api/${T}/pm/tasks`, { projectId: "p-web-1", title: "AI comment reactions" }));
    call("PATCH", `/api/${T}/pm/tasks/${t.id}`, { assignee: { kind: "person", refId: "u-dev", refName: "Made Putra", responsibleId: "u-dev", responsibleName: "Made Putra" } });
    call("POST", `/api/${T}/pm/tasks/${t.id}/tracker/run`, {});
    const comments = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=${t.id}`));
    const aiComment = comments.find((c) => c.ai)!;
    expect(aiComment).toBeTruthy();
    call("POST", `/api/${T}/comments/${aiComment.id}/reactions`, { emoji: "💡" });
    const reloaded = json<Comment[]>(call("GET", `/api/${T}/comments?entityType=task&entityId=${t.id}`)).find((x) => x.id === aiComment.id)!;
    expect(reloaded.reactions).toEqual([{ emoji: "💡", count: 1, mine: true }]);
  });
});

describe("demoPm project duplicate", () => {
  it("clones a project (tasks, statuses, tags, milestones, docs), resetting tasks to first status and 0% progress unassigned", () => {
    // fetch the original project
    const orig = json<PmProject>(call("GET", `/api/${T}/pm/projects/p-web-1`));
    expect(orig.id).toBe("p-web-1");
    expect(orig.taskCount).toBeGreaterThan(0);
    expect(orig.statuses.length).toBeGreaterThan(0);

    // duplicate it with a custom name
    const dup = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/duplicate`, { name: "Client site redesign (copy)" }));
    expect(dup.id).toBeTruthy();
    expect(dup.id).not.toBe("p-web-1");

    // verify the new project
    const copy = json<PmProject>(call("GET", `/api/${T}/pm/projects/${dup.id}`));
    expect(copy.name).toBe("Client site redesign (copy)");
    expect(copy.status).toBe("active");
    expect(copy.owner).toBeNull(); // owner cleared
    expect(copy.dueDate).toBeNull(); // due date cleared
    expect(copy.taskCount).toBe(orig.taskCount); // same number of tasks
    expect(copy.statuses.map((s) => s.label)).toEqual(orig.statuses.map((s) => s.label)); // same status labels (new ids)

    // verify tasks are reset: first non-done status, 0% progress, unassigned
    const tasks = json<PmTask[]>(call("GET", `/api/${T}/pm/projects/${dup.id}/tasks`));
    const firstNonDone = copy.statuses.find((s) => !s.isDone);
    for (const t of tasks) {
      expect(t.assignee).toBeNull(); // all unassigned
      expect(t.progress).toBe(0); // all reset to 0%
      expect(t.status).toBe(firstNonDone?.id ?? "todo"); // all in first non-done status
    }

    // verify tags exist (with new ids)
    const tags = json<{ id: string; label: string }[]>(call("GET", `/api/${T}/pm/projects/${dup.id}/tags`));
    const origTags = json<{ id: string; label: string }[]>(call("GET", `/api/${T}/pm/projects/p-web-1/tags`));
    expect(tags.map((t) => t.label)).toEqual(origTags.map((t) => t.label)); // same labels, different ids

    // verify milestones exist (with new ids)
    const milestones = json<{ id: string; name: string }[]>(call("GET", `/api/${T}/pm/projects/${dup.id}/milestones`));
    const origMilestones = json<{ id: string; name: string }[]>(call("GET", `/api/${T}/pm/projects/p-web-1/milestones`));
    expect(milestones.map((m) => m.name)).toEqual(origMilestones.map((m) => m.name)); // same names, different ids
  });

  it("rejects a blank name", () => {
    const r = call("POST", `/api/${T}/pm/projects/p-web-1/duplicate`, { name: "   " });
    expect(r?.status).toBe(400);
  });

  it("404s duplicating a project that doesn't exist", () => {
    const r = call("POST", `/api/${T}/pm/projects/does-not-exist/duplicate`, { name: "Whatever" });
    expect(r?.status).toBe(404);
  });
});

// ---- P3-11 doc history + restore + note templates ----
describe("demoPm doc version history", () => {
  it("creates a doc at v1, and lists exactly its one seeded version", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/docs`, { title: "Runbook", body: "Step 1" }));
    const doc = json<ProjectDoc>(call("GET", `/api/${T}/pm/projects/p-web-1/docs/${created.id}`));
    expect(doc.version).toBe(1);

    const versions = json<DocVersion[]>(call("GET", `/api/${T}/pm/docs/${created.id}/versions`));
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].authorName).toBeTruthy();
    // META only — no body on the list route
    expect((versions[0] as unknown as { body?: string }).body).toBeUndefined();
  });

  it("editing a doc twice appends v2 then v3, and a no-op save (unchanged title+body) appends nothing", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/docs`, { title: "Doc A", body: "v1 body" }));
    const docId = created.id;

    call("PATCH", `/api/${T}/pm/projects/p-web-1/docs/${docId}`, { title: "Doc A", body: "v2 body" });
    call("PATCH", `/api/${T}/pm/projects/p-web-1/docs/${docId}`, { title: "Doc A", body: "v3 body" });
    let doc = json<ProjectDoc>(call("GET", `/api/${T}/pm/projects/p-web-1/docs/${docId}`));
    expect(doc.version).toBe(3);
    let versions = json<DocVersion[]>(call("GET", `/api/${T}/pm/docs/${docId}/versions`));
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);

    // no-op save: same title AND body — must NOT append a 4th version
    call("PATCH", `/api/${T}/pm/projects/p-web-1/docs/${docId}`, { title: "Doc A", body: "v3 body" });
    doc = json<ProjectDoc>(call("GET", `/api/${T}/pm/projects/p-web-1/docs/${docId}`));
    expect(doc.version).toBe(3);
    versions = json<DocVersion[]>(call("GET", `/api/${T}/pm/docs/${docId}/versions`));
    expect(versions).toHaveLength(3);
  });

  it("GET on a single version returns the full body (not just meta)", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/docs`, { title: "Doc B", body: "original body" }));
    call("PATCH", `/api/${T}/pm/projects/p-web-1/docs/${created.id}`, { title: "Doc B", body: "edited body" });
    const v1 = json<DocVersionFull>(call("GET", `/api/${T}/pm/docs/${created.id}/versions/1`));
    expect(v1.body).toBe("original body");
    const v2 = json<DocVersionFull>(call("GET", `/api/${T}/pm/docs/${created.id}/versions/2`));
    expect(v2.body).toBe("edited body");
  });

  it("404s a version GET for a version number that doesn't exist", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/docs`, { title: "Doc C", body: "x" }));
    const r = call("GET", `/api/${T}/pm/docs/${created.id}/versions/99`);
    expect(r?.status).toBe(404);
  });

  it("restoring an old version sets the doc back to its content AND appends a brand-new version (nothing rewritten)", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/docs`, { title: "Doc D", body: "v1 content" }));
    const docId = created.id;
    call("PATCH", `/api/${T}/pm/projects/p-web-1/docs/${docId}`, { title: "Doc D", body: "v2 content" });
    call("PATCH", `/api/${T}/pm/projects/p-web-1/docs/${docId}`, { title: "Doc D", body: "v3 content" });
    // list has grown to 3
    expect(json<DocVersion[]>(call("GET", `/api/${T}/pm/docs/${docId}/versions`))).toHaveLength(3);

    const restored = call("POST", `/api/${T}/pm/docs/${docId}/versions/1/restore`);
    expect(restored?.status).toBe(200);

    const doc = json<ProjectDoc>(call("GET", `/api/${T}/pm/projects/p-web-1/docs/${docId}`));
    expect(doc.body).toBe("v1 content"); // doc content is now v1's
    expect(doc.version).toBe(4); // but a NEW version was appended, not a rewrite

    const versions = json<DocVersion[]>(call("GET", `/api/${T}/pm/docs/${docId}/versions`));
    expect(versions).toHaveLength(4); // grew to 4, v1..v3 untouched
    const v1Still = json<DocVersionFull>(call("GET", `/api/${T}/pm/docs/${docId}/versions/1`));
    expect(v1Still.body).toBe("v1 content"); // the original row 1 itself was never rewritten
  });

  it("404s restoring a version that doesn't exist, and restoring on an unknown doc", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/projects/p-web-1/docs`, { title: "Doc E", body: "x" }));
    expect(call("POST", `/api/${T}/pm/docs/${created.id}/versions/99/restore`)?.status).toBe(404);
    expect(call("POST", `/api/${T}/pm/docs/does-not-exist/versions/1/restore`)?.status).toBe(404);
  });
});

describe("demoPm note (doc) templates", () => {
  it("creates a doc template carrying its body, and lists it scoped to kind=doc (not mixed with task templates)", () => {
    const created = json<{ id: string }>(call("POST", `/api/${T}/pm/templates`, { kind: "doc", title: "Sprint retro", body: "## What went well\n\n## What didn't" }));
    expect(created.id).toBeTruthy();

    const docTemplates = json<Template[]>(call("GET", `/api/${T}/pm/templates?kind=doc`));
    const tpl = docTemplates.find((t) => t.id === created.id)!;
    expect(tpl.title).toBe("Sprint retro");
    expect(tpl.body).toBe("## What went well\n\n## What didn't");

    const taskTemplates = json<Template[]>(call("GET", `/api/${T}/pm/templates?kind=task`));
    expect(taskTemplates.some((t) => t.id === created.id)).toBe(false);
  });
});
