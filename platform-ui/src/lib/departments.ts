import "server-only";
import { cache } from "react";
// Department workspaces — a "place to work" per department, composed from data
// that already exists: the org structure (lib/org) gives each department its
// divisions + placed people; PM tasks (lib/pm) are routed to a department via
// their poly-assignee (kind=department|division refId, or a responsible person
// who sits in the department). No new backend/table needed; when work is tagged
// to a unit or a unit's person, it shows up on that department's board.
import { getOrgStructure, type OrgNode } from "./org";
import {
  listAllPmTasks, listPmTasks, listMilestones, statusesForTasks, statusFlags, isDoneStatus,
  projectProgress, PRIORITIES, PRIORITY_LABEL, unionStatusColumns,
  type PmTask, type Priority, type AxisColumn, type Milestone, type ProjectStatus,
} from "./pm";
import { listProjects, type Project } from "./entities";
import { listAssignmentsForUnit, assignmentInclusion, SERVICE_ASSIGNMENTS_ENABLED, type AssignmentSummary } from "./serviceAssignments";
import type { Envelope } from "./envelope";
import type { RailPriority } from "@/components/departments/MyWorkRail";
import { PM_TERMS } from "./pmVocabulary";

export interface DeptPerson { id: string; name: string }
export interface DeptDivision { id: string; name: string; people: DeptPerson[] }
export interface DeptSummary { id: string; name: string; divisions: number; people: number; openTasks: number }
export interface DepartmentWorkspace {
  id: string;
  name: string;
  divisions: DeptDivision[];
  people: DeptPerson[];
  tasks: PmTask[];
  // P2-05: each project (that this dept's tasks touch) → its own status registry.
  // Drives the board's union-by-label columns (D-4) and the flag-driven KPI/rail
  // helpers. A project with no rows resolves to the synth legacy 4 (lib/pm).
  statusesByProject: Record<string, ProjectStatus[]>;
}

const company = (t: string) => ({ id: t, name: t, type: null });

// Everything (division ids, person ids/list) inside a department subtree.
function scan(dept: OrgNode) {
  const divisionIds = new Set<string>();
  const personIds = new Set<string>();
  const people: DeptPerson[] = [];
  const divisions: DeptDivision[] = [];
  const collectPeople = (n: OrgNode, into: DeptPerson[]) => {
    for (const c of n.children) {
      if (c.kind === "person" && c.assigneeId) { const p = { id: c.assigneeId, name: c.assigneeName ?? c.name }; into.push(p); if (!people.some((x) => x.id === p.id)) people.push(p); personIds.add(c.assigneeId); }
      collectPeople(c, into);
    }
  };
  for (const child of dept.children) {
    if (child.kind === "division") {
      divisionIds.add(child.id);
      const dp: DeptPerson[] = [];
      collectPeople(child, dp);
      divisions.push({ id: child.id, name: child.name, people: dp });
    }
  }
  // People placed directly under the department (e.g. Social Media / GM with no divisions).
  collectPeople({ ...dept, children: dept.children.filter((c) => c.kind !== "division") }, []);
  return { divisionIds, personIds, people, divisions };
}

function belongs(task: PmTask, deptId: string, divisionIds: Set<string>, personIds: Set<string>): boolean {
  const a = task.assignee;
  if (!a) return false;
  if (a.kind === "department" && a.refId === deptId) return true;
  if (a.kind === "division" && divisionIds.has(a.refId)) return true;
  if (a.responsibleId && personIds.has(a.responsibleId)) return true;
  if (a.kind === "person" && personIds.has(a.refId)) return true;
  return false;
}

const departmentNodes = cache(async function departmentNodes(u: string, t: string): Promise<OrgNode[]> {
  try {
    const { structure } = await getOrgStructure(u, t, company(t));
    return structure.root.children.filter((c) => c.kind === "department");
  } catch { return []; }
});

