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
  synthDefaultStatuses,
  // P4-B8: the two named "where does a new task start?" intents. A bare `statuses[0]` here is what
  // silently parked fired recurrences in Backlog.
  intakeStatusId, readyStatusId,
  nextRecurrenceOccurrence,
  RECURRENCE_FREQS,
  type PmTask,
  type AssignmentEvent,
  type PmProject,
  type Milestone,
  type ProjectDoc,
  type ProjectStatus,
  type TrackerSuggestion,
  type Comment,
  type Assignee,
  type TaskStatus,
  type Priority,
  type Subtask,
  type TimeLog,
  type Tag,
  type TaskRecurrence,
  type RecurrenceFreq,
  type BurndownPoint,
  type FlowPoint,
  type Template,
} from "./pm";
import { isTagColor, type TagColor } from "./tagColors";

type Result = { status: number; json: unknown };

// A fixed "now" base so demo timestamps are stable-ish without Date.now() churn
// across module reloads; each mutation bumps a counter for ordering + unique ids.
let seq = 100;
const nextId = (p: string) => `${p}-${++seq}`;
const stamp = () => `2026-07-16T${String(8 + (seq % 12)).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}:00Z`;

const MEMBERS: Record<string, string> = {
  "demo-hansel": "Clement Hansel",
  "gede-ic": "Gede Kusuma",
  "u-pm": "Dewi Santoso",
  "u-dev": "Made Putra",
  "u-finance": "Rina Wibawa",
};
const person = (id: string): Assignee => ({ kind: "person", refId: id, refName: MEMBERS[id] ?? id, responsibleId: id, responsibleName: MEMBERS[id] ?? id });
const unit = (kind: "department" | "division", refId: string, refName: string, responsibleId: string): Assignee => ({
  kind, refId, refName, responsibleId, responsibleName: MEMBERS[responsibleId] ?? responsibleId,
});
const sub = (id: string, title: string, done: boolean): Subtask => ({ id, title, done });

// WD-28: `shortCode` mirrors the real backend's per-tenant unique code (derived the same way —
// first 3-4 uppercase alnum chars of the name); `taskSeq` is this demo project's own counter,
// mirroring `projects.task_seq` — the SAME single-counter-per-project shape as the real atomic
// allocator, just without genuine concurrency in a single-process demo store.
interface ProjectMeta { id: string; name: string; status: string; owner: Assignee | null; dueDate: string | null; shortCode: string | null; taskSeq: number }

// ---- seed state ----
const projects: ProjectMeta[] = [
  { id: "p-web-1", name: "Client site redesign", status: "active", owner: person("u-pm"), dueDate: "2026-07-20", shortCode: "CLIE", taskSeq: 0 },
  { id: "p-web-2", name: "Mobile app revamp", status: "active", owner: person("u-dev"), dueDate: "2026-08-10", shortCode: "MOBI", taskSeq: 0 },
  { id: "p-seo-1", name: "SEO audit — Q3", status: "active", owner: person("u-pm"), dueDate: "2026-08-01", shortCode: "SEOA", taskSeq: 0 },
  { id: "p-int-1", name: "Internal brand refresh", status: "completed", owner: person("demo-hansel"), dueDate: "2026-06-01", shortCode: "INTE", taskSeq: 0 },
];

// Atomic in the real backend (UPDATE...RETURNING under a row lock); the demo store is single-
// process/single-request so a simple increment is equivalent here — same per-project counter
// SHAPE, just without genuine concurrency to prove.
function nextTaskSeq(projectId: string): number {
  const proj = projects.find((p) => p.id === projectId);
  if (!proj) return 0; // an auto-vivified/unknown project (see projOne handler) has no counter yet
  proj.taskSeq += 1;
  return proj.taskSeq;
}
function taskDisplayCode(projectId: string, taskSeq: number | null): { projectShortCode: string | null; seq: number | null; displayCode: string | null } {
  const shortCode = projects.find((p) => p.id === projectId)?.shortCode ?? null;
  return { projectShortCode: shortCode, seq: taskSeq, displayCode: shortCode != null && taskSeq != null ? `${shortCode}-${taskSeq}` : null };
}
// Same derivation as the real backend's project-short-codes.ts (WD-28): first 3-4 uppercase alnum
// chars of the name, padded/PRJ-fallback, numeric-suffixed on collision against every OTHER demo
// project (this store has no per-tenant split — it's all one demo tenant).
function deriveDemoShortCode(name: string): string {
  let base = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (base.length < 3) base = base.padEnd(3, "X");
  if (base === "") base = "PRJ";
  let candidate = base;
  let n = 1;
  while (projects.some((p) => p.shortCode === candidate)) {
    n += 1;
    candidate = `${base}${n}`;
  }
  return candidate;
}

let tasks: PmTask[] = [
  mkTask("t-4", "p-web-1", "Wire homepage hero", "in_progress", "high", person("u-dev"), [sub("s1", "Hero layout", true), sub("s2", "Responsive pass", true), sub("s3", "Final copy", false)], "m-1", "2026-07-08", "Build the homepage hero section from the approved mockup.", "2026-07-02", 480, ["t-web-a"]),
  mkTask("t-5", "p-web-1", "QA checkout flow", "blocked", "urgent", person("u-dev"), [sub("s1", "Repro payment bug", true), sub("s2", "Fix + retest", false)], "m-2", "2026-07-09", "End-to-end QA of the checkout, blocked on the payment gateway sandbox.", "2026-07-07", 360, ["t-4"]),
  mkTask("t-web-a", "p-web-1", "Design homepage mockup", "done", "normal", person("u-pm"), [sub("s1", "Wireframe", true), sub("s2", "Hi-fi", true)], "m-1", "2026-06-28", "Deliver the hi-fi homepage mockup for sign-off.", "2026-06-24", 600, []),
  mkTask("t-web-b", "p-web-1", "Set up analytics", "todo", "normal", unit("division", "dept-1-div-1", "Frontend", "u-dev"), [], "m-2", "2026-07-18", "Instrument the site with product analytics and consent.", "2026-07-15", 240, []),
  // Assignee is the demo user (rather than null) so the WSUX-8 cross-company
  // `/api/tasks/mine` demo leg has a real pm_task row alongside its base
  // `tasks` rows — exercising the disjoint union, not just one side of it.
  mkTask("t-web-c", "p-web-1", "Content migration", "todo", "low", person("demo-hansel"), [], null, "2026-07-19", "Migrate legacy CMS content into the new site.", "2026-07-16", 300, []),
  mkTask("t-6", "p-seo-1", "Keyword gap analysis", "todo", "normal", person("u-pm"), [], null, "2026-07-18", "Identify keyword gaps vs. the top 3 competitors.", "2026-07-16", 240, []),
  // Second dept-1 (Web Dev) owned project (P3-06 polish) — gives the department
  // Charts page a real 2nd project to aggregate across, spanning todo/in_progress/done.
  mkTask("t-web2-a", "p-web-2", "Set up navigation shell", "done", "normal", person("u-dev"), [sub("s1", "Tab bar", true), sub("s2", "Deep links", true)], "m-3", "2026-07-20", "Stand up the app's core navigation shell.", "2026-07-10", 360, []),
  mkTask("t-web2-b", "p-web-2", "Build offline sync", "in_progress", "high", person("u-dev"), [sub("s1", "Local cache", true), sub("s2", "Conflict resolution", false)], "m-4", "2026-08-01", "Ship offline-first data sync for the mobile client.", "2026-07-18", 480, ["t-web2-a"]),
  mkTask("t-web2-c", "p-web-2", "Push notifications spike", "todo", "normal", person("demo-hansel"), [], "m-4", "2026-08-05", "Spike push notification delivery + opt-in flow.", "2026-07-22", 180, []),
];
// TR-32: seed one task with a real contributor (owner u-dev stays outcome-credited;
// demo-hansel logged hours here but isn't the owner) so the demo shows the populated,
// visually-distinct owner-vs-contributor state out of the box, not just the empty one.
tasks.find((t) => t.id === "t-4")!.contributors = [{ userId: "demo-hansel", name: MEMBERS["demo-hansel"] }];

