import "server-only";
// Stateful in-memory PM store for DEMO_MODE, so the whole Repsona-style flow
// (create / drag / progress / assign / comment / AI-tracker / confirm) actually
// works and persists within a running dev server (module-level state survives
// across requests in one process; resets on restart). Routed to from
// demoFixtures.getDemoResponse for every /api/:t/pm/* path + task comments.
// Not part of any backend contract — the real backend implements /api/:t/pm/*
// per lib/pm.ts. demoPm must NOT import demoFixtures (one-way dependency).
import {
  taskProgressFromSubtasks,
  suggestFromTask,
  STATUS_LABEL,
  type PmTask,
  type PmProject,
  type Milestone,
  type ProjectDoc,
  type TrackerSuggestion,
  type Comment,
  type Assignee,
  type TaskStatus,
  type Priority,
  type Subtask,
  type TimeLog,
} from "./pm";

type Result = { status: number; json: unknown };

// A fixed "now" base so demo timestamps are stable-ish without Date.now() churn
// across module reloads; each mutation bumps a counter for ordering + unique ids.
let seq = 100;
const nextId = (p: string) => `${p}-${++seq}`;
const stamp = () => `2026-07-16T${String(8 + (seq % 12)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}:00Z`;

const MEMBERS: Record<string, string> = {
  "demo-hansel": "Clement Hansel",
  "u-pm": "Dewi Santoso",
  "u-dev": "Made Putra",
  "u-finance": "Rina Wibawa",
};
const person = (id: string): Assignee => ({ kind: "person", refId: id, refName: MEMBERS[id] ?? id, responsibleId: id, responsibleName: MEMBERS[id] ?? id });
const unit = (kind: "department" | "division", refId: string, refName: string, responsibleId: string): Assignee => ({
  kind, refId, refName, responsibleId, responsibleName: MEMBERS[responsibleId] ?? responsibleId,
});
const sub = (id: string, title: string, done: boolean): Subtask => ({ id, title, done });

interface ProjectMeta { id: string; name: string; status: string; owner: Assignee | null; dueDate: string | null }

// ---- seed state ----
const projects: ProjectMeta[] = [
  { id: "p-web-1", name: "Client site redesign", status: "active", owner: person("u-pm"), dueDate: "2026-07-20" },
  { id: "p-seo-1", name: "SEO audit — Q3", status: "active", owner: person("u-pm"), dueDate: "2026-08-01" },
  { id: "p-int-1", name: "Internal brand refresh", status: "completed", owner: person("demo-hansel"), dueDate: "2026-06-01" },
];

let tasks: PmTask[] = [
  mkTask("t-4", "p-web-1", "Wire homepage hero", "in_progress", "high", person("u-dev"), [sub("s1", "Hero layout", true), sub("s2", "Responsive pass", true), sub("s3", "Final copy", false)], "m-1", "2026-07-08", "Build the homepage hero section from the approved mockup.", "2026-07-02", 480, ["t-web-a"]),
  mkTask("t-5", "p-web-1", "QA checkout flow", "blocked", "urgent", person("u-dev"), [sub("s1", "Repro payment bug", true), sub("s2", "Fix + retest", false)], "m-2", "2026-07-09", "End-to-end QA of the checkout, blocked on the payment gateway sandbox.", "2026-07-07", 360, ["t-4"]),
  mkTask("t-web-a", "p-web-1", "Design homepage mockup", "done", "normal", person("u-pm"), [sub("s1", "Wireframe", true), sub("s2", "Hi-fi", true)], "m-1", "2026-06-28", "Deliver the hi-fi homepage mockup for sign-off.", "2026-06-24", 600, []),
  mkTask("t-web-b", "p-web-1", "Set up analytics", "todo", "normal", unit("division", "dept-1-div-1", "Frontend", "u-dev"), [], "m-2", "2026-07-18", "Instrument the site with product analytics and consent.", "2026-07-15", 240, []),
  mkTask("t-web-c", "p-web-1", "Content migration", "todo", "low", null, [], null, "2026-07-19", "Migrate legacy CMS content into the new site.", "2026-07-16", 300, []),
  mkTask("t-6", "p-seo-1", "Keyword gap analysis", "todo", "normal", person("u-pm"), [], null, "2026-07-18", "Identify keyword gaps vs. the top 3 competitors.", "2026-07-16", 240, []),
];

