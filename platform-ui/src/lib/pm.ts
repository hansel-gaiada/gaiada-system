import "server-only";
// Project-management data layer — Repsona-style projects/tasks with a board,
// progress, poly-assignees (person | department | division + a responsible
// person), subtasks, milestones, docs, and an AI Tracker. The backend PM API
// (/api/:t/pm/*) is BUILT and live (platform-nest/src/modules/pm/pm.controller.ts,
// migration 0018) — every call here goes through platformFetch against the real
// endpoints below. Readers still DEGRADE gracefully (null/[] on 404/403) so this
// surface tolerates the module being disabled for a tenant or a stale deploy —
// same defensive pattern as lib/it.ts and lib/admin.ts, not a "backend missing"
// workaround. In DEMO_MODE (env-gated, see lib/platform.ts + lib/demoFixtures.ts)
// the whole surface instead runs fully in-memory against lib/demoPm.ts, for
// browsing the UI with no backend at all.
//
// BFF CONTRACT (implemented in platform-nest to match — see memory
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
//   GET/POST /api/:t/pm/projects/:id/tags                 -> Tag[] / { id }
//   PATCH/DELETE /api/:t/pm/projects/:id/tags/:tagId       -> { ok:true } (DELETE:
//     409 { inUse:true } unless ?force=1 — P2-02, design spec §6)
//   PATCH /api/:t/pm/tasks/:id accepts { tags: string[] } (tag ids from that
//     task's own project's registry; cross-project ids are rejected)
//   GET/POST /api/:t/pm/templates?kind=task            -> Template[] / { id }
//   PATCH/DELETE /api/:t/pm/templates/:id               -> { ok:true } (P3-03)
//   POST /api/:t/pm/tasks/:taskId/duplicate             -> { id } (P3-03)
//   POST /api/:t/pm/tasks now also accepts { subtasks: string[], tags: string[] }
//     (subtask titles + tag ids) at creation time (P3-03)
//   GET  /api/:t/pm/tasks/:id/followers          -> Follower[]   (P3-09)
//   POST/DELETE /api/:t/pm/tasks/:id/follow      -> { ok:true }  (P3-09, self-scoped
//     member-level — no pm.manage — a member follows/unfollows THEMSELVES)
//   GET  /api/:t/pm/docs/:docId/versions             -> DocVersion[] (P3-11, META only —
//     no body — [{version,authorId,authorName,createdAt}])
//   GET  /api/:t/pm/docs/:docId/versions/:v          -> DocVersionFull (full {version,
//     title,body,authorName,createdAt})
//   POST /api/:t/pm/docs/:docId/versions/:v/restore  -> { ok:true } (P3-11 — sets the doc
//     to version v's content AND appends a NEW version authored by the restorer; nothing
//     is ever rewritten). `getDoc`/`listDocs` now include the doc's current `version` number.
//   Note templates reuse the P3-01/P3-03 template endpoints with `kind=doc` (P3-11).
//   GET  /api/:t/pm/tasks now answers { items, nextCursor } (was a bare PmTask[]) and accepts
//     status[]/tag[]/priority[]/responsible[]/ball[]/milestone[]/dueFrom/dueTo/q/overdueOnly/
//     dueSoon/dueSoonDays/includeClosed/includeSubtasks(no-op)/cursor/limit (P4-A1, landed
//     2026-08-07). `includeClosed` defaults FALSE server-side (done tasks hidden) — see
//     listAllPmTasksPaged's own doc for why this reader defaults it back to true.
//   GET /api/:t/pm/flow, GET /api/:t/pm/burndown — tenant-grain siblings of the per-project
//     versions, same response shape, pre-merged across every project (P4-A2, landed 2026-08-07).
// Comments reuse the existing GET/POST /api/:t/comments?entityType=task&entityId=.
//   POST /api/:t/comments/:commentId/reactions {emoji}          -> { ok:true } (P3-09,
//     idempotent — reacting twice with the same emoji is a no-op, not a duplicate)
//   DELETE /api/:t/comments/:commentId/reactions/:emoji         -> { ok:true } (P3-09,
//     self-row only). `listComments`/`listTaskComments` now return each comment's
//     `reactions: [{emoji,count,mine}]` aggregated over a CLOSED 8-emoji set
//     (👍 ❤️ 🎉 👀 ✅ 💡 🙏 🔥).
import { platformFetch, PlatformError } from "./platform";
import { getOrgStructure, type OrgNode } from "./org";
import { listMembers } from "./entities";
import type { TagColor } from "./tagColors";
// Client-safe vocabulary module (P4-L2) — the single home for status LABELS, so a picker rendered in
// a client component and the synthesized DEFAULT_STATUSES below can never disagree about wording.
import { PM_STATUS_LADDER } from "./pmVocabulary";
export type { TagColor } from "./tagColors";

// Legacy status ids/labels. `TaskStatus` is no longer the board's column model
// (that's the per-project ProjectStatus[] below) — it survives only as the id
// set + label map for the SYNTHESIZED defaults and as the fallback when a task's
// status id predates a project's registry. `PmTask.status` is now a plain string
// (a ProjectStatus id), custom per project.
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done";
export const TASK_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do", in_progress: "In progress", blocked: "Blocked", done: "Done",
};

// Per-project configurable workflow statuses (P2-05, design spec §7). Replaces
// the fixed TaskStatus union as the board's column model: a project's ordered
// ProjectStatus[] drives groupByStatus, and the isDone/isBlocked FLAGS (never a
// literal id string-match) drive every KPI / health-ring / AI-tracker
// derivation. `color` is a hex string; the four synth defaults carry the exact
// legacy board/Gantt hues so a project that never opens the editor is
// pixel-identical to today.
export interface ProjectStatus {
  id: string;
  label: string;
  color: string;      // hex (#RRGGBB) — see DEFAULT_STATUSES for the legacy tones
  isDone: boolean;
  isBlocked: boolean;
  wipLimit?: number;
  position: number;
}

// The default ladder, synthesized for any project with no status-registry rows.
//
// P4-B8 (2026-08-06): this used to be the "legacy 4" (To do / In progress / Blocked / Done) with
// house-palette hues. It is now DERIVED from `PM_STATUS_LADDER` — the owner's
// `Backlog · ToDo · Doing · Blocked · Done` — so the labels have exactly one home
// (`lib/pmVocabulary.ts`, which is client-safe and therefore usable by the pickers too). Colours
// stay here because they are design tokens, not vocabulary, and they now point at the
// Repsona-faithful PM palette (`styles/tokens/pm.css`) per workstream L.
//
// TWO CONSEQUENCES, both deliberate and owner-approved:
//   1. Every project still on the synthesized set GAINS a Backlog column. Without that the ladder
//      the owner specified would not exist for the majority of projects, which are exactly the ones
//      that never customized a registry.
//   2. `isSynthDefaultStatuses` below therefore no longer means "the legacy 4" — it means "still on
//      the current defaults". Its purpose (keep never-customized projects visually quiet) is
//      unchanged; the set it recognises has grown by one.
// `in_progress` KEEPS ITS PERSISTED ID and only gains the label "Doing" — renaming the id would
// orphan every existing task row (pinned by lib/pmVocabulary.test.ts).
const DEFAULT_STATUS_COLOR: Record<string, string> = {
  backlog:     "var(--pm-status-backlog)",
  todo:        "var(--pm-status-todo)",
  in_progress: "var(--pm-status-in-progress)",
  blocked:     "var(--pm-status-blocked)",
  done:        "var(--pm-status-done)",
};
export const DEFAULT_STATUSES: ProjectStatus[] = PM_STATUS_LADDER.map((s, i) => ({
  id: s.id,
  label: s.label,
  // A ladder entry with no mapped hue would render an invisible column head, so fall back to the
  // neutral slate rather than to an empty string.
  color: DEFAULT_STATUS_COLOR[s.id] ?? "var(--pm-status-backlog)",
  isDone: s.isDone,
  isBlocked: s.isBlocked,
  position: i,
}));
export const synthDefaultStatuses = (): ProjectStatus[] => DEFAULT_STATUSES.map((s) => ({ ...s }));