// ---- tags (P2-02) ----
// Per-project registry — `Tag` itself carries no projectId (see lib/pm.ts), so
// the store keeps it alongside internally and strips it back off on every
// read, matching exactly what the real backend's per-project endpoint returns.
interface DemoTag extends Tag { projectId: string }
let tagRegistry: DemoTag[] = [
  { id: "tag-1", projectId: "p-web-1", label: "Frontend", color: "slate" },
  { id: "tag-2", projectId: "p-web-1", label: "Urgent", color: "clay" },
  { id: "tag-3", projectId: "p-seo-1", label: "Content", color: "olive" },
  { id: "tag-4", projectId: "p-web-2", label: "Frontend", color: "slate" },
  { id: "tag-5", projectId: "p-web-2", label: "Mobile", color: "olive" },
];
const stripProjectId = ({ id, label, color }: DemoTag): Tag => ({ id, label, color });

// ---- custom statuses (P2-05, design spec §7) ----
// Per-project status registry mirroring the locked contract. A project with no
// rows resolves to the synth legacy 4 on read; the first write MATERIALIZES the
// 4 defaults (so their ids persist as real rows) before applying the change —
// exactly what the real backend does. Seeded demo tasks use the legacy ids
// (todo/in_progress/blocked/done) so they slot straight into the synth defaults.
const statusStore: Record<string, ProjectStatus[]> = {};
function statusesFor(projectId: string): ProjectStatus[] {
  const rows = statusStore[projectId];
  return rows && rows.length ? [...rows].sort((a, b) => a.position - b.position) : synthDefaultStatuses();
}
function materializeStatuses(projectId: string): ProjectStatus[] {
  if (!statusStore[projectId] || statusStore[projectId].length === 0) statusStore[projectId] = synthDefaultStatuses();
  return statusStore[projectId];
}
tasks.find((t) => t.id === "t-4")!.tags = ["tag-1", "tag-2"];
tasks.find((t) => t.id === "t-web-a")!.tags = ["tag-1"];
tasks.find((t) => t.id === "t-6")!.tags = ["tag-3"];
tasks.find((t) => t.id === "t-web2-a")!.tags = ["tag-4"];
tasks.find((t) => t.id === "t-web2-b")!.tags = ["tag-4", "tag-5"];
// A seeded recurring task (P2-06) so the ↻ glyph + Repeats/Ends fields are visible
// browsing DEMO_MODE with no manual setup.
tasks.find((t) => t.id === "t-6")!.recurrence = { freq: "weekly" };

let timeLogs: TimeLog[] = [
  { id: "tl-1", taskId: "t-4", userId: "u-dev", userName: "Made Putra", minutes: 180, spentOn: "2026-07-03", billable: true, note: "Hero layout + responsive" },
  { id: "tl-2", taskId: "t-4", userId: "u-dev", userName: "Made Putra", minutes: 90, spentOn: "2026-07-04", billable: true, note: "Animation polish" },
  { id: "tl-3", taskId: "t-web-a", userId: "u-pm", userName: "Dewi Santoso", minutes: 300, spentOn: "2026-06-26", billable: true, note: "Hi-fi mockup" },
];

const milestones: Milestone[] = [
  { id: "m-1", projectId: "p-web-1", name: "Design sign-off", dueDate: "2026-07-01", status: "done" },
  { id: "m-2", projectId: "p-web-1", name: "Launch", dueDate: "2026-07-20", status: "active" },
  { id: "m-3", projectId: "p-web-2", name: "Nav shell complete", dueDate: "2026-07-20", status: "done" },
  { id: "m-4", projectId: "p-web-2", name: "Beta release", dueDate: "2026-08-10", status: "active" },
];

const docs: ProjectDoc[] = [
  { id: "doc-1", projectId: "p-web-1", title: "Redesign brief", body: "# Client site redesign\n\n**Goal:** modernise the marketing site and lift conversion.\n\n- New hero + clearer CTAs\n- Rebuilt checkout\n- Analytics + consent\n\nBrand guidelines apply throughout.", author: "Dewi Santoso", updatedAt: "2026-06-20T09:00:00Z", version: 1 },
];

// ---- doc version history (P3-11) ----
// Append-only per docId — a real edit (title AND/OR body actually changed)
// pushes MAX+1; a no-op save (title+body both unchanged) is skipped entirely.
// A restore never rewrites row v — it copies v's content into the doc AND
// appends a brand-new version authored by the restorer (nothing is ever
// rewritten, matching the locked contract).
interface DocVersionRow { version: number; title: string; body: string; authorId: string; authorName: string; createdAt: string }
const docVersions: Record<string, DocVersionRow[]> = {
  "doc-1": [{ version: 1, title: docs[0].title, body: docs[0].body, authorId: "u-pm", authorName: "Dewi Santoso", createdAt: docs[0].updatedAt! }],
};
function seedDocVersion(docId: string, title: string, body: string, authorId: string, authorName: string) {
  docVersions[docId] = [{ version: 1, title, body, authorId, authorName, createdAt: stamp() }];
}
// Appends the next version UNLESS both title and body are unchanged from the
// doc's current content — the no-op-save guard the ticket calls for.
function appendDocVersionIfChanged(d: ProjectDoc, newTitle: string, newBody: string, authorId: string, authorName: string) {
  if (newTitle === d.title && newBody === d.body) return; // no-op save — never versioned
  const rows = (docVersions[d.id] ??= []);
  const nextVersion = (rows.at(-1)?.version ?? 0) + 1;
  rows.push({ version: nextVersion, title: newTitle, body: newBody, authorId, authorName, createdAt: stamp() });
  d.version = nextVersion;
}

