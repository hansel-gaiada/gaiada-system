import "server-only";
// Project-management data layer — Repsona-style projects/tasks with a board,
// progress, poly-assignees (person | department | division + a responsible
// person), subtasks, milestones, docs, and an AI Tracker. The backend PM API
// (/api/:t/pm/*) does not exist yet; every reader DEGRADES gracefully (null/[]
// on 404/403) so pages ship ahead of the backend — same pattern as lib/it.ts
// and lib/admin.ts. In DEMO_MODE the whole surface is fully working against an
// in-memory store (lib/demoPm.ts).
//
// BFF CONTRACT (implement in platform-nest to match — see memory
// [[pm-ai-tracker-contract]]):
//   GET  /api/:t/pm/projects/:id                 -> PmProject
//   GET  /api/:t/pm/projects/:id/tasks           -> PmTask[]
//   GET  /api/:t/pm/tasks/:id                    -> PmTask
//   POST /api/:t/pm/tasks                        -> { id }         (create)
//   PATCH/api/:t/pm/tasks/:id                    -> { ok:true }    (status/progress/assignee/subtasks/...)
//   GET/POST/PATCH /api/:t/pm/projects/:id/milestones
//   GET/POST/PATCH /api/:t/pm/projects/:id/docs
//   GET  /api/:t/pm/tasks/:id/suggestions        -> TrackerSuggestion[]
//   POST /api/:t/pm/tasks/:id/tracker/run        -> { suggestions, delivered }
//   POST /api/:t/pm/suggestions/:id/confirm|dismiss
// Comments reuse the existing GET/POST /api/:t/comments?entityType=task&entityId=.
import { platformFetch, PlatformError } from "./platform";
import { getOrgStructure, type OrgNode } from "./org";
import { listMembers } from "./entities";

export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done",
};
export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];

export type AssigneeKind = "person" | "department" | "division";
export interface Assignee {
  kind: AssigneeKind;
  refId: string;      // person user_id, or org-node id for a unit
  refName: string;    // display name of the person/unit the work is assigned to
  responsibleId: string;   // the person in charge (always a real user) — AI delivers here
  responsibleName: string;
}

export interface Subtask { id: string; title: string; done: boolean }

export interface PmTask {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: Priority;
  progress: number; // 0-100
  assignee: Assignee | null;
  subtasks: Subtask[];
  milestoneId: string | null;
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  loggedMinutes: number;
  dependsOn: string[]; // task ids this task is blocked by
  updatedAt: string | null;
}

export interface TimeLog {
  id: string;
  taskId: string;
  userId: string;
  userName: string;
  minutes: number;
  spentOn: string; // yyyy-mm-dd
  billable: boolean;
  note: string;
}

export interface Milestone { id: string; projectId: string; name: string; dueDate: string | null; status: string }
export interface ProjectDoc { id: string; projectId: string; title: string; body: string; author: string | null; updatedAt: string | null }

export interface PmProject {
  id: string;
  name: string;
  status: string;
  progress: number;
  owner: Assignee | null;
  dueDate: string | null;
  milestones: Milestone[];
  docCount: number;
  taskCount: number;
}

export interface TrackerDoc { title: string; ref: string }
export interface TrackerSuggestion {
  id: string;
  taskId: string;
  kind: "progress" | "status";
  proposed: string; // stringified value (e.g. "80" or "in_progress")
  rationale: string;
  docs: TrackerDoc[];
  status: "pending" | "applied" | "dismissed";
  createdAt: string;
}

export interface Comment {
  id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  parent_comment_id: string | null;
  created_at: string;
  ai?: boolean; // rendered with an "AI Tracker" badge
}

async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return fallback;
    throw e;
  }
}

// ---- Readers (all degrade) ----
export const getPmProject = (u: string, t: string, id: string) =>
  skipUnavailable(platformFetch<PmProject | null>(`/api/${t}/pm/projects/${id}`, u), null);
export const listPmTasks = (u: string, t: string, projectId: string) =>
  skipUnavailable(platformFetch<PmTask[]>(`/api/${t}/pm/projects/${projectId}/tasks`, u), [] as PmTask[]);