// Lightweight {id,name} list for the sidebar nav (department children). Reads only
// the org structure — no task scan — and shares departmentNodes' cache with
// myPlacement so the sidebar adds no extra fetch per page.
export interface DeptBrief { id: string; name: string }
export async function listDepartmentBriefs(u: string, t: string): Promise<DeptBrief[]> {
  return (await departmentNodes(u, t)).map((d) => ({ id: d.id, name: d.name }));
}

export async function listDepartments(u: string, t: string): Promise<DeptSummary[]> {
  const [depts, tasks] = await Promise.all([departmentNodes(u, t), listAllPmTasks(u, t)]);
  return depts.map((d) => {
    const { divisionIds, personIds, people, divisions } = scan(d);
    // Sidebar summary count — cheap legacy-fallback flag resolution (no per-
    // project status fetch here; the exact board/KPI numbers use the registry).
    const open = tasks.filter((x) => !isDoneStatus(x.status) && belongs(x, d.id, divisionIds, personIds)).length;
    return { id: d.id, name: d.name, divisions: divisions.length, people: people.length, openTasks: open };
  });
}

export interface MyPlacement { deptId: string; deptName: string; divisionName: string | null }
// Where the signed-in employee sits in the active company's org (their department +
// division), for the sidebar "My team" shortcut. Null when they aren't placed.
export async function myPlacement(u: string, t: string, userId: string): Promise<MyPlacement | null> {
  const depts = await departmentNodes(u, t);
  for (const d of depts) {
    // direct under department (no-division depts)
    if (d.children.some((c) => c.kind === "person" && c.assigneeId === userId)) return { deptId: d.id, deptName: d.name, divisionName: null };
    for (const v of d.children.filter((c) => c.kind === "division")) {
      let hit = false;
      const walk = (n: OrgNode) => { for (const c of n.children) { if (c.kind === "person" && c.assigneeId === userId) hit = true; walk(c); } };
      walk(v);
      if (hit) return { deptId: d.id, deptName: d.name, divisionName: v.name };
    }
  }
  return null;
}

// Memoised for the duration of one request render so the department console
// LAYOUT (header/tabs) and its child PAGE (Overview/Workflow/…) share a single
// fetch of the org structure + task list rather than each re-fetching.
export const getDepartment = cache(async function getDepartment(
  u: string,
  t: string,
  deptId: string,
): Promise<DepartmentWorkspace | null> {
  const [depts, tasks] = await Promise.all([departmentNodes(u, t), listAllPmTasks(u, t)]);
  const d = depts.find((x) => x.id === deptId);
  if (!d) return null;
  const { divisionIds, personIds, people, divisions } = scan(d);
  const deptTasks = tasks.filter((x) => belongs(x, d.id, divisionIds, personIds));
  const statusesByProject = await statusesForTasks(u, t, deptTasks);
  return { id: d.id, name: d.name, divisions, people, tasks: deptTasks, statusesByProject };
});

// ---------------- Owned-projects PM aggregation (P1-04 — dept Timeline) ----------------
// The department's OWNED projects (department_id === deptId, decision #12 — the
// same ownership rule the Home page's health rings use) each paired with their
// own PM tasks + milestones. This is exactly the Home page's owned-project fetch
// pattern (listProjects → filter → parallel listPmTasks/listMilestones), lifted
// here so the Timeline page can aggregate the union onto one Gantt axis. Every
// reader degrades to []/[] on its own (lib/pm.ts), so a disabled/stale PM
// endpoint yields an empty aggregate, not a throw.
export interface OwnedProjectPm { project: Project; tasks: PmTask[]; milestones: Milestone[] }

export async function getOwnedProjectsPm(u: string, t: string, deptId: string): Promise<OwnedProjectPm[]> {
  const all = await listProjects(u, t).catch(() => [] as Project[]);
  const owned = all.filter((p) => p.department_id === deptId);
  const [taskLists, milestoneLists] = await Promise.all([
    Promise.all(owned.map((p) => listPmTasks(u, t, p.id))),
    Promise.all(owned.map((p) => listMilestones(u, t, p.id))),
  ]);
  return owned.map((p, i) => ({ project: p, tasks: taskLists[i], milestones: milestoneLists[i] }));
}