// True when a status set is (structurally) just the synthesized defaults — the board uses this to
// keep never-customized projects visually quiet (no status-colour dots on the column heads until a
// project is actually customized). P4-B8: "the defaults" is now the 5-status ladder, not the legacy 4.
export function isSynthDefaultStatuses(statuses: ProjectStatus[]): boolean {
  if (statuses.length !== DEFAULT_STATUSES.length) return false;
  const byId = new Map(statuses.map((s) => [s.id, s]));
  return DEFAULT_STATUSES.every((d) => {
    const s = byId.get(d.id);
    return !!s && s.label === d.label && s.color === d.color && s.isDone === d.isDone && s.isBlocked === d.isBlocked;
  });
}

export interface StatusFlags { isDone: boolean; isBlocked: boolean }

// ---- "where does a new task start?" — two DIFFERENT answers (P4-B8) ----
// Adding `Backlog` at position 0 exposed that several call sites all reached for "the first status"
// (`statuses[0]`, or `find(s => !s.isDone)`) while meaning two different things. Once Backlog exists
// those two intents diverge, and the failure is SILENT: a spawned recurring occurrence lands in
// Backlog, nobody sees it in ToDo, and the recurrence looks like it stopped working. Naming both
// intents is the fix — a bare `statuses[0]` in PM code is now a smell.
//
// Ordering is by `position`, never array order, because a registry read may arrive unsorted.

/** Fresh, uncommitted work (a duplicate, an imported task): the earliest non-done status — Backlog when the project has one. */
export function intakeStatusId(statuses: ProjectStatus[]): string {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  return (ordered.find((s) => !s.isDone) ?? ordered[0])?.id ?? "todo";
}

/**
 * Work that is READY to be picked up right now — a recurrence firing, or a task whose last blocker
 * just cleared (workstream I's auto-promotion). Prefers the canonical `todo` id, since that is the
 * persisted id of "ready" in our own ladder; otherwise the earliest status that is neither done nor
 * blocked, which reproduces the pre-Backlog behaviour for a fully custom registry.
 */
export function readyStatusId(statuses: ProjectStatus[]): string {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  // The `todo` preference is by id, so it MUST be re-checked against the flags: a project is free to
  // mark the literal `todo` status done or blocked, and trusting the id alone would drop new work
  // straight into a done column. The flags are the authority; the id is only a tie-breaker among
  // statuses that are already valid landing spots. (platform-nest carries the identical guard.)
  const canonical = ordered.find((s) => s.id === "todo" && !s.isDone && !s.isBlocked);
  if (canonical) return canonical.id;
  return (ordered.find((s) => !s.isDone && !s.isBlocked) ?? ordered.find((s) => !s.isDone) ?? ordered[0])?.id ?? "todo";
}
// THE one place status semantics live. Resolve a task's status id to its
// done/blocked flags against the project's OWN status set. Falls back to
// legacy-id semantics when the set is absent or the id predates it
// ("done"→isDone, "blocked"→isBlocked) so callers that don't (yet) thread the
// registry stay correct for default projects. Everything downstream
// (KPIs/health/AI-tracker) derives from THESE flags — no literal id matching.
export function statusFlags(statusId: string, statuses?: ProjectStatus[]): StatusFlags {
  const s = statuses?.find((x) => x.id === statusId);
  if (s) return { isDone: s.isDone, isBlocked: s.isBlocked };
  return { isDone: statusId === "done", isBlocked: statusId === "blocked" };
}
export const isDoneStatus = (statusId: string, statuses?: ProjectStatus[]): boolean => statusFlags(statusId, statuses).isDone;
export const isBlockedStatus = (statusId: string, statuses?: ProjectStatus[]): boolean => statusFlags(statusId, statuses).isBlocked;
export type Priority = "low" | "normal" | "high" | "urgent";
export const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];
export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };

export type AssigneeKind = "person" | "department" | "division";
export interface Assignee {
  kind: AssigneeKind;
  refId: string;      // person user_id, or org-node id for a unit
  refName: string;    // display name of the person/unit the work is assigned to
  responsibleId: string;   // the person in charge (always a real user) — AI delivers here
  responsibleName: string;
}

export interface Subtask { id: string; title: string; done: boolean }

// ---- contributors (TR-02, tracker-reporting-foundation.md §3.1) ----
// ADDITIVE ONLY: zero or more persons logged against a task, listed with hours, never
// outcome-credited. This does NOT change `Assignee` — the blob stays the FE wire format for
// owner/responsible; contributors are a brand-new, separate array read off the relational
// pm_task_assignees substrate (migration 0054). Absent/omitted on a stale backend, same
// degrade-gracefully convention as `Follower`/`reactions` below.
export interface Contributor { userId: string; name: string }

// ---- recurrence (P2-06, design spec §8) ----
// The constants/type live in the client-safe `pmRecurrence` module (this file is
// `server-only`, but the client NewTaskForm needs the values); re-exported here
// so existing server-side callers keep importing them from "./pm".
import { RECURRENCE_FREQS, RECURRENCE_LABEL, type RecurrenceFreq } from "./pmRecurrence";
export { RECURRENCE_FREQS, RECURRENCE_LABEL, type RecurrenceFreq };

// ---- urgency: overdue · almost late · in time (P4-G1/G2) ----
// Same split rationale as the recurrence block above: `lib/pmUrgency.ts` is client-safe because the
// board cards / Gantt bars / List rows that render an urgency badge are CLIENT components and cannot
// import this `server-only` module. Re-exported so server callers keep importing from "./pm".
// `taskUrgency` needs a precomputed `isDone` — resolve it here with `isDoneStatus(task.status,
// projectStatuses)` before handing tasks to a client component, exactly like `taskTags`.
export {
  taskUrgency, projectUrgency, rollUpUrgency, dayDiff,
  DUE_SOON_DAYS_DEFAULT, URGENCY_SEVERITY, URGENCY_LABEL,
  type UrgencyTier, type UrgencyInput, type UrgencyOptions, type UrgencyRollUp,
} from "./pmUrgency";
export interface TaskRecurrence { freq: RecurrenceFreq; until?: string }
// A recurring task's title everywhere it renders gets a leading "↻ " glyph
// (board card, list/detail, Gantt label, dept rail) — one tiny pure helper so
// every render site stays byte-identical instead of re-deriving the prefix.
export function titleWithRecurrenceGlyph(task: { title: string; recurrence?: TaskRecurrence | null }): string {
  return task.recurrence ? `↻ ${task.title}` : task.title;
}