// Tenant-wide task list (unifies the Tasks page onto the rich PM model).
export const listAllPmTasks = (u: string, t: string, q: { assignee?: string } = {}) =>
  skipUnavailable(platformFetch<PmTask[]>(`/api/${t}/pm/tasks${q.assignee ? `?assignee=${q.assignee}` : ""}`, u), [] as PmTask[]);
export const getPmTask = (u: string, t: string, id: string) =>
  skipUnavailable(platformFetch<PmTask | null>(`/api/${t}/pm/tasks/${id}`, u), null);
export const listMilestones = (u: string, t: string, projectId: string) =>
  skipUnavailable(platformFetch<Milestone[]>(`/api/${t}/pm/projects/${projectId}/milestones`, u), [] as Milestone[]);
export const listDocs = (u: string, t: string, projectId: string) =>
  skipUnavailable(platformFetch<ProjectDoc[]>(`/api/${t}/pm/projects/${projectId}/docs`, u), [] as ProjectDoc[]);
export const getDoc = (u: string, t: string, projectId: string, docId: string) =>
  skipUnavailable(platformFetch<ProjectDoc | null>(`/api/${t}/pm/projects/${projectId}/docs/${docId}`, u), null);
export const listSuggestions = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<TrackerSuggestion[]>(`/api/${t}/pm/tasks/${taskId}/suggestions`, u), [] as TrackerSuggestion[]);
export const listTaskComments = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<Comment[]>(`/api/${t}/comments?entityType=task&entityId=${taskId}`, u), [] as Comment[]);
export const listTimeLogs = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<TimeLog[]>(`/api/${t}/pm/tasks/${taskId}/time`, u), [] as TimeLog[]);

// ---- Assignee source: org units + their people, plus all company members ----
export interface AssignablePerson { id: string; name: string }
export interface AssignableUnit { kind: "department" | "division"; id: string; name: string; people: AssignablePerson[] }
export interface Assignable { units: AssignableUnit[]; members: AssignablePerson[] }

export async function assignableUnits(u: string, t: string): Promise<Assignable> {
  const members = await skipUnavailable(listMembers(u, t), []);
  const memberList: AssignablePerson[] = members.map((m) => ({ id: m.user_id, name: m.name }));
  const company = { id: t, name: t, type: null };
  const units: AssignableUnit[] = [];
  try {
    const { structure } = await getOrgStructure(u, t, company);
    const walk = (node: OrgNode) => {
      if (node.kind === "department" || node.kind === "division") {
        units.push({ kind: node.kind, id: node.id, name: node.name, people: collectPeople(node) });
      }
      node.children.forEach(walk);
    };
    structure.root.children.forEach(walk);
  } catch {
    /* org unavailable — units stay empty, person assignment still works */
  }
  return { units, members: memberList };
}

// All person-nodes (assigned) anywhere under a unit.
function collectPeople(node: OrgNode): AssignablePerson[] {
  const out: AssignablePerson[] = [];
  const walk = (n: OrgNode) => {
    if (n.assigneeId && n.kind === "person") out.push({ id: n.assigneeId, name: n.assigneeName ?? n.name });
    n.children.forEach(walk);
  };
  node.children.forEach(walk);
  return out;
}

// ================= Pure helpers (unit-tested) =================

export function taskProgressFromSubtasks(subtasks: Subtask[]): number {
  if (subtasks.length === 0) return 0;
  return Math.round((subtasks.filter((s) => s.done).length / subtasks.length) * 100);
}

export function projectProgress(tasks: { progress: number }[]): number {
  if (tasks.length === 0) return 0;
  return Math.round(tasks.reduce((n, t) => n + (t.progress || 0), 0) / tasks.length);
}

export function resolveResponsible(assignee: Assignee | null): AssignablePerson | null {
  if (!assignee || !assignee.responsibleId) return null;
  return { id: assignee.responsibleId, name: assignee.responsibleName || assignee.responsibleId };
}

export interface BoardColumn { status: TaskStatus; label: string; tasks: PmTask[] }
export function groupByStatus(tasks: PmTask[]): BoardColumn[] {
  return TASK_STATUSES.map((status) => ({
    status,
    label: STATUS_LABEL[status],
    tasks: tasks.filter((t) => t.status === status),
  }));
}