const comments: Record<string, Comment[]> = {
  "t-4": [
    { id: "c-1", author_id: "u-pm", author_name: "Dewi Santoso", body: "Hero looks great — just needs final copy before we ship.", parent_comment_id: null, created_at: "2026-07-06T09:00:00Z" },
  ],
};

// ---- task templates (P3-03) ----
// Tenant-wide (not per-project — see lib/pm.ts's Template doc comment). Seeded
// empty; NewTaskForm's "Manage templates…" + TaskDetailView's "Save as
// template" are the only writers in the demo, same "resets on restart"
// convention as every other demo store.
let templates: Template[] = [];

let suggestions: TrackerSuggestion[] = [];
const trackerNotifications: { id: string; type: string; payload: { title: string; body: string; href?: string; entityType?: string; entityId?: string; severity?: "info" | "warning" | "critical" }; read_at: string | null; created_at: string; forUserId: string }[] = [];

// ---- task followers (P3-09) ----
// taskId -> Set of follower user ids. DEMO_MODE is single-real-user (see the
// comments POST leg's `b.authorId ?? "demo-hansel"` convention above) — every
// follow/unfollow acts on "demo-hansel", the signed-in demo identity.
const DEMO_SELF = "demo-hansel";
const followerStore: Record<string, Set<string>> = {};
function followersFor(taskId: string): { id: string; name: string }[] {
  return [...(followerStore[taskId] ?? [])].map((id) => ({ id, name: MEMBERS[id] ?? id }));
}

// ---- assignment history (P4-B1..B7) ----
// The demo twin of `pm_task_assignment_events` (migration 0087). Append-only, exactly like the
// real table: nothing here ever mutates or removes a row, because "passing the ball does not erase
// the previous holder" IS the feature — a fixture that overwrote would demo the opposite of what
// shipped.
//
// Remember Ball is NOT a separate field: Ball = `assignee.refId`/`kind`, Responsible =
// `assignee.responsibleId` (owner decision 2026-08-06). So one row records both slots as they stood
// at that moment, plus the status the task was in at handoff.
//
// Seeding is LAZY and mirrors the migration's backfill: a task that already has an assignee gets one
// synthetic origin row on first read, so existing demo tasks don't read as "never assigned". Without
// it the History section would look broken on every seeded task rather than merely empty.
const assignmentEvents: Record<string, AssignmentEvent[]> = {};

function appendAssignmentEvent(t: PmTask, changedBy: string | null, note: string | null): void {
  (assignmentEvents[t.id] ??= []).push({
    id: nextId("ae"),
    refId: t.assignee?.refId ?? null,
    refKind: t.assignee?.kind ?? null,
    refName: t.assignee?.refName ?? null,
    responsibleId: t.assignee?.responsibleId ?? null,
    responsibleName: t.assignee?.responsibleName ?? null,
    statusId: t.status,
    note,
    changedBy,
    changedByName: changedBy ? (MEMBERS[changedBy] ?? changedBy) : null,
    createdAt: new Date().toISOString(),
  });
}

function assignmentHistoryFor(taskId: string): AssignmentEvent[] {
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return [];
  if (!assignmentEvents[taskId] && t.assignee) {
    // Origin row, dated from the task itself rather than "now" — the real backfill dates from the
    // task's own created_at, and a history that claims every legacy task was assigned this second
    // would be actively misleading.
    assignmentEvents[taskId] = [{
      id: nextId("ae"),
      refId: t.assignee.refId, refKind: t.assignee.kind, refName: t.assignee.refName,
      responsibleId: t.assignee.responsibleId, responsibleName: t.assignee.responsibleName,
      statusId: t.status, note: null, changedBy: null, changedByName: null,
      createdAt: t.updatedAt ?? "2026-07-15T09:00:00Z",
    }];
  }
  // Newest-first, matching the endpoint's documented contract.
  return [...(assignmentEvents[taskId] ?? [])].reverse();
}

// ---- comment reactions (P3-09) ----
// Closed 8-emoji set (locked BFF contract) — commentId -> emoji -> Set of
// reactor user ids. A Set makes add/remove naturally idempotent (re-adding the
// same user is a no-op, matching the real backend's UNIQUE(comment_id, user_id, emoji)).
export const REACTION_EMOJI = ["👍", "❤️", "🎉", "👀", "✅", "💡", "🙏", "🔥"] as const;
const REACTION_EMOJI_SET = new Set<string>(REACTION_EMOJI);
const reactionStore: Record<string, Partial<Record<string, Set<string>>>> = {};
function addReactionDemo(commentId: string, emoji: string, userId: string) {
  const forComment = (reactionStore[commentId] ??= {});
  (forComment[emoji] ??= new Set()).add(userId);
}
function removeReactionDemo(commentId: string, emoji: string, userId: string) {
  reactionStore[commentId]?.[emoji]?.delete(userId);
}
function reactionsFor(commentId: string, forUserId: string): { emoji: string; count: number; mine: boolean }[] {
  const forComment = reactionStore[commentId];
  if (!forComment) return [];
  const out: { emoji: string; count: number; mine: boolean }[] = [];
  for (const emoji of REACTION_EMOJI) {
    const users = forComment[emoji];
    if (users && users.size > 0) out.push({ emoji, count: users.size, mine: users.has(forUserId) });
  }
  return out;
}
function withReactions(list: Comment[]): Comment[] {
  return list.map((c) => ({ ...c, reactions: reactionsFor(c.id, DEMO_SELF) }));
}

// ---- recurring tasks (P2-06, design spec §8) — mirrors pm.controller.ts exactly ----
// Idempotency: `spawnedChildren` records (parentId, dueDate) pairs already spawned, so
// re-PATCHing an already-done recurring task twice never double-spawns — same invariant
// as the backend's defensive existing-child check, standing in for its row-lock (the
// demo store is single-threaded, so there's no concurrent-PATCH race to guard against).
const spawnedChildren: { parentId: string; dueDate: string }[] = [];
function parseRecurrenceInput(v: unknown): TaskRecurrence | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.freq !== "string" || !RECURRENCE_FREQS.includes(r.freq as RecurrenceFreq)) return null;
  const out: TaskRecurrence = { freq: r.freq as RecurrenceFreq };
  if (typeof r.until === "string" && r.until) out.until = r.until;
  return out;
}

// Knowledge/info the tracker can hand to the person in charge (stands in for a
// real Knowledge/RAG lookup).
const KNOWLEDGE: Record<string, { title: string; ref: string }[]> = {
  "p-web-1": [
    { title: "Brand guidelines.pdf", ref: "gaiada://knowledge/brand-guidelines" },
    { title: "Component library — hero patterns", ref: "gaiada://knowledge/hero-patterns" },
  ],
  "p-seo-1": [{ title: "Competitor keyword export.csv", ref: "gaiada://knowledge/kw-export" }],
};