// Shift a YYYY-MM-DD date forward by one occurrence of `freq`. Monthly clamps
// the day-of-month to the target month's last day (calendar-month semantics —
// Jan 31 + 1 month = Feb 28/29, never overflowing into March). Mirrors the
// backend's pm.controller.ts addFreq exactly — DEMO_MODE parity (lib/demoPm.ts).
export function addRecurrenceFreq(dateStr: string, freq: RecurrenceFreq): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  if (freq === "monthly") {
    let ny = y;
    let nm = mo + 1;
    if (nm > 12) { nm = 1; ny += 1; }
    const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const nd = Math.min(d, lastDay);
    return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
  }
  const days = freq === "daily" ? 1 : freq === "weekly" ? 7 : 14;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// The next occurrence's dates, or null when there's nothing to spawn: no due
// date to anchor on, or the shifted due date would land after `until`.
export function nextRecurrenceOccurrence(
  dueDate: string | null,
  startDate: string | null,
  rec: TaskRecurrence,
): { startDate: string | null; dueDate: string } | null {
  if (!dueDate) return null;
  const nextDue = addRecurrenceFreq(dueDate, rec.freq);
  if (rec.until && nextDue > rec.until) return null;
  const nextStart = startDate ? addRecurrenceFreq(startDate, rec.freq) : null;
  return { startDate: nextStart, dueDate: nextDue };
}

// Per-project tag registry (P2-02, design spec §6). `color` is a closed
// 8-slug set — see lib/tagColors.ts for the actual hex values + the AA
// verification note (kept out of this server-only file so client components
// can import the color constants directly).
export interface Tag { id: string; label: string; color: TagColor }

export interface PmTask {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  description: string;
  status: string; // a ProjectStatus id from this task's OWN project's registry (P2-05)
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
  tags: string[]; // Tag ids, scoped to this task's OWN project's registry
  customFields: Record<string, unknown>; // D17 custom fields, entityType "pm_task" (P2-03)
  updatedAt: string | null;
  recurrence: TaskRecurrence | null; // P2-06, design spec §8
  // WD-28: per-project short-code + atomic per-project seq. `projectShortCode` is the parent
  // project's code (same value as `PmProject.shortCode`, joined here for convenience);
  // `displayCode` is the server-computed "CODE-SEQ" form (e.g. "WEB-142") — null if either half
  // is missing (a task created outside the allocator, or a project predating the backfill).
  projectShortCode: string | null;
  seq: number | null;
  displayCode: string | null;
  // TR-02: additive, optional so existing fixtures/demo data/older backends need no changes.
  contributors?: Contributor[];
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
// `version` (P3-11) is the doc's CURRENT version number — bumped on every real
// edit (never on a no-op save) and again on every restore, so it always names
// the newest row in that doc's version history.
export interface ProjectDoc { id: string; projectId: string; title: string; body: string; author: string | null; updatedAt: string | null; version: number }

// ---- doc version history (P3-11) ----
// `DocVersion` is the META-only list row (no body — keeps the list cheap);
// `DocVersionFull` is what a single version's GET returns. Append-only: a
// restore never rewrites an existing row, it always creates the next one.
export interface DocVersion { version: number; authorId: string; authorName: string; createdAt: string }
export interface DocVersionFull { version: number; title: string; body: string; authorName: string; createdAt: string }

export interface PmProject {
  id: string;
  name: string;
  status: string;
  // P4-H1: the AUTHORED range's opening end. The backend's single-project read has returned this
  // since cc769d1; it was missing here, so P4-H3 reached it through a cast. Decision 12 is that the
  // range is authored and the task-derived envelope is shown ALONGSIDE it — the gap between the two
  // is the slippage signal — so this must never be overwritten from task dates.
  // NOTE the bulk `GET /api/:t/projects` list does NOT yet select `start_date`, only this
  // single-project read does, which is why the list pages can show a target but no authored start.
  startDate: string | null;
  shortCode: string | null; // WD-28: unique per tenant, derived on creation + backfilled for legacy rows
  progress: number;
  owner: Assignee | null;
  dueDate: string | null;
  milestones: Milestone[];
  docCount: number;
  taskCount: number;
  statuses: ProjectStatus[]; // this project's ordered workflow statuses (P2-05); empty ⇒ synth defaults
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

// A single reaction glyph's aggregate on one comment (P3-09) — `mine` reflects
// the CALLING user's own row, so the toggle-off state renders without a
// second round-trip.
export interface ReactionSummary { emoji: string; count: number; mine: boolean }

export interface Comment {
  id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  parent_comment_id: string | null;
  created_at: string;
  ai?: boolean; // rendered with an "AI Tracker" badge
  reactions?: ReactionSummary[]; // P3-09 — absent/omitted on a stale backend, never an error
}

// ---- task followers (P3-09) ----
export interface Follower { id: string; name: string }

// ---- assignment/ball history (P4-B1..B4, migration 0087) ----
// The append-only chain beside `pm_tasks.assignee` (plan §1.5): passing the ball never erases the
// previous holder, it appends a row. `refId`/`refKind`/`refName` mirror `Assignee.refId`/`kind` at
// the moment of the write (the "Ball"); `responsibleId`/`responsibleName` mirror
// `Assignee.responsibleId` (the "Responsible"); `statusId` is the task's status AT the moment of
// handoff, not its current one. Names are resolved server-side (pm.controller.ts's
// getAssignmentHistory join) so this reader never needs a second round-trip to look anyone up.
// `refId`/`refKind`/`responsibleId` are nullable — an "unassigned" write still appends a row.
export interface AssignmentEvent {
  id: string;
  refId: string | null;
  refKind: AssigneeKind | null;
  refName: string | null;
  responsibleId: string | null;
  responsibleName: string | null;
  statusId: string;
  note: string | null;
  changedBy: string | null;
  changedByName: string | null;
  createdAt: string;
}
// Newest-first (the backend orders by created_at DESC — same convention as every other append-only
// history reader here, e.g. listDocVersions). Degrades to [] on 404/403 same as every other PM
// reader (stale backend before migration 0087 lands, or the module disabled for this tenant) — the
// timeline then renders "No history yet" rather than an error.
export const listAssignmentHistory = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<AssignmentEvent[]>(`/api/${t}/pm/tasks/${taskId}/assignment-history`, u), [] as AssignmentEvent[]);

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
// P4-A1 made this endpoint paginated: it now answers `{ items, nextCursor }` where it used to
// answer a bare `PmTask[]`. SIX callers depend on this reader — lib/departments.ts (every department
// board/timeline/projects page), /tasks, /calendar, /projects and lib/queue.ts (My Work) — so the
// unwrap happens HERE, once, and every caller keeps its `PmTask[]` contract untouched.
//
// It tolerates BOTH shapes on purpose, the same way lib/envelope.ts's `normalizeEnvelope` tolerates
// a bare array from an ungraduated endpoint. That is not defensive noise: this UI is deployed
// separately from the backend, so during any rollout one side is briefly older than the other, and
// the failure mode of guessing wrong is a runtime `.filter is not a function` on half the PM
// surface. Note the demo fixture already returns the paginated shape, so DEMO_MODE exercises the
// real contract rather than hiding the difference — which is exactly how this drift stayed
// invisible to `tsc`, the unit suite AND the demo build until it was read against the live handler.
//
// NOTE this reader deliberately returns only the first page. The facets and cursor A1 added are for
// the `@all` scope (P4-A5) to consume through a paginated reader of its own; every caller here wants
// "the tenant's tasks" for aggregation, and silently paginating them would under-report.
type PmTaskPage = { items: PmTask[]; nextCursor?: string | null };
export const listAllPmTasks = async (u: string, t: string, q: { assignee?: string } = {}): Promise<PmTask[]> => {
  const res = await skipUnavailable(
    platformFetch<PmTask[] | PmTaskPage>(`/api/${t}/pm/tasks${q.assignee ? `?assignee=${q.assignee}` : ""}`, u),
    [] as PmTask[],
  );
  if (Array.isArray(res)) return res;
  return Array.isArray(res?.items) ? res.items : [];
};
// ---- @all scope reader (P4-A1 landed 2026-08-07; P4-A3/A5 are the consumers) ----
// `listAllPmTasks` above deliberately stops at the FIRST page — six existing callers want "the
// tenant's tasks" for aggregation and would silently under-report if this reader looped underneath
// them, so it stays exactly as it is. The `@all` PM scope (plan §1.1/§3 workstream A) needs EVERY
// task, following `nextCursor` until the backend reports none, plus the server-side facets P4-A1
// added — so this is a separate reader, not a change to that one.
//
// `includeClosed` defaults to `true` HERE, unlike the backend's own default (`false` — done tasks
// hidden). Every other PM surface a task can appear in — a single project's board, a department's
// board — shows its Done column populated; a tenant-wide board that silently hid every finished
// task would be the one place in the app where "Done" looks empty for no visible reason. A caller
// that genuinely wants "open work only" passes `includeClosed: false` explicitly (same shape as
// `overdueOnly`/`dueSoon` below).
export interface PmTaskFilters {
  status?: string[]; tag?: string[]; priority?: string[]; responsible?: string[]; ball?: string[];
  milestone?: string[]; dueFrom?: string; dueTo?: string; q?: string; overdueOnly?: boolean;
  dueSoon?: boolean; dueSoonDays?: number; includeClosed?: boolean;
}
export const listAllPmTasksPaged = async (u: string, t: string, filters: PmTaskFilters = {}): Promise<PmTask[]> => {
  const { includeClosed = true, ...rest } = filters;
  const out: PmTask[] = [];
  let cursor: string | undefined;
  // A runaway-loop guard only (a backend bug that never returns a null cursor) — 200 pages * the
  // 200-row max page size is 40k tasks; a real tenant exhausts its work long before that.
  const MAX_PAGES = 200;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams();
    const arrays: [string, string[] | undefined][] = [
      ["status", rest.status], ["tag", rest.tag], ["priority", rest.priority],
      ["responsible", rest.responsible], ["ball", rest.ball], ["milestone", rest.milestone],
    ];
    // Repeated keys (`?tag=a&tag=b`) — the backend accepts either that or comma-separated; repeated
    // is the shape `URLSearchParams` produces natively, no manual joining to get wrong.
    for (const [key, values] of arrays) for (const v of values ?? []) qs.append(key, v);
    if (rest.dueFrom) qs.set("dueFrom", rest.dueFrom);
    if (rest.dueTo) qs.set("dueTo", rest.dueTo);
    if (rest.q) qs.set("q", rest.q);
    if (rest.overdueOnly) qs.set("overdueOnly", "1");
    if (rest.dueSoon) qs.set("dueSoon", "1");
    if (rest.dueSoonDays !== undefined) qs.set("dueSoonDays", String(rest.dueSoonDays));
    if (includeClosed) qs.set("includeClosed", "1");
    qs.set("limit", "200");
    if (cursor) qs.set("cursor", cursor);
    const res = await skipUnavailable(
      platformFetch<PmTaskPage | PmTask[]>(`/api/${t}/pm/tasks?${qs.toString()}`, u),
      { items: [] } as PmTaskPage,
    );
    const items = Array.isArray(res) ? res : (res.items ?? []);
    out.push(...items);
    const next = Array.isArray(res) ? undefined : res.nextCursor;
    if (!next) break;
    cursor = next;
  }
  return out;
};
export const getPmTask = (u: string, t: string, id: string) =>
  skipUnavailable(platformFetch<PmTask | null>(`/api/${t}/pm/tasks/${id}`, u), null);