let timeLogs: TimeLog[] = [
  { id: "tl-1", taskId: "t-4", userId: "u-dev", userName: "Made Putra", minutes: 180, spentOn: "2026-07-03", billable: true, note: "Hero layout + responsive" },
  { id: "tl-2", taskId: "t-4", userId: "u-dev", userName: "Made Putra", minutes: 90, spentOn: "2026-07-04", billable: true, note: "Animation polish" },
  { id: "tl-3", taskId: "t-web-a", userId: "u-pm", userName: "Dewi Santoso", minutes: 300, spentOn: "2026-06-26", billable: true, note: "Hi-fi mockup" },
];

const milestones: Milestone[] = [
  { id: "m-1", projectId: "p-web-1", name: "Design sign-off", dueDate: "2026-07-01", status: "done" },
  { id: "m-2", projectId: "p-web-1", name: "Launch", dueDate: "2026-07-20", status: "active" },
];

const docs: ProjectDoc[] = [
  { id: "doc-1", projectId: "p-web-1", title: "Redesign brief", body: "# Client site redesign\n\n**Goal:** modernise the marketing site and lift conversion.\n\n- New hero + clearer CTAs\n- Rebuilt checkout\n- Analytics + consent\n\nBrand guidelines apply throughout.", author: "Dewi Santoso", updatedAt: "2026-06-20T09:00:00Z" },
];

const comments: Record<string, Comment[]> = {
  "t-4": [
    { id: "c-1", author_id: "u-pm", author_name: "Dewi Santoso", body: "Hero looks great — just needs final copy before we ship.", parent_comment_id: null, created_at: "2026-07-06T09:00:00Z" },
  ],
};

let suggestions: TrackerSuggestion[] = [];
const trackerNotifications: { id: string; type: string; payload: { title: string; message: string; href?: string }; read_at: string | null; created_at: string; forUserId: string }[] = [];

// Knowledge/info the tracker can hand to the person in charge (stands in for a
// real Knowledge/RAG lookup).
const KNOWLEDGE: Record<string, { title: string; ref: string }[]> = {
  "p-web-1": [
    { title: "Brand guidelines.pdf", ref: "gaiada://knowledge/brand-guidelines" },
    { title: "Component library — hero patterns", ref: "gaiada://knowledge/hero-patterns" },
  ],
  "p-seo-1": [{ title: "Competitor keyword export.csv", ref: "gaiada://knowledge/kw-export" }],
};

function mkTask(id: string, projectId: string, title: string, status: TaskStatus, priority: Priority, assignee: Assignee | null, subtasks: Subtask[], milestoneId: string | null, dueDate: string | null, description: string, startDate: string | null = null, estimateMinutes: number | null = null, dependsOn: string[] = []): PmTask {
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
  const progress = subtasks.length > 0 ? taskProgressFromSubtasks(subtasks) : status === "done" ? 100 : status === "in_progress" ? 40 : 0;
  return { id, projectId, projectName, title, description, status, priority, progress, assignee, subtasks, milestoneId, startDate, dueDate, estimateMinutes, loggedMinutes: 0, dependsOn, updatedAt: "2026-07-15T09:00:00Z" };
}

// Roll seeded time logs into each task's loggedMinutes.
function syncLogged(taskId?: string) {
  for (const t of tasks) {
    if (taskId && t.id !== taskId) continue;
    t.loggedMinutes = timeLogs.filter((l) => l.taskId === t.id).reduce((n, l) => n + l.minutes, 0);
  }
}
syncLogged();