function mkTask(id: string, projectId: string, title: string, status: TaskStatus, priority: Priority, assignee: Assignee | null, subtasks: Subtask[], milestoneId: string | null, dueDate: string | null, description: string, startDate: string | null = null, estimateMinutes: number | null = null, dependsOn: string[] = [], customFields: Record<string, unknown> = {}, recurrence: TaskRecurrence | null = null): PmTask {
  const projectName = projects.find((p) => p.id === projectId)?.name ?? projectId;
  const progress = subtasks.length > 0 ? taskProgressFromSubtasks(subtasks) : status === "done" ? 100 : status === "in_progress" ? 40 : 0;
  const codes = taskDisplayCode(projectId, nextTaskSeq(projectId)); // WD-28: allocate this project's next seq
  // TR-32: seeded with an empty list (never omitted) — DEMO_MODE always has the
  // TR-02 column, matching a real (non-stale) backend. The `undefined` degrade
  // path (Contributors.tsx) is exercised by unit tests against a bare PmTask
  // literal that omits the field entirely, not by this fixture store.
  return { id, projectId, projectName, title, description, status, priority, progress, assignee, subtasks, milestoneId, startDate, dueDate, estimateMinutes, loggedMinutes: 0, dependsOn, tags: [], customFields, updatedAt: "2026-07-15T09:00:00Z", recurrence, contributors: [], ...codes };
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
    id: p.id, name: p.name, status: p.status, shortCode: p.shortCode, progress, owner: p.owner, dueDate: p.dueDate,
    milestones: milestones.filter((m) => m.projectId === p.id),
    docCount: docs.filter((d) => d.projectId === p.id).length,
    taskCount: pts.length,
    statuses: statusesFor(p.id),
  };
}