export const listMilestones = (u: string, t: string, projectId: string) =>
  skipUnavailable(platformFetch<Milestone[]>(`/api/${t}/pm/projects/${projectId}/milestones`, u), [] as Milestone[]);
export const listDocs = (u: string, t: string, projectId: string) =>
  skipUnavailable(platformFetch<ProjectDoc[]>(`/api/${t}/pm/projects/${projectId}/docs`, u), [] as ProjectDoc[]);
export const getDoc = (u: string, t: string, projectId: string, docId: string) =>
  skipUnavailable(platformFetch<ProjectDoc | null>(`/api/${t}/pm/projects/${projectId}/docs/${docId}`, u), null);
// ---- doc version history (P3-11) ----
export const listDocVersions = (u: string, t: string, docId: string) =>
  skipUnavailable(platformFetch<DocVersion[]>(`/api/${t}/pm/docs/${docId}/versions`, u), [] as DocVersion[]);
export const getDocVersion = (u: string, t: string, docId: string, v: number) =>
  skipUnavailable(platformFetch<DocVersionFull | null>(`/api/${t}/pm/docs/${docId}/versions/${v}`, u), null);
export const listSuggestions = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<TrackerSuggestion[]>(`/api/${t}/pm/tasks/${taskId}/suggestions`, u), [] as TrackerSuggestion[]);
export const listTaskComments = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<Comment[]>(`/api/${t}/comments?entityType=task&entityId=${taskId}`, u), [] as Comment[]);
// P3-09 — degrades to [] on 404/403 same as every other PM reader (stale backend/disabled module);
// the Follow toggle then renders unfollowed with no follower count rather than erroring.
export const listFollowers = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<Follower[]>(`/api/${t}/pm/tasks/${taskId}/followers`, u), [] as Follower[]);
export const listTimeLogs = (u: string, t: string, taskId: string) =>
  skipUnavailable(platformFetch<TimeLog[]>(`/api/${t}/pm/tasks/${taskId}/time`, u), [] as TimeLog[]);
export const listTags = (u: string, t: string, projectId: string) =>
  skipUnavailable(platformFetch<Tag[]>(`/api/${t}/pm/projects/${projectId}/tags`, u), [] as Tag[]);
// Per-project workflow statuses (P2-05, design spec §7). Degrades to the synth
// legacy 4 on 404/403 (disabled/stale backend) AND treats a real empty list the
// same way — a project with no registry rows is the default 4, so it renders +
// behaves exactly as before custom statuses shipped.
export const listProjectStatuses = async (u: string, t: string, projectId: string): Promise<ProjectStatus[]> => {
  const rows = await skipUnavailable(
    platformFetch<ProjectStatus[]>(`/api/${t}/pm/projects/${projectId}/statuses`, u),
    [] as ProjectStatus[],
  );
  return rows.length ? [...rows].sort((a, b) => a.position - b.position) : synthDefaultStatuses();
};
// Given a set of tasks (possibly across projects), fetch each distinct project's
// status registry once, keyed by projectId — the shape the dept board's
// union-by-label columns + the flag-driven KPI helpers consume.
export async function statusesForTasks(u: string, t: string, tasks: { projectId: string }[]): Promise<Record<string, ProjectStatus[]>> {
  const projectIds = [...new Set(tasks.map((x) => x.projectId))];
  const lists = await Promise.all(projectIds.map((pid) => listProjectStatuses(u, t, pid)));
  const out: Record<string, ProjectStatus[]> = {};
  projectIds.forEach((pid, i) => { out[pid] = lists[i]; });
  return out;
}

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