// ---------------- Serviced companies (ORG-13 / UX-2 §3, ServicedBlock) ----------------
// "Companies this department currently serves" — the provider-side read for a
// department/division node. Renders nothing (no fake data, no empty-state
// clutter) whenever the flag is off or the unit has no assignments at all;
// the ServicedBlock component itself decides whether to render based on
// `items.length + companies.length === 0`, matching UX-2 §3.3's "Not-serviced
// (default today): Serviced block does not render at all."
export interface ServicedCompanyRow {
  assignmentId: string;
  companyId: string;
  companyName: string;
  module: string;
  status: AssignmentSummary["status"];
  unitStatus: AssignmentSummary["unitStatus"];
  leadUserId?: string | null;
}

export async function getServicedCompanies(u: string, t: string, deptId: string): Promise<Envelope<ServicedCompanyRow>> {
  if (!SERVICE_ASSIGNMENTS_ENABLED) return { items: [], companies: [] };
  const rows = await listAssignmentsForUnit(u, t, deptId, "provided");
  const items: ServicedCompanyRow[] = rows.map((a) => ({
    assignmentId: a.id,
    companyId: a.targetTenantId,
    companyName: a.targetCompanyName ?? a.targetTenantId,
    module: a.module,
    status: a.status,
    unitStatus: a.unitStatus,
    leadUserId: a.leadUserId,
  }));
  const companies = rows.map((a) => {
    const { included, reason } = assignmentInclusion(a);
    return { id: a.targetTenantId, name: a.targetCompanyName ?? a.targetTenantId, included, reason };
  });
  return { items, companies };
}

// ---------------- Home command-center math (P1-07, decision #12 — locked) ----------------
// Pure so it's unit-testable independent of any fetch; the department Home
// page (P1-07) supplies the tasks/milestones it already fetched via
// lib/pm.ts + lib/entities.ts. Every date comparison is relative to `now`
// (defaults to `new Date()`) so tests can pin a fixed instant.

const DAY_MS = 24 * 3600 * 1000;

function daysUntil(dueDate: string, now: Date): number {
  const due = new Date(dueDate);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor((due.getTime() - startOfToday.getTime()) / DAY_MS);
}

/** Strictly in the past relative to `now` (start of day). */
export function isOverdue(dueDate: string | null, now = new Date()): boolean {
  if (!dueDate) return false;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return false;
  return daysUntil(dueDate, now) < 0;
}

/** Due within 7 days, INCLUDING already-overdue dates (KpiStrip's own doc:
 * "Tasks due within 7 days that are not done" — no lower bound). */
export function isDueSoon(dueDate: string | null, now = new Date()): boolean {
  if (!dueDate) return false;
  const d = new Date(dueDate);
  if (Number.isNaN(d.getTime())) return false;
  return daysUntil(dueDate, now) <= 7;
}

export interface DeptKpis {
  active: number;
  dueSoon: number;
  blocked: number;
  progressPct: number;
}