export interface Suggestion { progress: number; status: TaskStatus; rationale: string }
// Deterministic tracker analysis: derive progress from subtasks (if any) and a
// status transition from that progress. Pure so it's testable; the doc/comment/
// notification delivery lives in the tracker runner (demoPm / backend).
export function suggestFromTask(task: PmTask): Suggestion {
  const sub = task.subtasks ?? [];
  const progress = sub.length > 0 ? taskProgressFromSubtasks(sub) : task.progress;
  let status: TaskStatus = task.status;
  if (progress >= 100) status = "done";
  else if (progress > 0 && task.status === "todo") status = "in_progress";
  const done = sub.filter((s) => s.done).length;
  const rationale =
    sub.length > 0
      ? `${done}/${sub.length} subtasks complete → ${progress}% progress${status !== task.status ? `, move to “${STATUS_LABEL[status]}”` : ""}.`
      : `No subtasks to measure; holding at ${progress}%. Add a checklist for finer tracking.`;
  return { progress, status, rationale };
}

// ---- dependencies ----
// Would adding "blocker → blocked" (blocked depends on blocker) create a cycle?
// True if blocker already (transitively) depends on blocked. Pure.
export function wouldCreateCycle(tasks: PmTask[], blockedId: string, blockerId: string): boolean {
  if (blockedId === blockerId) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const reaches = (fromId: string, targetId: string): boolean => {
    if (fromId === targetId) return true;
    if (seen.has(fromId)) return false;
    seen.add(fromId);
    const t = byId.get(fromId);
    return (t?.dependsOn ?? []).some((d) => reaches(d, targetId));
  };
  return reaches(blockerId, blockedId);
}

// Dependencies of `task` that aren't done yet (so `task` is really blocked). Pure.
export function openDependencies(task: PmTask, byId: Map<string, PmTask>): PmTask[] {
  return (task.dependsOn ?? []).map((id) => byId.get(id)).filter((d): d is PmTask => !!d && d.status !== "done");
}

// ---- time tracking ----
export interface TimeSummary { total: number; billable: number; entries: number }
export function timeSummary(logs: TimeLog[]): TimeSummary {
  return logs.reduce<TimeSummary>(
    (s, l) => ({ total: s.total + l.minutes, billable: s.billable + (l.billable ? l.minutes : 0), entries: s.entries + 1 }),
    { total: 0, billable: 0, entries: 0 },
  );
}
export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(1)}h`;
}

// ---- Gantt / timeline ----
export interface TimelineBar { task: PmTask; offsetPct: number; widthPct: number; startsMissing: boolean }
export interface Timeline { start: string; end: string; days: number; bars: TimelineBar[] }
const DAY = 24 * 3600 * 1000;
const iso = (d: number) => new Date(d).toISOString().slice(0, 10);
// Lay tasks out on a shared date axis using startDate→dueDate (falling back to
// a 1-day bar at due, or the whole range when a task has no dates). Pure given
// the task date strings (no Date.now dependence). Empty when nothing is dated.
export function computeTimeline(tasks: PmTask[]): Timeline | null {
  const dated = tasks.filter((t) => t.startDate || t.dueDate);
  if (dated.length === 0) return null;
  const stamps: number[] = [];
  for (const t of dated) {
    if (t.startDate) stamps.push(Date.parse(t.startDate));
    if (t.dueDate) stamps.push(Date.parse(t.dueDate));
  }
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  const startMs = min - DAY; // one day of padding each side
  const endMs = max + DAY;
  const span = Math.max(DAY, endMs - startMs);
  const bars: TimelineBar[] = tasks.map((t) => {
    const s = t.startDate ? Date.parse(t.startDate) : t.dueDate ? Date.parse(t.dueDate) : startMs;
    const e = t.dueDate ? Date.parse(t.dueDate) : s + DAY;
    const clampedS = Math.max(startMs, Math.min(s, endMs));
    const clampedE = Math.max(clampedS + DAY / 2, Math.min(e + DAY, endMs));
    return {
      task: t,
      offsetPct: ((clampedS - startMs) / span) * 100,
      widthPct: Math.min(100, ((clampedE - clampedS) / span) * 100),
      startsMissing: !t.startDate,
    };
  });
  return { start: iso(startMs), end: iso(endMs), days: Math.round(span / DAY), bars };
}