// Project board columns, driven by the project's OWN ordered ProjectStatus[]
// (P2-05, design spec §7). Defaults to the synth legacy 4 when no registry is
// passed, so an un-customized project renders identical columns to before. A
// task whose status id isn't in the set (e.g. stale after a registry edit) is
// never dropped — it lands in a trailing column labelled by its id.
export function groupByStatus(tasks: PmTask[], statuses: ProjectStatus[] = DEFAULT_STATUSES): AxisColumn<string>[] {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  const known = new Set(ordered.map((s) => s.id));
  const cols: AxisColumn<string>[] = ordered.map((s) => ({
    key: s.id,
    label: s.label,
    color: s.color,
    wipLimit: s.wipLimit,
    tasks: tasks.filter((t) => t.status === s.id),
  }));
  const orphans = tasks.filter((t) => !known.has(t.status));
  if (orphans.length) {
    const byStatus = new Map<string, PmTask[]>();
    for (const t of orphans) {
      const bucket = byStatus.get(t.status) ?? [];
      bucket.push(t);
      byStatus.set(t.status, bucket);
    }
    for (const [id, ts] of byStatus) cols.push({ key: id, label: STATUS_LABEL[id as TaskStatus] ?? id, tasks: ts });
  }
  return cols;
}

// ---- Board (kanban) column model, generalized across grouping axes (P1-03) ----
// `Board` (components/pm/Board.tsx) renders columns for ANY axis — status,
// assignee, priority, division — through this one shape. `key` is what a drag
// commits (the value passed to the axis's `move` callback); `people` is set
// ONLY on division columns, so Board can tell (a) this axis needs the
// responsible-person ambiguity check on drop, and (b) who the candidates are.
export interface AxisColumn<K extends string = string> {
  key: K;
  label: string;
  tasks: PmTask[];
  people?: { id: string; name: string }[];
  // P2-05: status axis only — the status's colour (hex) for the head dot and its
  // WIP limit for the over-limit display (§2). Other axes leave these unset.
  color?: string;
  wipLimit?: number;
}

export interface Suggestion { progress: number; status: string; rationale: string }
// Deterministic tracker analysis: derive progress from subtasks (if any) and a
// status transition from that progress. Pure so it's testable; the doc/comment/
// notification delivery lives in the tracker runner (pm.controller.ts on the
// backend, lib/demoPm.ts under DEMO_MODE) — both implement the same formula.
//
// P2-05: the transition is FLAG-driven, not id-literal. At 100% → the project's
// `isDone` status; from the first non-terminal ("todo"-like) status with any
// progress → the next non-terminal ("in progress"-like) one. Works with renamed
// custom statuses; falls back to the legacy 4 when no registry is passed.
export function suggestFromTask(task: PmTask, statuses: ProjectStatus[] = DEFAULT_STATUSES): Suggestion {
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  const sub = task.subtasks ?? [];
  const progress = sub.length > 0 ? taskProgressFromSubtasks(sub) : task.progress;
  const doneStatus = ordered.find((s) => s.isDone);
  const flow = ordered.filter((s) => !s.isDone && !s.isBlocked); // the "todo → in progress → …" spine
  let status = task.status;
  // P4-B8: this used to be `task.status === flow[0].id → flow[1].id`, i.e. "if you are at the very
  // START of the spine and have progress, step forward one". Inserting `backlog` ahead of `todo`
  // silently broke it — `todo` stopped being flow[0], so a task with real subtask progress was no
  // longer suggested for Doing. Nothing threw; the suggestion just quietly stopped appearing.
  //
  // Generalised to "advance to the ACTIVE-WORK step from anything before it". The active step is
  // `in_progress` when the registry has it (our own ladder's persisted id, so every project on the
  // defaults qualifies), else the second spine entry — which reproduces the old behaviour exactly
  // for a fully custom registry. Bounded on purpose: a task already AT or past the active step is
  // left alone, because progress alone must never push work forward into a review/approval status.
  const activeIdx = flow.findIndex((s) => s.id === "in_progress");
  const targetIdx = activeIdx > 0 ? activeIdx : Math.min(1, flow.length - 1);
  const currentIdx = flow.findIndex((s) => s.id === task.status);
  if (progress >= 100 && doneStatus && task.status !== doneStatus.id) {
    status = doneStatus.id;
  } else if (progress > 0 && flow.length >= 2 && currentIdx >= 0 && currentIdx < targetIdx) {
    status = flow[targetIdx].id;
  }
  const targetLabel = ordered.find((s) => s.id === status)?.label ?? (STATUS_LABEL[status as TaskStatus] ?? status);
  const done = sub.filter((s) => s.done).length;
  const rationale =
    sub.length > 0
      ? `${done}/${sub.length} subtasks complete → ${progress}% progress${status !== task.status ? `, move to “${targetLabel}”` : ""}.`
      : `No subtasks to measure; holding at ${progress}%. Add a checklist for finer tracking.`;
  return { progress, status, rationale };
}