function projectView(p: ProjectMeta): PmProject {
  const pts = tasks.filter((t) => t.projectId === p.id);
  const progress = pts.length ? Math.round(pts.reduce((n, t) => n + t.progress, 0) / pts.length) : 0;
  return {
    id: p.id, name: p.name, status: p.status, progress, owner: p.owner, dueDate: p.dueDate,
    milestones: milestones.filter((m) => m.projectId === p.id),
    docCount: docs.filter((d) => d.projectId === p.id).length,
    taskCount: pts.length,
  };
}

function recompute(t: PmTask) {
  if (t.subtasks.length > 0) t.progress = taskProgressFromSubtasks(t.subtasks);
  if (t.status === "done") t.progress = 100;
  if (t.progress >= 100) t.status = "done";
  t.updatedAt = stamp();
}

// Public: tracker-generated notifications, newest first. Demo is single-user, so
// demoFixtures surfaces all of them in the bell (each payload names the person
// in charge it was delivered to).
export function allTrackerNotifications() {
  return trackerNotifications
    .map(({ forUserId: _f, ...rest }) => rest)
    .reverse();
}

const ok = (json: unknown): Result => ({ status: 200, json });
const parse = (body?: string): Record<string, unknown> => {
  if (!body) return {};
  try { return JSON.parse(body) as Record<string, unknown>; } catch { return {}; }
};