// KpiStrip's four numbers (decision #12): Active/Due soon/Blocked come from
// this department's OWN tasks (poly-assignee, `dept.tasks` from
// `getDepartment`); Progress is the average of each OWNED PROJECT's own
// progress (passed in, since that's computed per-project via lib/pm — see
// `computeProjectHealth`), not task progress.
// P2-05: active/blocked/dueSoon derive from the isDone/isBlocked FLAGS resolved
// against each task's OWN project's registry (`statusesByProject`), not literal
// ids — so a project that renamed "Done"→"Shipped" (still isDone) still counts
// correctly. Omitting the registry falls back to legacy-id semantics (default
// projects stay correct). Active = not done AND not blocked.
export function computeDeptKpis(
  tasks: PmTask[],
  projectProgressPcts: number[],
  now = new Date(),
  statusesByProject: Record<string, ProjectStatus[]> = {},
): DeptKpis {
  const flags = (t: PmTask) => statusFlags(t.status, statusesByProject[t.projectId]);
  const active = tasks.filter((t) => { const f = flags(t); return !f.isDone && !f.isBlocked; }).length;
  const dueSoon = tasks.filter((t) => !flags(t).isDone && isDueSoon(t.dueDate, now)).length;
  const blocked = tasks.filter((t) => flags(t).isBlocked).length;
  const progressPct = projectProgressPcts.length === 0
    ? 0
    : Math.round(projectProgressPcts.reduce((a, b) => a + b, 0) / projectProgressPcts.length);
  return { active, dueSoon, blocked, progressPct };
}

export interface ProjectHealth {
  progressPct: number;
  openCount: number;
  nextMilestone: { label: string; dueDate: string } | null;
  atRisk: boolean;
  atRiskReason?: string;
}

// One owned project's `HealthRingCard` data. atRisk = overdue>0 || blocked>0
// (decision #12, verbatim) — the sole risk signal this shell surfaces.
// P2-05: `statuses` is this ONE project's registry (flag-driven open/overdue/
// blocked counts); omit it for legacy-id semantics. `now` stays the 3rd param
// (unchanged call sites); `statuses` is the optional 4th.
export function computeProjectHealth(
  tasks: PmTask[],
  milestones: { name: string; dueDate: string | null; status: string }[],
  now = new Date(),
  statuses?: ProjectStatus[],
): ProjectHealth {
  const flags = (t: PmTask) => statusFlags(t.status, statuses);
  const progressPct = projectProgress(tasks);
  const openCount = tasks.filter((t) => !flags(t).isDone).length;
  const overdueCount = tasks.filter((t) => !flags(t).isDone && isOverdue(t.dueDate, now)).length;
  const blockedCount = tasks.filter((t) => flags(t).isBlocked).length;
  const atRisk = overdueCount > 0 || blockedCount > 0;
  const reasonParts = [
    overdueCount > 0 ? `${overdueCount} overdue` : null,
    blockedCount > 0 ? `${blockedCount} blocked` : null,
  ].filter((x): x is string => x !== null);
  const upcoming = milestones
    .filter((m) => m.dueDate && m.status !== "done")
    .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string))[0];
  return {
    progressPct,
    openCount,
    nextMilestone: upcoming ? { label: upcoming.name, dueDate: upcoming.dueDate as string } : null,
    atRisk,
    atRiskReason: atRisk ? reasonParts.join(" · ") : undefined,
  };
}

// ---------------- My-work rail data (P1-07, decision #12) ----------------
// The rail component (`MyWorkRail`) is a pure view that does NOT sort —
// sorting is data-wiring logic, i.e. this file's job.

const PRIORITY_RANK: Record<Priority, number> = { urgent: 3, high: 2, normal: 1, low: 0 };

/** PmTask's 4-value priority -> the rail's own 4-value enum (normal->medium, urgent->critical). */
export function toRailPriority(p: Priority): RailPriority {
  if (p === "urgent") return "critical";
  if (p === "normal") return "medium";
  return p;
}

// This person's not-done department tasks, sorted by (due date ascending —
// undated last, then priority descending). "My work today" (decision #12).
export function myDeptTasksToday(tasks: PmTask[], userId: string, statusesByProject: Record<string, ProjectStatus[]> = {}): PmTask[] {
  return tasks
    .filter((t) => !statusFlags(t.status, statusesByProject[t.projectId]).isDone && t.assignee?.responsibleId === userId)
    .slice()
    .sort((a, b) => {
      const ad = a.dueDate ?? "9999-12-31";
      const bd = b.dueDate ?? "9999-12-31";
      if (ad !== bd) return ad.localeCompare(bd);
      return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
    });
}