// ---- dept board: union-by-label columns (P2-05, design spec §7, D-4) ----
// A department board spans several projects, each with its OWN status registry
// (different ids can share a label). Columns are the DISTINCT status labels
// across those projects, ordered by their average position; a task lands in the
// column matching ITS OWN status's label. A drop maps back to the card's own
// project's status id (server action `moveTaskToStatusLabel`) — or, when that
// project has no same-label status, opens the pick popover (Board handles both).
export function distinctStatusLabels(statusesByProject: Record<string, ProjectStatus[]>): string[] {
  const acc = new Map<string, { sum: number; count: number }>();
  for (const list of Object.values(statusesByProject)) {
    for (const s of list) {
      const a = acc.get(s.label) ?? { sum: 0, count: 0 };
      a.sum += s.position;
      a.count += 1;
      acc.set(s.label, a);
    }
  }
  return [...acc.entries()]
    .sort((a, b) => a[1].sum / a[1].count - b[1].sum / b[1].count || a[0].localeCompare(b[0]))
    .map(([label]) => label);
}
export function statusLabelForTask(task: PmTask, statusesByProject: Record<string, ProjectStatus[]>): string {
  const list = statusesByProject[task.projectId] ?? DEFAULT_STATUSES;
  return list.find((s) => s.id === task.status)?.label ?? (STATUS_LABEL[task.status as TaskStatus] ?? task.status);
}
export function unionStatusColumns(tasks: PmTask[], statusesByProject: Record<string, ProjectStatus[]>): AxisColumn<string>[] {
  const labels = distinctStatusLabels(statusesByProject);
  const colorByLabel = new Map<string, string>();
  for (const list of Object.values(statusesByProject)) {
    for (const s of list) if (!colorByLabel.has(s.label)) colorByLabel.set(s.label, s.color);
  }
  return labels.map((label) => ({
    key: label,
    label,
    color: colorByLabel.get(label),
    tasks: tasks.filter((t) => statusLabelForTask(t, statusesByProject) === label),
  }));
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

// Dependencies of `task` that aren't done yet (so `task` is really blocked).
// P2-05: "done" is the isDone FLAG, not a literal id — `statuses` is the task's
// OWN project's registry (deps live in the same project); falls back to legacy
// "done" semantics when omitted. Pure.
export function openDependencies(task: PmTask, byId: Map<string, PmTask>, statuses?: ProjectStatus[]): PmTask[] {
  return (task.dependsOn ?? []).map((id) => byId.get(id)).filter((d): d is PmTask => !!d && !isDoneStatus(d.status, statuses));
}

// ---- chain enforcement — client-side courtesy (P4-I4) ----
// Mirrors the server-side gate (P4-I1, built in parallel by another agent): while a task has open
// (unresolved) dependencies, only three kinds of status are actually safe to land on — the
// project's own INTAKE spot (Backlog, or its per-project equivalent — a task can always sit
// uncommitted), a status already flagged `isBlocked` (the human "waiting on the client" case, §17),
// or a done status (finishing despite a stale blocker is the server's call, not this courtesy
// check's). Every other status counts as "started work" and is disabled until the blocker(s)
// clear — this is what gives the ladder real teeth (plan §I). THE SERVER REMAINS AUTHORITATIVE:
// this is advisory UI only, computed from whatever ProjectStatus[] the caller already has, and it
// must degrade harmlessly (never crash, never silently allow) if the two ever disagree — a stale
// list here just means a write attempt bounces off the real gate with the server's own reason.
export function reachableStatusIds(statuses: ProjectStatus[], blocked: boolean): Set<string> {
  if (!blocked) return new Set(statuses.map((s) => s.id));
  const intake = intakeStatusId(statuses);
  return new Set(statuses.filter((s) => s.isDone || s.isBlocked || s.id === intake).map((s) => s.id));
}

// P4-H3 — the task-derived date envelope (earliest start, latest due) of a set of tasks.
// Lives here because THREE surfaces needed it independently — the project workspace, the department
// projects list and the tenant projects list — and each had grown its own copy. Three copies of a
// min/max fold is how two of them quietly disagree the first time someone handles a null differently.
//
// This is the DERIVED half of decision 12. It is deliberately NOT the project's range: it is what
// the work actually spans, shown next to what the team committed to, and the difference is the point.
export function taskDateEnvelope(
  tasks: { startDate: string | null; dueDate: string | null }[],
): { start: string | null; end: string | null } {
  let start: string | null = null;
  let end: string | null = null;
  for (const t of tasks) {
    if (t.startDate && (!start || t.startDate < start)) start = t.startDate;
    if (t.dueDate && (!end || t.dueDate > end)) end = t.dueDate;
  }
  return { start, end };
}

// ---- task templates (P3-03) ----
// Tenant-wide (not per-project — a template's `tagLabels` are plain strings,
// resolved against whichever project a task is actually created in, since a
// project's tag registry is per-project but a template is shared across all
// of them). `kind` is a string (not a closed union) so the same endpoint can
// grow other template kinds later without a breaking type change here.
export interface Template {
  id: string;
  kind: string; // "task" (P3-03) or "doc" (P3-11)
  title: string;
  description?: string;
  priority?: Priority;
  estimateMinutes?: number | null;
  subtasks?: string[];
  tagLabels?: string[];
  body?: string; // doc-template content (kind:"doc" only, P3-11)
}
export const listTemplates = (u: string, t: string, kind: string = "task") =>
  skipUnavailable(platformFetch<Template[]>(`/api/${t}/pm/templates?kind=${kind}`, u), [] as Template[]);

// ---- tags (P2-02, design spec §6) ----
// Resolve a task's tag ids to Tag objects via its OWN project's registry; ids
// not present in the registry (stale, or — should it ever happen — foreign)
// are silently dropped rather than surfaced as broken chips.
export function resolveTags(ids: string[], registry: Tag[]): Tag[] {
  const byId = new Map(registry.map((tg) => [tg.id, tg]));
  return ids.map((id) => byId.get(id)).filter((tg): tg is Tag => !!tg);
}

// Cross-project tag filter (dept board, design spec §6 decision D-1): tag ids
// are per-project, so a task list aggregated across projects (e.g. a
// department's board) can only match tags by LABEL, not id.
// `registriesByProject` maps projectId -> that project's own tag registry.
export function distinctTagLabels(registriesByProject: Record<string, Tag[]>): string[] {
  const set = new Set<string>();
  for (const reg of Object.values(registriesByProject)) for (const tg of reg) set.add(tg.label);
  return [...set].sort((a, b) => a.localeCompare(b));
}
export function filterTasksByTagLabels(tasks: PmTask[], registriesByProject: Record<string, Tag[]>, labels: string[]): PmTask[] {
  if (labels.length === 0) return tasks;
  const wanted = new Set(labels);
  return tasks.filter((t) => {
    const reg = registriesByProject[t.projectId] ?? [];
    return resolveTags(t.tags, reg).some((tg) => wanted.has(tg.label));
  });
}

// A `.lux-filters` GET-form's repeated `?tags=` values arrive from Next.js as
// `string | string[] | undefined` depending on how many were submitted (one
// vs. several vs. none) — normalize to a plain array. Pure, shared by every
// tag filter (project list + dept board).
export function parseTagFilterParam(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
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
const isoShift = (date: string, days: number): string => iso(Date.parse(date) + days * DAY);
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

// ---- Gantt aggregation (P1-04 — dept-level Gantt) ----
// All pure + server-safe. The client Gantt (a client component that CANNOT import
// this server-only module at runtime) receives the results of these helpers as
// serializable props precomputed here by the department Timeline page. The client
// only mirrors the tiny drag-pixel math + the cycle guard inline (see Gantt.tsx),
// with these functions as the tested source of truth.

export type GanttGroupBy = "flat" | "project" | "milestone" | "assignee";
export interface GanttGroup { key: string; label: string; bars: TimelineBar[] }

// Bucket bars into ordered groups for the grouped Gantt. "flat" is one unlabelled
// group (the legacy single-project view). Sentinel buckets ("no milestone"/
// "unassigned") always sort last; the rest sort by label.
export function groupTimelineBars(
  bars: TimelineBar[],
  groupBy: GanttGroupBy,
  milestones: { id: string; name: string }[] = [],
): GanttGroup[] {
  if (groupBy === "flat") return [{ key: "__all", label: "", bars }];
  const msName = new Map(milestones.map((m) => [m.id, m.name]));
  const sentinel = groupBy === "assignee" ? "__unassigned" : "__none";
  const groups = new Map<string, GanttGroup>();
  for (const b of bars) {
    let key: string;
    let label: string;
    if (groupBy === "project") {
      key = b.task.projectId;
      label = b.task.projectName || b.task.projectId;
    } else if (groupBy === "assignee") {
      key = b.task.assignee?.responsibleId ?? sentinel;
      label = b.task.assignee?.responsibleName || "Unassigned";
    } else {
      key = b.task.milestoneId ?? sentinel;
      label = b.task.milestoneId ? (msName.get(b.task.milestoneId) ?? "Milestone") : "No milestone";
    }
    if (!groups.has(key)) groups.set(key, { key, label, bars: [] });
    groups.get(key)!.bars.push(b);
  }
  return [...groups.values()].sort((a, b) => {
    const as = a.key === sentinel;
    const bs = b.key === sentinel;
    if (as !== bs) return as ? 1 : -1;
    return a.label.localeCompare(b.label);
  });
}

// A date's horizontal position (0-100%) on a timeline's padded axis. Matches
// computeTimeline's own bar offsets for date-midnight inputs, so milestone
// diamonds line up with the bars.
export function offsetPctForDate(timeline: Timeline, date: string): number {
  const start = Date.parse(timeline.start);
  const end = Date.parse(timeline.end);
  const span = Math.max(1, end - start);
  const t = Date.parse(date);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.min(100, ((t - start) / span) * 100));
}

export interface MilestoneMarker { id: string; name: string; date: string; offsetPct: number }
// Dated milestones positioned on the shared axis (undated ones are dropped —
// they can't be placed). Used for diamonds + dashed guidelines.
export function milestoneMarkers(timeline: Timeline, milestones: Milestone[]): MilestoneMarker[] {
  return milestones
    .filter((m): m is Milestone & { dueDate: string } => !!m.dueDate)
    .map((m) => ({ id: m.id, name: m.name, date: m.dueDate, offsetPct: offsetPctForDate(timeline, m.dueDate) }));
}

// A blocker→blocked schedule is inconsistent when the blocker's due date lands
// after the blocked task's start (it can't finish in time to unblock). Pure;
// lexical ISO (yyyy-mm-dd) comparison is date-correct.
export function dependencyConflict(blocker: PmTask, blocked: PmTask): boolean {
  if (!blocker.dueDate) return false;
  const blockedStart = blocked.startDate ?? blocked.dueDate;
  if (!blockedStart) return false;
  return blocker.dueDate > blockedStart;
}

export interface GanttDepEdge { fromId: string; toId: string; conflict: boolean }
// Dependency edges among the visible bars: one edge per `dependsOn` link, drawn
// from the blocker (from) to the blocked task (to), flagged when the schedule is
// inconsistent. Edges whose endpoints aren't both present are omitted.
export function dependencyEdges(bars: TimelineBar[]): GanttDepEdge[] {
  const byId = new Map(bars.map((b) => [b.task.id, b.task]));
  const edges: GanttDepEdge[] = [];
  for (const b of bars) {
    for (const blockerId of b.task.dependsOn ?? []) {
      const blocker = byId.get(blockerId);
      if (!blocker) continue;
      edges.push({ fromId: blockerId, toId: b.task.id, conflict: dependencyConflict(blocker, b.task) });
    }
  }
  return edges;
}

// ---- move-together (P2-08, design spec §4 phase-2) ----
// The transitive set of tasks that (directly or indirectly) depend on `taskId` — every task
// reachable by following `dependsOn` edges BACKWARD (blocked -> blocker). Dragging `taskId`'s
// Gantt bar shifts this whole set along with it. Pure; a `dependsOn` cycle can't cause infinite
// recursion (the visited-set guard mirrors `wouldCreateCycle`'s). The client Gantt (which cannot
// import this server-only module at runtime) mirrors this same walk inline, same pattern as its
// `hasCycle` mirror of `wouldCreateCycle`.
export function transitiveDependents(tasks: PmTask[], taskId: string): string[] {
  const dependents = new Map<string, string[]>(); // blockerId -> ids of tasks it blocks
  for (const t of tasks) {
    for (const dep of t.dependsOn ?? []) {
      const arr = dependents.get(dep);
      if (arr) arr.push(t.id); else dependents.set(dep, [t.id]);
    }
  }
  const out = new Set<string>();
  const stack = [...(dependents.get(taskId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id) || id === taskId) continue;
    out.add(id);
    for (const next of dependents.get(id) ?? []) stack.push(next);
  }
  return [...out];
}

// ---- burndown (P2-08, design spec §4; backend P2-07, migration 0040) ----
export interface BurndownPoint { date: string; open: number; done: number; avgProgress: number }
// Degrades to [] on 404/403 (module disabled / stale backend) same as every other PM reader —
// the Gantt overlay hides cleanly on an empty series, never an error.
export const getBurndown = (u: string, t: string, projectId: string, from?: string, to?: string) => {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs}` : "";
  return skipUnavailable(platformFetch<BurndownPoint[]>(`/api/${t}/pm/projects/${projectId}/burndown${suffix}`, u), [] as BurndownPoint[]);
};

// ---- tenant-grain burndown (P4-A2, landed 2026-08-07) ----
// `GET /api/:t/pm/burndown` — the SAME `BurndownPoint[]` shape as the per-project reader above,
// already summed server-side across every project the tenant has (the backend's own comment: an
// `open`/`done`-weighted mean, not a mean-of-means). Same degrade-gracefully contract: a stale
// backend without this route, or DEMO_MODE (no fixture for it yet — see the P4-A3/A5 report), 404s
// or falls through to an empty array either way, so the `@all` Charts view renders its existing
// empty-state handling rather than crashing on a route that isn't there.
export const getTenantBurndown = (u: string, t: string, from?: string, to?: string) => {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs}` : "";
  return skipUnavailable(platformFetch<BurndownPoint[]>(`/api/${t}/pm/burndown${suffix}`, u), [] as BurndownPoint[]);
};