// Router. Returns null when the path is not a PM/comment route (caller falls through).
export function pmDemo(method: string, p: string, search: URLSearchParams, body?: string): Result | null {
  const m = method.toUpperCase();

  // Generic threaded comments for any entity (tasks keyed bare for AI-comment
  // compatibility; other entities keyed by "type:id").
  const commentsMatch = p.match(/^\/api\/[^/]+\/comments$/);
  if (commentsMatch && search.get("entityType")) {
    const et = search.get("entityType");
    const eid = search.get("entityId") ?? "";
    const key = et === "task" ? eid : `${et}:${eid}`;
    if (m === "POST") {
      const b = parse(body);
      const c: Comment = { id: nextId("c"), author_id: String(b.authorId ?? "demo-hansel"), author_name: MEMBERS[String(b.authorId ?? "demo-hansel")] ?? "You", body: String(b.body ?? ""), parent_comment_id: null, created_at: stamp() };
      (comments[key] ??= []).push(c);
      return { status: 201, json: { id: c.id } };
    }
    return ok(comments[key] ?? []);
  }

  if (!p.includes("/pm/")) return null;

  // Projects
  const projTasks = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/tasks$/);
  if (projTasks) return ok(tasks.filter((t) => t.projectId === projTasks[1]));
  const projMs = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/milestones$/);
  if (projMs) {
    if (m === "POST") {
      const b = parse(body);
      const ms: Milestone = { id: nextId("m"), projectId: projMs[1], name: String(b.name ?? "New milestone"), dueDate: (b.dueDate as string) ?? null, status: "active" };
      milestones.push(ms);
      return { status: 201, json: { id: ms.id } };
    }
    return ok(milestones.filter((x) => x.projectId === projMs[1]));
  }
  const msPatch = p.match(/^\/api\/[^/]+\/pm\/projects\/[^/]+\/milestones\/([^/]+)$/);
  if (msPatch && m === "PATCH") {
    const ms = milestones.find((x) => x.id === msPatch[1]);
    if (ms) Object.assign(ms, parse(body));
    return ok({ ok: true });
  }
  const projDocs = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/docs$/);
  if (projDocs) {
    if (m === "POST") {
      const b = parse(body);
      const d: ProjectDoc = { id: nextId("doc"), projectId: projDocs[1], title: String(b.title ?? "Untitled"), body: String(b.body ?? ""), author: "You", updatedAt: stamp() };
      docs.push(d);
      return { status: 201, json: { id: d.id } };
    }
    return ok(docs.filter((d) => d.projectId === projDocs[1]));
  }
  const docOne = p.match(/^\/api\/[^/]+\/pm\/projects\/[^/]+\/docs\/([^/]+)$/);
  if (docOne) {
    const d = docs.find((x) => x.id === docOne[1]);
    if (m === "PATCH" && d) { Object.assign(d, parse(body), { updatedAt: stamp() }); return ok({ ok: true }); }
    return d ? ok(d) : { status: 404, json: { error: "doc not found" } };
  }
  const projOne = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)$/);
  if (projOne) {
    let proj = projects.find((x) => x.id === projOne[1]);
    // Auto-vivify a project the PM store hasn't seen (e.g. one created via the
    // base /projects flow) so the workspace always has somewhere to land.
    if (!proj) { proj = { id: projOne[1], name: "Project", status: "active", owner: null, dueDate: null }; projects.push(proj); }
    if (m === "PATCH") {
      const b = parse(body);
      if (b.owner !== undefined) proj.owner = (b.owner as Assignee) || null;
      if (typeof b.name === "string") proj.name = b.name;
      if (typeof b.status === "string") proj.status = b.status;
      if (b.dueDate !== undefined) proj.dueDate = (b.dueDate as string) || null;
      return ok({ ok: true });
    }
    return ok(projectView(proj));
  }

  // Tasks
  if (p.match(/^\/api\/[^/]+\/pm\/tasks$/) && m === "GET") {
    const assignee = search.get("assignee");
    const rows = assignee === "me" ? tasks.filter((t) => t.assignee?.responsibleId === "demo-hansel") : tasks;
    return ok(rows);
  }
  if (p.match(/^\/api\/[^/]+\/pm\/tasks$/) && m === "POST") {
    const b = parse(body);
    const projectId = String(b.projectId ?? "");
    const t = mkTask(nextId("t"), projectId, String(b.title ?? "New task"), "todo", (b.priority as Priority) ?? "normal", (b.assignee as Assignee) ?? null, [], (b.milestoneId as string) ?? null, (b.dueDate as string) ?? null, String(b.description ?? ""));
    tasks.push(t);
    return { status: 201, json: { id: t.id } };
  }
  const timeMatch = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)\/time$/);
  if (timeMatch) {
    if (m === "POST") {
      const b = parse(body);
      const uid = String(b.userId ?? "demo-hansel");
      const tl: TimeLog = { id: nextId("tl"), taskId: timeMatch[1], userId: uid, userName: MEMBERS[uid] ?? "You", minutes: Math.max(0, Number(b.minutes ?? 0)), spentOn: String(b.spentOn ?? "2026-07-16"), billable: Boolean(b.billable), note: String(b.note ?? "") };
      timeLogs.push(tl);
      syncLogged(timeMatch[1]);
      return { status: 201, json: { id: tl.id } };
    }
    return ok(timeLogs.filter((l) => l.taskId === timeMatch[1]));
  }
  const trackerRun = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)\/tracker\/run$/);
  if (trackerRun && m === "POST") return runTracker(trackerRun[1]);
  const taskSugg = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)\/suggestions$/);
  if (taskSugg) return ok(suggestions.filter((s) => s.taskId === taskSugg[1]));
  const taskOne = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)$/);
  if (taskOne) {
    const t = tasks.find((x) => x.id === taskOne[1]);
    if (!t) return { status: 404, json: { error: "task not found" } };
    if (m === "PATCH") { patchTask(t, parse(body)); return ok({ ok: true }); }
    if (m === "DELETE") { tasks = tasks.filter((x) => x.id !== taskOne[1]); return ok({ ok: true }); }
    return ok(t);
  }

  // Suggestions confirm/dismiss
  const suggAct = p.match(/^\/api\/[^/]+\/pm\/suggestions\/([^/]+)\/(confirm|dismiss)$/);
  if (suggAct && m === "POST") {
    const s = suggestions.find((x) => x.id === suggAct[1]);
    if (s && s.status === "pending") {
      if (suggAct[2] === "confirm") {
        const t = tasks.find((x) => x.id === s.taskId);
        if (t) {
          if (s.kind === "progress") t.progress = Number(s.proposed);
          else t.status = s.proposed as TaskStatus;
          recompute(t);
        }
        s.status = "applied";
      } else s.status = "dismissed";
    }
    return ok({ ok: true });
  }

  return null;
}