// This person's blocked department tasks — one half of "Waiting on me"
// (decision #12; the other half is pending approvals, wired at the call site).
export function myBlockedTasks(tasks: PmTask[], userId: string, statusesByProject: Record<string, ProjectStatus[]> = {}): PmTask[] {
  return tasks.filter((t) => statusFlags(t.status, statusesByProject[t.projectId]).isBlocked && t.assignee?.responsibleId === userId);
}

// ---------------- Board focus model (WSUX-7, R-2 — ORG-CORE STEP-5 semantics) ----------------
// The daily-work spec's §3 "Focus: Whole dept / Division:<name> / Just me" grafted into the
// console's Board tab. Pure filters over `dept.tasks` (already scanned by `belongs()` in
// `getDepartment`) — no new backend call, no re-traversal of the org tree; division membership
// reuses the SAME `divisions[].people` shape `scan()` already produced.
export type BoardFocusMode = "dept" | "division" | "me";
export interface BoardFocus { mode: BoardFocusMode; divisionId?: string }

// Encode/decode the `?focus=` query value: "dept" | "me" | "division:<id>".
export function parseBoardFocus(raw: string | undefined): BoardFocus {
  if (!raw || raw === "dept") return { mode: "dept" };
  if (raw === "me") return { mode: "me" };
  if (raw.startsWith("division:")) return { mode: "division", divisionId: raw.slice("division:".length) };
  return { mode: "dept" };
}
export function encodeBoardFocus(focus: BoardFocus): string {
  if (focus.mode === "division" && focus.divisionId) return `division:${focus.divisionId}`;
  return focus.mode;
}

function divisionTaskIds(task: PmTask, division: DeptDivision): boolean {
  const a = task.assignee;
  if (!a) return false;
  if (a.kind === "division" && a.refId === division.id) return true;
  const personIds = new Set(division.people.map((p) => p.id));
  if (a.responsibleId && personIds.has(a.responsibleId)) return true;
  if (a.kind === "person" && personIds.has(a.refId)) return true;
  return false;
}

// `Focus: Just me` needs no permission beyond viewing the department (spec §3.4) — it's a
// client-... er, server-side filter over data already fetched for this viewer. `Focus: Division`
// is validated against `dept.divisions` by the caller (an unknown/foreign division id yields no
// tasks here rather than silently falling back to "whole dept").
export function filterTasksByFocus(tasks: PmTask[], divisions: DeptDivision[], focus: BoardFocus, userId: string): PmTask[] {
  if (focus.mode === "me") return tasks.filter((t) => t.assignee?.responsibleId === userId);
  if (focus.mode === "division") {
    const division = divisions.find((d) => d.id === focus.divisionId);
    if (!division) return [];
    return tasks.filter((t) => divisionTaskIds(t, division));
  }
  return tasks;
}

// ---------------- Board axis columns (P1-03 — unify all grouping axes through Board) ----------------
// Status keeps `groupByStatus` (lib/pm.ts) — the original draggable board. These three build
// the same `AxisColumn` shape (lib/pm.ts) for the other groupings, and ALL of them are now
// drag-capable (BoardLanes/read-only lanes are gone): Assignee/Priority commit straight to
// their `move`; Division additionally carries `people` per column so `Board` can tell whether
// a drop is unambiguous (current responsible already in the target division → commit
// immediately) or needs the responsible-person popover.
// P2-09: the two flat lane axes above stay as-is; "grid-division"/"grid-assignee" are the NEW
// true 2-axis grid mode (design spec §8) — same `?swimlane=` control, two more options, so the
// GET-form/URL contract doesn't grow a second query param.
// P4-B6: "assignee" is, by its own key (`responsibleId`), already the Responsible axis —
// `PM_TERMS.responsible` is what its board should be CALLED, but the persisted `?swimlane=`
// value stays `assignee` so old bookmarked links keep working (same precedent as the id-vs-label
// split throughout `pmVocabulary.ts`). "ball" is new: a genuinely separate axis keyed off
// `assignee.refId` (see `ballColumns` below), never derived from "assignee".
export type BoardSwimlane = "status" | "assignee" | "ball" | "priority" | "division" | "grid-division" | "grid-assignee";