// The department Timeline spans several projects, each with its own burndown series — sum them
// by calendar date (a date missing from some projects' series still sums whatever rows DO exist
// that day; avgProgress is weighted by that day's total open+done across the summed projects).
// Pure; empty input -> [].
export function aggregateBurndown(seriesList: BurndownPoint[][]): BurndownPoint[] {
  const byDate = new Map<string, { open: number; done: number; weightedProgress: number }>();
  for (const series of seriesList) {
    for (const p of series) {
      const acc = byDate.get(p.date) ?? { open: 0, done: 0, weightedProgress: 0 };
      acc.open += p.open;
      acc.done += p.done;
      acc.weightedProgress += p.avgProgress * (p.open + p.done);
      byDate.set(p.date, acc);
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, acc]) => ({
      date, open: acc.open, done: acc.done,
      avgProgress: acc.open + acc.done > 0 ? Math.round(acc.weightedProgress / (acc.open + acc.done)) : 0,
    }));
}

// A burndown series positioned on a Gantt's shared date axis. `idealPct`/`actualPct` are 0-100
// ("remaining work", 100 = everything still open at series-start, 0 = none) so the overlay plots
// cleanly regardless of the underlying open/done scale. Ideal is the classic straight-line
// burndown (series-start total -> 0 at series-end); actual is each day's real open count against
// that SAME starting total, so both lines share one denominator. Empty series -> [] — the caller
// (Gantt) hides the overlay entirely rather than rendering an empty/degenerate chart.
export interface BurndownOverlayPoint { date: string; x: number; idealPct: number; actualPct: number }
export function burndownOverlay(timeline: Timeline, series: BurndownPoint[]): BurndownOverlayPoint[] {
  if (series.length === 0) return [];
  const total = series[0].open + series[0].done;
  const n = series.length;
  return series.map((p, i) => ({
    date: p.date,
    x: offsetPctForDate(timeline, p.date),
    idealPct: n > 1 ? Math.max(0, 100 - (100 * i) / (n - 1)) : (total > 0 ? (100 * p.open) / total : 0),
    actualPct: total > 0 ? Math.max(0, Math.min(100, (100 * p.open) / total)) : 0,
  }));
}

// A minimal Timeline spanning exactly [start, end] with no bars — lets a series that owns ITS
// OWN date range (a project-level burndown/flow chart, not task-scheduled) reuse
// burndownOverlay's exact positioning math instead of reimplementing it, so a standalone Charts
// card and the Gantt's inline overlay plot byte-identical idealPct/actualPct/x for the same
// series (P3-06).
export function timelineFromDates(start: string, end: string): Timeline {
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / DAY));
  return { start, end, days, bars: [] };
}