// P2-05: recompute is flag-driven — a task in an isDone status is pinned to 100%,
// and hitting 100% moves it to the project's isDone status (whatever its id/label).
function recompute(t: PmTask) {
  const statuses = statusesFor(t.projectId);
  const cur = statuses.find((s) => s.id === t.status);
  const doneStatus = statuses.find((s) => s.isDone);
  if (t.subtasks.length > 0) t.progress = taskProgressFromSubtasks(t.subtasks);
  if (cur?.isDone) t.progress = 100;
  if (t.progress >= 100 && doneStatus) t.status = doneStatus.id;
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

// Public: WSUX-8's cross-company `/api/tasks/mine` demo leg needs the poly-
// assignee PM tasks belonging to one user, same shape the real
// tasks-mine.controller.ts's `source: "pm_task"` leg returns. All demo PM
// projects live under co-agency (see demoFixtures' PROJECTS map), so the
// caller tags every row with that tenant.
export function pmTasksForUser(userId: string): PmTask[] {
  return tasks.filter((t) => t.assignee?.responsibleId === userId && t.status !== "done");
}

// ---- burndown (P2-08, design spec §4) ----
// Backend anchor: `2026-07-16` matches the rest of this store's `stamp()` base, so DEMO_MODE's
// burndown reads as "today" from the same fixed clock every other demo timestamp uses.
const DEMO_BURNDOWN_END = "2026-07-16";
const DEMO_BURNDOWN_DAYS = 10;

function isoShift(date: string, days: number): string {
  const [y, mo, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Deterministic declining series for a project, ending exactly at its CURRENT real
// open/done/avgProgress (so a demo project you've been editing still tells a consistent story)
// and starting `days` earlier at "everything open, nothing done, 0% progress" — the classic
// burndown shape. A project with no tasks has nothing to burn down -> []. Exported for testing;
// the `/burndown` route below is its only real caller (mirrors the backend's response shape).
export function synthBurndownSeries(projectId: string, days: number = DEMO_BURNDOWN_DAYS, endDate: string = DEMO_BURNDOWN_END): BurndownPoint[] {
  const pts = tasks.filter((t) => t.projectId === projectId);
  const total = pts.length;
  if (total === 0) return [];
  const doneIds = new Set(statusesFor(projectId).filter((s) => s.isDone).map((s) => s.id));
  const currentDone = pts.filter((t) => doneIds.has(t.status)).length;
  const currentAvg = Math.round(pts.reduce((n, t) => n + t.progress, 0) / total);
  const out: BurndownPoint[] = [];
  for (let i = 0; i < days; i++) {
    const isLast = i === days - 1;
    const frac = days > 1 ? i / (days - 1) : 1;
    const done = isLast ? currentDone : Math.round(currentDone * frac);
    const avgProgress = isLast ? currentAvg : Math.round(currentAvg * frac);
    out.push({ date: isoShift(endDate, -(days - 1 - i)), open: total - done, done, avgProgress });
  }
  return out;
}

// ---- cumulative flow (P3-06; sibling BE ticket P3-05 adds the real /flow endpoint) ----
// Deterministic multi-day flow history for a project, ending at its CURRENT real per-status
// distribution and starting with every task in the pipeline's first status — same "ends at
// today, starts at the beginning" shape as synthBurndownSeries above. Each task advances
// through the statuses BETWEEN position 0 and its own current position on a schedule
// proportional to that final position (floor(finalPos * i / (days-1))), which is monotonic
// non-decreasing in `i` for a fixed task — bands only grow forward in time, never regress,
// exactly what a real CFD looks like. A task already at position 0 today just stays there the
// whole series. Exported for testing; the `/flow` route below is its only real caller (mirrors
// the backend's response shape: one row per day, status id -> count that day).
export function synthFlowSeries(projectId: string, days: number = DEMO_BURNDOWN_DAYS, endDate: string = DEMO_BURNDOWN_END): FlowPoint[] {
  const pts = tasks.filter((t) => t.projectId === projectId);
  if (pts.length === 0) return [];
  const statuses = statusesFor(projectId);
  const byPosition = new Map(statuses.map((s) => [s.position, s]));
  const posById = new Map(statuses.map((s) => [s.id, s.position]));
  const out: FlowPoint[] = [];
  for (let i = 0; i < days; i++) {
    const counts: Record<string, number> = {};
    for (const s of statuses) counts[s.id] = 0;
    for (const t of pts) {
      const finalPos = posById.get(t.status) ?? 0;
      const pos = days > 1 ? Math.floor((finalPos * i) / (days - 1)) : finalPos;
      const atStatus = byPosition.get(pos) ?? statuses[0];
      counts[atStatus.id] = (counts[atStatus.id] ?? 0) + 1;
    }
    out.push({ date: isoShift(endDate, -(days - 1 - i)), counts });
  }
  return out;
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
    return ok(withReactions(comments[key] ?? []));
  }

  // Comment reactions (P3-09) — path has no "/pm/" segment, so these two
  // matches must live above the `/pm/` guard below.
  const reactionsMatch = p.match(/^\/api\/[^/]+\/comments\/([^/]+)\/reactions$/);
  if (reactionsMatch && m === "POST") {
    const b = parse(body);
    const emoji = String(b.emoji ?? "");
    if (!REACTION_EMOJI_SET.has(emoji)) return { status: 400, json: { error: "Unsupported reaction." } };
    addReactionDemo(reactionsMatch[1], emoji, DEMO_SELF);
    return ok({ ok: true });
  }
  const reactionOneMatch = p.match(/^\/api\/[^/]+\/comments\/([^/]+)\/reactions\/([^/]+)$/);
  if (reactionOneMatch && m === "DELETE") {
    removeReactionDemo(reactionOneMatch[1], decodeURIComponent(reactionOneMatch[2]), DEMO_SELF);
    return ok({ ok: true });
  }

  if (!p.includes("/pm/")) return null;

  // Assignment history (P4-B7) — the append-only chain behind the task detail's History section.
  const assignHistMatch = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)\/assignment-history$/);
  if (assignHistMatch) return ok(assignmentHistoryFor(assignHistMatch[1]));

  // Task followers (P3-09) — self-scoped, member-level.
  const followersMatch = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)\/followers$/);
  if (followersMatch) return ok(followersFor(followersMatch[1]));
  const followMatch = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)\/follow$/);
  if (followMatch) {
    const taskId = followMatch[1];
    if (m === "POST") { (followerStore[taskId] ??= new Set()).add(DEMO_SELF); return ok({ ok: true }); }
    if (m === "DELETE") { followerStore[taskId]?.delete(DEMO_SELF); return ok({ ok: true }); }
  }

  // Task templates (P3-03) — tenant-wide, matching the locked contract
  // (`GET/POST /pm/templates?kind=task`, `PATCH/DELETE /pm/templates/:id`).
  const templatesMatch = p.match(/^\/api\/[^/]+\/pm\/templates$/);
  if (templatesMatch) {
    const kind = search.get("kind") ?? "task";
    if (m === "POST") {
      const b = parse(body);
      const title = String(b.title ?? "").trim();
      if (!title) return { status: 400, json: { error: "Title is required." } };
      const tpl: Template = {
        id: nextId("tpl"),
        kind: typeof b.kind === "string" && b.kind ? b.kind : "task",
        title,
        description: typeof b.description === "string" ? b.description : undefined,
        priority: typeof b.priority === "string" ? (b.priority as Priority) : undefined,
        estimateMinutes: typeof b.estimateMinutes === "number" ? b.estimateMinutes : undefined,
        subtasks: Array.isArray(b.subtasks) ? (b.subtasks as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined,
        tagLabels: Array.isArray(b.tagLabels) ? (b.tagLabels as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : undefined,
        body: typeof b.body === "string" ? b.body : undefined, // doc templates (P3-11)
      };
      templates.push(tpl);
      return { status: 201, json: { id: tpl.id } };
    }
    return ok(templates.filter((t) => t.kind === kind));
  }
  const templateOne = p.match(/^\/api\/[^/]+\/pm\/templates\/([^/]+)$/);
  if (templateOne) {
    const tpl = templates.find((x) => x.id === templateOne[1]);
    if (!tpl) return { status: 404, json: { error: "template not found" } };
    if (m === "PATCH") {
      const b = parse(body);
      if (typeof b.title === "string" && b.title.trim()) tpl.title = b.title.trim();
      if (typeof b.description === "string") tpl.description = b.description;
      if (typeof b.priority === "string") tpl.priority = b.priority as Priority;
      if (typeof b.estimateMinutes === "number") tpl.estimateMinutes = b.estimateMinutes;
      if (Array.isArray(b.subtasks)) tpl.subtasks = (b.subtasks as unknown[]).filter((x): x is string => typeof x === "string");
      if (Array.isArray(b.tagLabels)) tpl.tagLabels = (b.tagLabels as unknown[]).filter((x): x is string => typeof x === "string");
      if (typeof b.body === "string") tpl.body = b.body;
      return ok({ ok: true });
    }
    if (m === "DELETE") { templates = templates.filter((x) => x.id !== templateOne[1]); return ok({ ok: true }); }
    return ok(tpl);
  }

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
  // Tag registry (P2-02, design spec §6) — per-project, matching the real
  // backend contract exactly (see lib/pm.ts's BFF CONTRACT comment).
  const projTags = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/tags$/);
  if (projTags) {
    const projectId = projTags[1];
    if (m === "POST") {
      const b = parse(body);
      const label = String(b.label ?? "").trim();
      const color: TagColor = isTagColor(String(b.color ?? "")) ? (b.color as TagColor) : "bronze";
      if (!label) return { status: 400, json: { error: "Tag name is required." } };
      const tg: DemoTag = { id: nextId("tag"), projectId, label, color };
      tagRegistry.push(tg);
      return { status: 201, json: { id: tg.id } };
    }
    return ok(tagRegistry.filter((t) => t.projectId === projectId).map(stripProjectId));
  }
  const tagOne = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/tags\/([^/]+)$/);
  if (tagOne) {
    const [, projectId, tagId] = tagOne;
    const tg = tagRegistry.find((t) => t.id === tagId && t.projectId === projectId);
    if (!tg) return { status: 404, json: { error: "tag not found" } };
    if (m === "PATCH") {
      const b = parse(body);
      if (typeof b.label === "string" && b.label.trim()) tg.label = b.label.trim();
      if (typeof b.color === "string" && isTagColor(b.color)) tg.color = b.color;
      return ok({ ok: true });
    }
    if (m === "DELETE") {
      const inUse = tasks.some((t) => t.projectId === projectId && t.tags.includes(tagId));
      const force = search.get("force") === "1";
      if (inUse && !force) return { status: 409, json: { inUse: true } };
      tagRegistry = tagRegistry.filter((t) => t.id !== tagId);
      // Guarded delete with force=1 strips the id from every task that carried
      // it (design spec §6's "force" behaviour deletes the tag AND detaches it,
      // it never leaves a dangling id on a task).
      for (const t of tasks) if (t.tags.includes(tagId)) t.tags = t.tags.filter((x) => x !== tagId);
      return ok({ ok: true });
    }
  }
  const projDocs = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/docs$/);
  if (projDocs) {
    if (m === "POST") {
      const b = parse(body);
      const title = String(b.title ?? "Untitled");
      const docBody = String(b.body ?? "");
      const d: ProjectDoc = { id: nextId("doc"), projectId: projDocs[1], title, body: docBody, author: "You", updatedAt: stamp(), version: 1 };
      docs.push(d);
      seedDocVersion(d.id, title, docBody, DEMO_SELF, "You");
      return { status: 201, json: { id: d.id } };
    }
    return ok(docs.filter((d) => d.projectId === projDocs[1]));
  }
  const docOne = p.match(/^\/api\/[^/]+\/pm\/projects\/[^/]+\/docs\/([^/]+)$/);
  if (docOne) {
    const d = docs.find((x) => x.id === docOne[1]);
    if (m === "PATCH" && d) {
      const b = parse(body);
      const newTitle = typeof b.title === "string" ? b.title : d.title;
      const newBody = typeof b.body === "string" ? b.body : d.body;
      appendDocVersionIfChanged(d, newTitle, newBody, DEMO_SELF, "You");
      Object.assign(d, { title: newTitle, body: newBody, updatedAt: stamp() });
      return ok({ ok: true });
    }
    return d ? ok(d) : { status: 404, json: { error: "doc not found" } };
  }
  // Doc version history (P3-11) — top-level /pm/docs/:docId/... (NOT nested
  // under /projects/:projectId/, matching the locked contract exactly).
  const docVersionsMatch = p.match(/^\/api\/[^/]+\/pm\/docs\/([^/]+)\/versions$/);
  if (docVersionsMatch) {
    const rows = docVersions[docVersionsMatch[1]] ?? [];
    // META only — no body, per the locked contract.
    return ok(rows.map((r) => ({ version: r.version, authorId: r.authorId, authorName: r.authorName, createdAt: r.createdAt })));
  }
  const docVersionOne = p.match(/^\/api\/[^/]+\/pm\/docs\/([^/]+)\/versions\/(\d+)$/);
  if (docVersionOne) {
    const rows = docVersions[docVersionOne[1]] ?? [];
    const row = rows.find((r) => r.version === Number(docVersionOne[2]));
    if (!row) return { status: 404, json: { error: "version not found" } };
    return ok({ version: row.version, title: row.title, body: row.body, authorName: row.authorName, createdAt: row.createdAt });
  }
  const docVersionRestore = p.match(/^\/api\/[^/]+\/pm\/docs\/([^/]+)\/versions\/(\d+)\/restore$/);
  if (docVersionRestore && m === "POST") {
    const docId = docVersionRestore[1];
    const d = docs.find((x) => x.id === docId);
    if (!d) return { status: 404, json: { error: "doc not found" } };
    const rows = docVersions[docId] ?? [];
    const row = rows.find((r) => r.version === Number(docVersionRestore[2]));
    if (!row) return { status: 404, json: { error: "version not found" } };
    // Restore sets the doc to v's content AND appends a brand-new version
    // authored by the restorer — the previous rows are never rewritten.
    const nextVersion = (rows.at(-1)?.version ?? 0) + 1;
    rows.push({ version: nextVersion, title: row.title, body: row.body, authorId: DEMO_SELF, authorName: "You", createdAt: stamp() });
    Object.assign(d, { title: row.title, body: row.body, updatedAt: stamp(), version: nextVersion });
    return ok({ ok: true });
  }
  // Custom statuses (P2-05, design spec §7) — per-project, matching the locked contract.
  const projStatuses = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/statuses$/);
  if (projStatuses) {
    const projectId = projStatuses[1];
    if (m === "POST") {
      const rows = materializeStatuses(projectId);
      const b = parse(body);
      const label = String(b.label ?? "").trim();
      if (!label) return { status: 400, json: { error: "Status name is required." } };
      const st: ProjectStatus = {
        id: nextId("st"),
        label,
        color: typeof b.color === "string" ? b.color : "var(--accent)",
        isDone: Boolean(b.isDone),
        isBlocked: Boolean(b.isBlocked),
        wipLimit: typeof b.wipLimit === "number" ? b.wipLimit : undefined,
        position: rows.length,
      };
      rows.push(st);
      return { status: 201, json: { id: st.id } };
    }
    return ok(statusesFor(projectId));
  }
  const statusOne = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/statuses\/([^/]+)$/);
  if (statusOne) {
    const [, projectId, sid] = statusOne;
    const rows = materializeStatuses(projectId);
    const st = rows.find((s) => s.id === sid);
    if (!st) return { status: 404, json: { error: "status not found" } };
    if (m === "PATCH") {
      const b = parse(body);
      if (typeof b.label === "string" && b.label.trim()) st.label = b.label.trim();
      if (typeof b.color === "string") st.color = b.color;
      if (typeof b.isDone === "boolean") st.isDone = b.isDone;
      if (typeof b.isBlocked === "boolean") st.isBlocked = b.isBlocked;
      if (b.wipLimit === null) st.wipLimit = undefined;
      else if (typeof b.wipLimit === "number") st.wipLimit = b.wipLimit;
      if (typeof b.position === "number") st.position = b.position;
      return ok({ ok: true });
    }
    if (m === "DELETE") {
      const inUse = tasks.filter((t) => t.projectId === projectId && t.status === sid).length;
      const moveTo = search.get("moveTo");
      // Locked contract: 400 { inUse:n } unless ?moveTo=<sid> reassigns them.
      if (inUse > 0 && !moveTo) return { status: 400, json: { inUse } };
      if (moveTo) {
        if (!rows.some((s) => s.id === moveTo)) return { status: 400, json: { error: "moveTo status not found" } };
        for (const t of tasks) if (t.projectId === projectId && t.status === sid) t.status = moveTo;
      }
      statusStore[projectId] = rows.filter((s) => s.id !== sid);
      return ok({ ok: true });
    }
  }
  // Burndown (P2-08, design spec §4) — mirrors the real backend's `from`/`to` range filter and
  // its "empty range -> []" contract.
  const projBurndown = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/burndown$/);
  if (projBurndown) {
    const series = synthBurndownSeries(projBurndown[1]);
    const from = search.get("from");
    const to = search.get("to");
    return ok(series.filter((pt) => (!from || pt.date >= from) && (!to || pt.date <= to)));
  }
  // Cumulative flow (P3-06) — mirrors the burndown route's from/to range filter contract.
  const projFlow = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/flow$/);
  if (projFlow) {
    const series = synthFlowSeries(projFlow[1]);
    const from = search.get("from");
    const to = search.get("to");
    return ok(series.filter((pt) => (!from || pt.date >= from) && (!to || pt.date <= to)));
  }
  // Duplicate project (P3-04): a fresh copy of the project, deep-copying statuses/
  // tags/milestones/docs/tasks. Tasks are reset to first non-done status + 0 progress
  // with assignee cleared. Owner + due cleared. Same spirit as task duplicate —
  // a new project starts clean, it isn't a snapshot.
  const projDuplicate = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)\/duplicate$/);
  if (projDuplicate && m === "POST") {
    const orig = projects.find((x) => x.id === projDuplicate[1]);
    if (!orig) return { status: 404, json: { error: "project not found" } };
    const b = parse(body);
    const newName = typeof b.name === "string" ? b.name.trim() : orig.name;
    if (!newName) return { status: 400, json: { error: "Project name is required." } };
    const newId = nextId("p");
    // Create the new project meta — WD-28: the clone gets its OWN fresh derived short_code
    // (never the source's) and its task counter starts at 0, matching the real backend.
    const newProj: ProjectMeta = { id: newId, name: newName, status: "active", owner: null, dueDate: null, shortCode: deriveDemoShortCode(newName), taskSeq: 0 };
    projects.push(newProj);
    // Copy statuses (per-project registry)
    const origStatuses = statusStore[orig.id];
    if (origStatuses && origStatuses.length > 0) {
      statusStore[newId] = origStatuses.map((s) => ({ ...s, id: nextId("st") }));
    }
    // Copy tags (per-project registry)
    const origTags = tagRegistry.filter((t) => t.projectId === orig.id);
    const tagIdMap = new Map<string, string>();
    for (const tg of origTags) {
      const newTagId = nextId("tag");
      tagIdMap.set(tg.id, newTagId);
      tagRegistry.push({ id: newTagId, projectId: newId, label: tg.label, color: tg.color });
    }
    // Copy milestones (per-project)
    const origMilestones = milestones.filter((m) => m.projectId === orig.id);
    const msIdMap = new Map<string, string>();
    for (const ms of origMilestones) {
      const newMsId = nextId("m");
      msIdMap.set(ms.id, newMsId);
      milestones.push({ id: newMsId, projectId: newId, name: ms.name, dueDate: ms.dueDate, status: "active" });
    }
    // Copy docs (per-project) — the copy starts its own fresh v1 history
    // (P3-11), not a snapshot of the original's version log.
    const origDocs = docs.filter((d) => d.projectId === orig.id);
    for (const d of origDocs) {
      const newDocId = nextId("doc");
      docs.push({ id: newDocId, projectId: newId, title: d.title, body: d.body, author: d.author, updatedAt: stamp(), version: 1 });
      seedDocVersion(newDocId, d.title, d.body, DEMO_SELF, "You");
    }
    // Copy tasks (per-project), resetting as per spec:
    // unassigned + first non-done status + 0 progress, new ids, tags remapped
    const origTasks = tasks.filter((t) => t.projectId === orig.id);
    const copyStatus = intakeStatusId(statusesFor(newId)); // uncommitted copy → Backlog when present
    for (const origTask of origTasks) {
      const copiedTask: PmTask = {
        ...origTask,
        id: nextId("t"),
        projectId: newId,
        projectName: newName,
        status: copyStatus,
        progress: 0,
        assignee: null,
        subtasks: origTask.subtasks.map((s) => ({ ...s, id: nextId("s"), done: false })),
        dependsOn: [],
        loggedMinutes: 0,
        tags: origTask.tags.map((tid) => tagIdMap.get(tid) ?? tid).filter((tid) => tagIdMap.has(tid)),
        milestoneId: origTask.milestoneId ? msIdMap.get(origTask.milestoneId) ?? null : null,
        updatedAt: stamp(),
        // WD-28: FRESH seq off the clone's own counter (started at 0 above) — never the source
        // task's seq/displayCode, which belong to the source project's own sequence.
        ...taskDisplayCode(newId, nextTaskSeq(newId)),
      };
      tasks.push(copiedTask);
    }
    return { status: 201, json: { id: newId } };
  }
  const projOne = p.match(/^\/api\/[^/]+\/pm\/projects\/([^/]+)$/);
  if (projOne) {
    let proj = projects.find((x) => x.id === projOne[1]);
    // Auto-vivify a project the PM store hasn't seen (e.g. one created via the
    // base /projects flow) so the workspace always has somewhere to land.
    if (!proj) { proj = { id: projOne[1], name: "Project", status: "active", owner: null, dueDate: null, shortCode: deriveDemoShortCode("Project"), taskSeq: 0 }; projects.push(proj); }
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
    const customFields = (b.customFields && typeof b.customFields === "object" ? (b.customFields as Record<string, unknown>) : {});
    const recurrence = parseRecurrenceInput(b.recurrence);
    // P3-03: creation now also accepts subtask TITLES (turned into real Subtask
    // rows, unstarted) and tag IDS (validated against this task's own project's
    // registry, same rule as the PATCH leg above) — the "create from template"
    // path.
    const subtaskTitles = Array.isArray(b.subtasks)
      ? (b.subtasks as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : [];
    const subtasksArr: Subtask[] = subtaskTitles.map((title) => sub(nextId("s"), title, false));
    const estimateMinutes = typeof b.estimateMinutes === "number" ? b.estimateMinutes : null;
    const t = mkTask(nextId("t"), projectId, String(b.title ?? "New task"), "todo", (b.priority as Priority) ?? "normal", (b.assignee as Assignee) ?? null, subtasksArr, (b.milestoneId as string) ?? null, (b.dueDate as string) ?? null, String(b.description ?? ""), (b.startDate as string) || null, estimateMinutes, [], customFields, recurrence);
    if (Array.isArray(b.tags)) {
      const validIds = new Set(tagRegistry.filter((tg) => tg.projectId === projectId).map((tg) => tg.id));
      t.tags = (b.tags as unknown[]).filter((id): id is string => typeof id === "string" && validIds.has(id));
    }
    tasks.push(t);
    return { status: 201, json: { id: t.id } };
  }
  // Duplicate (P3-03): a fresh copy of the task in the same project, reset to
  // that project's first (position 0) status and 0% progress, subtasks cloned
  // unstarted, dependencies/logged-time NOT carried over (a duplicate starts
  // clean, it isn't a snapshot).
  const taskDuplicate = p.match(/^\/api\/[^/]+\/pm\/tasks\/([^/]+)\/duplicate$/);
  if (taskDuplicate && m === "POST") {
    const orig = tasks.find((x) => x.id === taskDuplicate[1]);
    if (!orig) return { status: 404, json: { error: "task not found" } };
    const dupStatus = intakeStatusId(statusesFor(orig.projectId)); // uncommitted copy → Backlog when present
    const copy: PmTask = {
      ...orig,
      id: nextId("t"),
      title: `${orig.title} (copy)`,
      status: dupStatus,
      progress: 0,
      subtasks: orig.subtasks.map((s) => ({ ...s, id: nextId("s"), done: false })),
      dependsOn: [],
      loggedMinutes: 0,
      tags: [...orig.tags],
      customFields: { ...orig.customFields },
      updatedAt: stamp(),
      contributors: [], // TR-32/backend pm.controller.ts: contributors are deliberately NOT copied
      ...taskDisplayCode(orig.projectId, nextTaskSeq(orig.projectId)), // WD-28: fresh seq, never the source's
    };
    tasks.push(copy);
    return { status: 201, json: { id: copy.id } };
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
    if (m === "PATCH") {
      const b = parse(body);
      // Tag ids must belong to THIS task's own project's registry — a stale or
      // foreign id (from a different project) is rejected outright rather than
      // silently dropped (design spec §6's cross-project tag-id rejection).
      if (Array.isArray(b.tags)) {
        const validIds = new Set(tagRegistry.filter((tg) => tg.projectId === t.projectId).map((tg) => tg.id));
        const bad = (b.tags as unknown[]).some((id) => typeof id !== "string" || !validIds.has(id));
        if (bad) return { status: 400, json: { error: "One or more tags don't belong to this task's project." } };
      }
      const spawned = patchTask(t, b);
      return ok({ ok: true, spawned });
    }
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

// Returns the spawned next-occurrence's { id, dueDate } when this PATCH just
// completed a recurring task (not-done→done edge, this task's own project
// registry, P2-05 flag-driven), else null. Mirrors pm.controller.ts's patchTask.
function patchTask(t: PmTask, b: Record<string, unknown>): { id: string; dueDate: string } | null {
  const wasDone = statusesFor(t.projectId).find((s) => s.id === t.status)?.isDone ?? false;
  const statusBefore = t.status; // P3-09 — for the follower-notification leg below

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
  if (b.assignee !== undefined) {
    const before = JSON.stringify(t.assignee ?? null);
    // Materialize the origin row FIRST, while `t.assignee` still holds the OLD value. Seeding after
    // the mutation records the incoming assignee as the task's "original" one and then appends the
    // same value again — a phantom extra row, and a history that lies about who held it first.
    assignmentHistoryFor(t.id);
    t.assignee = (b.assignee as Assignee) || null;
    // Append only on a REAL change — the backend gates on the same thing (applyRoleTransition
    // reports whether a role actually changed), so a no-op PATCH must not churn the ledger.
    if (JSON.stringify(t.assignee ?? null) !== before) {
      appendAssignmentEvent(t, DEMO_SELF, (b.assignmentNote as string) ?? null);
    }
  }
  if (typeof b.addSubtask === "string" && b.addSubtask.trim()) t.subtasks.push({ id: nextId("s"), title: b.addSubtask.trim(), done: false });
  if (typeof b.toggleSubtask === "string") {
    const s = t.subtasks.find((x) => x.id === b.toggleSubtask);
    if (s) s.done = !s.done;
  }
  if (typeof b.removeSubtask === "string") t.subtasks = t.subtasks.filter((x) => x.id !== b.removeSubtask);
  // ---- contributors (TR-02 backend §3.1, TR-32 FE wiring) — zero or more PERSONS,
  // logged-hours only, never outcome-credited. Mirrors pm.controller.ts's ops exactly:
  // `addContributor` validates the id is a known demo member (its "active tenant
  // member" check), is idempotent (no duplicate row), and `removeContributor` is a
  // plain filter. `t.contributors` is always an array in this store (mkTask seeds
  // `[]`) — the `undefined`-degrade path is a pure-UI concern, not a store concern.
  if (typeof b.addContributor === "string" && b.addContributor && MEMBERS[b.addContributor]) {
    const uid = b.addContributor;
    t.contributors ??= [];
    if (!t.contributors.some((c) => c.userId === uid)) {
      t.contributors.push({ userId: uid, name: MEMBERS[uid] });
    }
  }
  if (typeof b.removeContributor === "string") {
    t.contributors = (t.contributors ?? []).filter((c) => c.userId !== b.removeContributor);
  }
  if (Array.isArray(b.tags)) t.tags = b.tags as string[]; // already validated by the caller
  // Custom fields (P2-03, D17 framework reuse): the real backend validates against
  // the tenant's registry; demoPm can't import demoFixtures' CUSTOM_FIELDS (one-way
  // dependency), so it accepts the caller's values as-is — DEMO_MODE parity for the
  // happy path (define a field in Admin, fill it in, it round-trips on read).
  if (b.customFields && typeof b.customFields === "object" && !Array.isArray(b.customFields)) {
    t.customFields = b.customFields as Record<string, unknown>;
  }
  if (Object.prototype.hasOwnProperty.call(b, "recurrence")) t.recurrence = parseRecurrenceInput(b.recurrence);
  recompute(t);

  // P3-09 — a real status change notifies every follower (not just the person in
  // charge, which is the AI Tracker's own separate notification leg above).
  if (t.status !== statusBefore) {
    const label = statusesFor(t.projectId).find((s) => s.id === t.status)?.label ?? t.status;
    for (const uid of followerStore[t.id] ?? []) {
      trackerNotifications.push({
        id: nextId("n"), forUserId: uid, type: "pm.task.followed_status_change", read_at: null, created_at: stamp(),
        payload: { title: `${t.title} moved to “${label}”`, body: `A task you follow changed status.`, href: `/tasks/${t.id}`, entityType: "task", entityId: t.id, severity: "info" },
      });
    }
  }

  const afterStatuses = statusesFor(t.projectId);
  const isDoneNow = afterStatuses.find((s) => s.id === t.status)?.isDone ?? false;
  if (!(!wasDone && isDoneNow) || !t.recurrence) return null;

  const next = nextRecurrenceOccurrence(t.dueDate, t.startDate, t.recurrence);
  if (!next) return null;
  if (spawnedChildren.some((x) => x.parentId === t.id && x.dueDate === next.dueDate)) return null; // idempotency guard

  // P4-B8: `readyStatusId`, NOT "first non-done" — with Backlog at position 0 the latter parked
  // every fired occurrence where nobody would see it, and a recurrence that silently stops
  // producing visible work is indistinguishable from a broken recurrence.
  const spawnStatus = readyStatusId(afterStatuses);
  const child: PmTask = {
    id: nextId("t"), projectId: t.projectId, projectName: t.projectName, title: t.title, description: t.description,
    status: spawnStatus, priority: t.priority, progress: 0, assignee: t.assignee,
    subtasks: t.subtasks.map((s) => ({ ...s, done: false })), milestoneId: t.milestoneId,
    startDate: next.startDate, dueDate: next.dueDate, estimateMinutes: t.estimateMinutes, loggedMinutes: 0,
    dependsOn: [], tags: [...t.tags], customFields: { ...t.customFields }, updatedAt: stamp(), recurrence: t.recurrence,
    contributors: [], // TR-32: a spawned occurrence starts with no contributors, same as duplicate
    ...taskDisplayCode(t.projectId, nextTaskSeq(t.projectId)), // WD-28: a spawned occurrence is a real new task
  };
  tasks.push(child);
  spawnedChildren.push({ parentId: t.id, dueDate: next.dueDate });
  return { id: child.id, dueDate: next.dueDate };
}

// The AI Tracker: analyse the task, deliver docs/info + a comment + a
// notification to the person in charge, and record pending suggestions.
function runTracker(taskId: string): Result {
  const t = tasks.find((x) => x.id === taskId);
  if (!t) return { status: 404, json: { error: "task not found" } };
  const s = suggestFromTask(t, statusesFor(t.projectId));
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
      payload: { title: `AI Tracker update — ${t.title}`, body: `${s.rationale}${docLine}`, href: `/tasks/${t.id}`, entityType: "task", entityId: taskId, severity: "info" },
    });
  }

  return ok({ suggestions: made, delivered, comment: cbody, notified: responsibleId });
}