function patchTask(t: PmTask, b: Record<string, unknown>) {
  if (typeof b.title === "string") t.title = b.title;
  if (typeof b.description === "string") t.description = b.description;
  if (typeof b.status === "string") t.status = b.status as TaskStatus;
  if (typeof b.priority === "string") t.priority = b.priority as Priority;
  if (typeof b.dueDate === "string") t.dueDate = b.dueDate;
  if (typeof b.startDate === "string") t.startDate = b.startDate;
  if (typeof b.estimateMinutes === "number") t.estimateMinutes = b.estimateMinutes;
  if (b.milestoneId !== undefined) t.milestoneId = (b.milestoneId as string) || null;
  if (typeof b.addDependency === "string" && b.addDependency && !t.dependsOn.includes(b.addDependency)) t.dependsOn.push(b.addDependency);
  if (typeof b.removeDependency === "string") t.dependsOn = t.dependsOn.filter((d) => d !== b.removeDependency);
  if (typeof b.progress === "number") t.progress = Math.max(0, Math.min(100, b.progress));
  if (b.assignee !== undefined) t.assignee = (b.assignee as Assignee) || null;
  if (typeof b.addSubtask === "string" && b.addSubtask.trim()) t.subtasks.push({ id: nextId("s"), title: b.addSubtask.trim(), done: false });
  if (typeof b.toggleSubtask === "string") {
    const s = t.subtasks.find((x) => x.id === b.toggleSubtask);
    if (s) s.done = !s.done;
  }
  if (typeof b.removeSubtask === "string") t.subtasks = t.subtasks.filter((x) => x.id !== b.removeSubtask);
  recompute(t);
}

// The AI Tracker: analyse the task, deliver docs/info + a comment + a
// notification to the person in charge, and record pending suggestions.
function runTracker(taskId: string): Result {
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return { status: 404, json: { error: "task not found" } };
  const s = suggestFromTask(t);
  const delivered = (KNOWLEDGE[t.projectId] ?? []).slice(0, 2);
  const responsibleId = t.assignee?.responsibleId ?? null;
  const responsibleName = t.assignee?.responsibleName ?? "the team";

  // Drop any stale pending suggestions for this task, then record fresh ones.
  suggestions = suggestions.filter((x) => !(x.taskId === taskId && x.status === "pending"));
  const made: TrackerSuggestion[] = [];
  const pushSugg = (kind: "progress" | "status", proposed: string) => {
    const sg: TrackerSuggestion = { id: nextId("sg"), taskId, kind, proposed, rationale: s.rationale, docs: delivered, status: "pending", createdAt: stamp() };
    suggestions.push(sg); made.push(sg);
  };
  if (s.progress !== t.progress) pushSugg("progress", String(s.progress));
  if (s.status !== t.status) pushSugg("status", s.status);

  // AI comment into the task timeline.
  const docLine = delivered.length ? ` Shared ${delivered.length} doc${delivered.length > 1 ? "s" : ""}: ${delivered.map((d) => d.title).join(", ")}.` : "";
  const cbody = `Tracker analysis for ${responsibleName}: ${s.rationale}${docLine}`;
  (comments[taskId] ??= []).push({ id: nextId("c"), author_id: null, author_name: "AI Tracker", body: cbody, parent_comment_id: null, created_at: stamp(), ai: true });

  // Notify the person in charge.
  if (responsibleId) {
    trackerNotifications.push({
      id: nextId("n"), forUserId: responsibleId, type: "pm.tracker.update", read_at: null, created_at: stamp(),
      payload: { title: `AI Tracker update — ${t.title}`, message: `${s.rationale}${docLine}`, href: `/tasks/${t.id}` },
    });
  }

  return ok({ suggestions: made, delivered, comment: cbody, notified: responsibleId });
}