// ---- cumulative flow diagram (P3-06; sibling BE ticket P3-05 adds the real /flow endpoint) ----
// Per-day snapshot: a status id -> the count of tasks sitting in that status ON that day.
export interface FlowPoint { date: string; counts: Record<string, number> }
// Degrades to [] on 404/403 (no /flow endpoint yet, or module disabled) — same contract as
// getBurndown/every other PM reader. Once P3-05 lands this just starts returning real rows.
export const getFlow = (u: string, t: string, projectId: string, from?: string, to?: string) => {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs}` : "";
  return skipUnavailable(platformFetch<FlowPoint[]>(`/api/${t}/pm/projects/${projectId}/flow${suffix}`, u), [] as FlowPoint[]);
};

// ---- tenant-grain flow (P4-A2, landed 2026-08-07) ----
// `GET /api/:t/pm/flow` — merged server-side by LITERAL status id across every project (the
// backend's own comment: "a best-effort tenant-wide silhouette, not a semantically-unified
// breakdown"). That merge is actually safe for our data: the shared ladder ids (`backlog`/`todo`/
// `in_progress`/`blocked`/`done`) are meant to merge, and a per-project CUSTOM status gets a
// randomly-generated id (`pm_project_statuses.id`), so two different projects' custom statuses
// never collide under this merge — it isn't a coincidence that this is safe, the id space is
// disjoint by construction. Same degrade contract as `getTenantBurndown` above.
export const getTenantFlow = (u: string, t: string, from?: string, to?: string) => {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs}` : "";
  return skipUnavailable(platformFetch<FlowPoint[]>(`/api/${t}/pm/flow${suffix}`, u), [] as FlowPoint[]);
};

// The department Charts page (P3-07) spans several projects, each with its own /flow series AND
// its own status registry (same union-by-label rule as unionStatusColumns/distinctStatusLabels —
// different projects can use different ids for a same-named column). Sums each day's per-status
// counts across projects BY LABEL (a project without a same-label status that day contributes 0
// for it, same "sum whatever exists" rule as aggregateBurndown) and returns a synthetic
// ProjectStatus[] (id === label) ordered/coloured by that same rule, so the result feeds straight
// into flowSeries(points, statuses) exactly like a single project's own flow does. Pure; empty
// input -> { points: [], statuses: [] }.
export function aggregateFlow(
  perProject: { points: FlowPoint[]; statuses: ProjectStatus[] }[],
): { points: FlowPoint[]; statuses: ProjectStatus[] } {
  const statusesByProject: Record<string, ProjectStatus[]> = {};
  perProject.forEach((p, i) => { statusesByProject[String(i)] = p.statuses; });
  const labels = distinctStatusLabels(statusesByProject);
  const colorByLabel = new Map<string, string>();
  for (const { statuses } of perProject) {
    for (const s of statuses) if (!colorByLabel.has(s.label)) colorByLabel.set(s.label, s.color);
  }
  const statuses: ProjectStatus[] = labels.map((label, i) => ({
    id: label, label, color: colorByLabel.get(label) ?? "#999999", isDone: false, isBlocked: false, position: i,
  }));

  const byDate = new Map<string, Record<string, number>>();
  for (const { points, statuses: own } of perProject) {
    const idToLabel = new Map(own.map((s) => [s.id, s.label]));
    for (const p of points) {
      const acc = byDate.get(p.date) ?? {};
      for (const [statusId, count] of Object.entries(p.counts)) {
        const label = idToLabel.get(statusId) ?? statusId;
        acc[label] = (acc[label] ?? 0) + count;
      }
      byDate.set(p.date, acc);
    }
  }
  const points: FlowPoint[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, counts }));
  return { points, statuses };
}

export interface FlowBand { statusId: string; label: string; color: string }
export interface FlowSeries { dates: string[]; bands: FlowBand[]; counts: number[][]; stacked: number[][] }
const EMPTY_FLOW_SERIES: FlowSeries = { dates: [], bands: [], counts: [], stacked: [] };

// Fills date gaps by carrying the last known snapshot forward (a CFD reads a missing day's
// state from the last day it actually has data for — never a fake dip to zero), and orders
// bands by the project's own status POSITION (never raw insertion order in the points, never
// alphabetical) so the legend always matches the board's column order (P3-06 acceptance).
// `counts[i][d]` is band i's own raw count on date d; `stacked[i][d]` is the CUMULATIVE height
// through band i on date d (bands[0..i] summed) — an SVG stacked-area's top edge plots this
// directly. Empty input -> an empty series (caller shows EmptyNote, never a degenerate area).
export function flowSeries(points: FlowPoint[], statuses: ProjectStatus[]): FlowSeries {
  if (points.length === 0) return EMPTY_FLOW_SERIES;
  const ordered = [...statuses].sort((a, b) => a.position - b.position);
  const bands: FlowBand[] = ordered.map((s) => ({ statusId: s.id, label: s.label, color: s.color }));
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = new Map(sorted.map((p) => [p.date, p.counts]));
  const dates: string[] = [];
  const counts: number[][] = bands.map(() => []);
  let carry = sorted[0].counts;
  let cur = sorted[0].date;
  const last = sorted[sorted.length - 1].date;
  while (cur <= last) {
    const today = byDate.get(cur);
    if (today) carry = today;
    dates.push(cur);
    bands.forEach((b, i) => counts[i].push(carry[b.statusId] ?? 0));
    cur = isoShift(cur, 1);
  }
  const stacked: number[][] = bands.map((_, i) => dates.map((_, di) => counts.slice(0, i + 1).reduce((sum, arr) => sum + arr[di], 0)));
  return { dates, bands, counts, stacked };
}

// ---- tag breakdown (P3-06) ----
export interface TagBreakdownRow { tagId: string | null; label: string; color: TagColor | null; count: number; pct: number }
// Ranked (desc by count, ties by label) breakdown of a project's tasks by tag, plus a trailing
// neutral "Untagged" row (tasks with no tag in this project's OWN registry — a stale/foreign id
// counts as untagged, same drop rule as resolveTags). A task carrying several tags counts once
// toward EACH of its tags (this is a tag cloud, not a partition), so percentages can sum past
// 100 — every pct is simply count/total-tasks. Computed live from tasks + the tag registry, no
// endpoint. Empty project -> [] (caller shows EmptyNote).
export function tagBreakdown(tasks: PmTask[], registry: Tag[]): TagBreakdownRow[] {
  const total = tasks.length;
  if (total === 0) return [];
  const byId = new Map(registry.map((tg) => [tg.id, tg]));
  const counts = new Map<string, number>();
  let untagged = 0;
  for (const t of tasks) {
    const valid = t.tags.filter((id) => byId.has(id));
    if (valid.length === 0) untagged += 1;
    for (const id of valid) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const rows: TagBreakdownRow[] = [...counts.entries()]
    .map(([id, count]) => {
      const tg = byId.get(id)!;
      return { tagId: id, label: tg.label, color: tg.color, count, pct: Math.round((count / total) * 100) };
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  rows.push({ tagId: null, label: "Untagged", color: null, count: untagged, pct: Math.round((untagged / total) * 100) });
  return rows;
}