export function priorityColumns(tasks: PmTask[]): AxisColumn<Priority>[] {
  return PRIORITIES.map((p) => ({ key: p, label: PRIORITY_LABEL[p], tasks: tasks.filter((t) => t.priority === p) }));
}

export function assigneeColumns(tasks: PmTask[]): AxisColumn[] {
  const byId = new Map<string, AxisColumn>();
  for (const t of tasks) {
    const id = t.assignee?.responsibleId ?? "__unassigned";
    const label = t.assignee?.responsibleName || "Unassigned";
    if (!byId.has(id)) byId.set(id, { key: id, label, tasks: [] });
    byId.get(id)!.tasks.push(t);
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------- Ball board (P4-B6/B9, plan §1.5) ----------------
// Ball is `assignee.refId`/`kind` — a genuinely different axis from Responsible
// (`assignee.responsibleId`, `assigneeColumns` above): the same person can hold the ball on one
// task and be merely responsible (not holding the ball) on another, and the two boards must show
// DIFFERENT tasks for the same person (plan §1.5's whole point). `ballKey`/`responsibleKey` are the
// single definitions both the board columns and the filter facets (`filterTasksByBall`/
// `filterTasksByResponsible`) key off, so a card can't land in one and be excluded by the other's
// filter through two separately-maintained id readers.
export function ballKey(task: PmTask): string {
  return task.assignee?.refId ?? "__no_ball";
}
export function responsibleKey(task: PmTask): string {
  return task.assignee?.responsibleId ?? "__unassigned";
}

// Per-person columns keyed off the BALL (`assignee.refId`), never `responsibleId` — dragging a
// card here reassigns who currently holds the ball (`reassignBall`) and leaves Responsible
// untouched, mirroring how the Responsible board's drag (`reassignResponsible`) leaves the ball
// alone. Repsona's own "no user" column leads the board (PM_TERMS.unassigned, lower-case by
// design) rather than sorting alphabetically with the rest — it's the parking lot for anything
// nobody has picked up yet, not just another name.
export function ballColumns(tasks: PmTask[]): AxisColumn[] {
  const byId = new Map<string, AxisColumn>();
  for (const t of tasks) {
    const id = ballKey(t);
    const label = t.assignee?.refName || PM_TERMS.unassigned;
    if (!byId.has(id)) byId.set(id, { key: id, label, tasks: [] });
    byId.get(id)!.tasks.push(t);
  }
  const rest = [...byId.entries()].filter(([id]) => id !== "__no_ball").sort((a, b) => a[1].label.localeCompare(b[1].label));
  const cols: AxisColumn[] = [];
  const noUser = byId.get("__no_ball");
  if (noUser) cols.push(noUser);
  for (const [, col] of rest) cols.push(col);
  return cols;
}

// ---------------- Ball / Responsible filter facets (P4-B9) ----------------
// Same "checkbox multi-select, empty selection = no filter" shape as the existing tag filter
// (ProjectWorkspaceView/dept board page) — an empty `ids` means the facet hasn't been touched, not
// "match nothing".
export function filterTasksByBall(tasks: PmTask[], ids: string[]): PmTask[] {
  if (ids.length === 0) return tasks;
  const keep = new Set(ids);
  return tasks.filter((t) => keep.has(ballKey(t)));
}
export function filterTasksByResponsible(tasks: PmTask[], ids: string[]): PmTask[] {
  if (ids.length === 0) return tasks;
  const keep = new Set(ids);
  return tasks.filter((t) => keep.has(responsibleKey(t)));
}

// Facet option lists for the filter-bar checkboxes — id/label pairs derived from the SAME columns
// the boards render, so a facet option's label can never drift from what the board itself calls
// that person.
export function ballFacetOptions(tasks: PmTask[]): { id: string; label: string }[] {
  return ballColumns(tasks).map((c) => ({ id: c.key, label: c.label }));
}
export function responsibleFacetOptions(tasks: PmTask[]): { id: string; label: string }[] {
  return assigneeColumns(tasks).map((c) => ({ id: c.key, label: c.label }));
}

export function divisionColumns(tasks: PmTask[], divisions: DeptDivision[]): AxisColumn[] {
  const cols: AxisColumn[] = divisions.map((d) => ({
    key: d.id,
    label: d.name,
    tasks: tasks.filter((t) => divisionTaskIds(t, d)),
    people: d.people,
  }));
  const inDivision = new Set(cols.flatMap((c) => c.tasks.map((t) => t.id)));
  const rest = tasks.filter((t) => !inDivision.has(t.id));
  // No `people` on this synthetic bucket — Board treats it as a plain (non-ambiguous) column,
  // and the server action rejects drags into it (dragging "off" a division isn't a supported move).
  if (rest.length > 0) cols.push({ key: "__no_division", label: "No division", tasks: rest });
  return cols;
}

// ---------------- True 2-axis swimlane grid (P2-09, design spec §8) ----------------
// ROWS = Division or Assignee, COLUMNS = Status — the grid `BoardGrid` (components/pm/Board.tsx)
// renders. Every row gets the SAME status-column set (key/label/color): `unionStatusColumns`'s
// labels come from `statusesByProject` alone, never from the tasks passed in, so calling it once
// per row with that row's own task slice yields uniform columns for free — no separate column-
// builder needed, and "uniform columns at any status count" (P2-05) falls straight out of reuse.
export interface GridRow {
  key: string;
  label: string;
  // Set ONLY on division rows — mirrors `AxisColumn.people` on the flat division swimlane:
  // BoardGrid's cross-row drop checks whether the task's current responsible already belongs to
  // the TARGET row's division (unambiguous commit) or needs the responsible-person popover.
  people?: { id: string; name: string }[];
  columns: AxisColumn<string>[];
}

export function divisionStatusGrid(
  tasks: PmTask[],
  divisions: DeptDivision[],
  statusesByProject: Record<string, ProjectStatus[]>,
): GridRow[] {
  const rows: GridRow[] = divisions.map((d) => ({
    key: d.id,
    label: d.name,
    people: d.people,
    columns: unionStatusColumns(tasks.filter((t) => divisionTaskIds(t, d)), statusesByProject),
  }));
  const inDivision = new Set(rows.flatMap((r) => r.columns.flatMap((c) => c.tasks.map((t) => t.id))));
  const rest = tasks.filter((t) => !inDivision.has(t.id));
  // Same "No division" sentinel as `divisionColumns` — no `people`, so BoardGrid treats a
  // cross-row drop INTO it the same way the flat division swimlane does (server rejects it).
  if (rest.length > 0) rows.push({ key: "__no_division", label: "No division", columns: unionStatusColumns(rest, statusesByProject) });
  return rows;
}

export function assigneeStatusGrid(tasks: PmTask[], statusesByProject: Record<string, ProjectStatus[]>): GridRow[] {
  const byId = new Map<string, { label: string; tasks: PmTask[] }>();
  for (const t of tasks) {
    const id = t.assignee?.responsibleId ?? "__unassigned";
    const label = t.assignee?.responsibleName || "Unassigned";
    if (!byId.has(id)) byId.set(id, { label, tasks: [] });
    byId.get(id)!.tasks.push(t);
  }
  return [...byId.entries()]
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
    .map(([id, v]) => ({ key: id, label: v.label, columns: unionStatusColumns(v.tasks, statusesByProject) }));
}
