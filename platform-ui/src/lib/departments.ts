import "server-only";
import { cache } from "react";
// Department workspaces — a "place to work" per department, composed from data
// that already exists: the org structure (lib/org) gives each department its
// divisions + placed people; PM tasks (lib/pm) are routed to a department via
// their poly-assignee (kind=department|division refId, or a responsible person
// who sits in the department). No new backend/table needed; when work is tagged
// to a unit or a unit's person, it shows up on that department's board.
import { getOrgStructure, type OrgNode } from "./org";
import { listAllPmTasks, groupByStatus, projectProgress, type PmTask, type Priority, type BoardColumn } from "./pm";
import { listAssignmentsForUnit, assignmentInclusion, SERVICE_ASSIGNMENTS_ENABLED, type AssignmentSummary } from "./serviceAssignments";
import type { Envelope } from "./envelope";
import type { RailPriority } from "@/components/departments/MyWorkRail";

export interface DeptPerson { id: string; name: string }
export interface DeptDivision { id: string; name: string; people: DeptPerson[] }
export interface DeptSummary { id: string; name: string; divisions: number; people: number; openTasks: number }
export interface DepartmentWorkspace {
  id: string;
  name: string;
  divisions: DeptDivision[];
  people: DeptPerson[];
  tasks: PmTask[];
  columns: BoardColumn[];
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
    const open = tasks.filter((x) => x.status !== "done" && belongs(x, d.id, divisionIds, personIds)).length;
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
  return { id: d.id, name: d.name, divisions, people, tasks: deptTasks, columns: groupByStatus(deptTasks) };
});

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
export function computeDeptKpis(tasks: PmTask[], projectProgressPcts: number[], now = new Date()): DeptKpis {
  const active = tasks.filter((t) => t.status === "todo" || t.status === "in_progress").length;
  const dueSoon = tasks.filter((t) => t.status !== "done" && isDueSoon(t.dueDate, now)).length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
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
export function computeProjectHealth(
  tasks: PmTask[],
  milestones: { name: string; dueDate: string | null; status: string }[],
  now = new Date(),
): ProjectHealth {
  const progressPct = projectProgress(tasks);
  const openCount = tasks.filter((t) => t.status !== "done").length;
  const overdueCount = tasks.filter((t) => t.status !== "done" && isOverdue(t.dueDate, now)).length;
  const blockedCount = tasks.filter((t) => t.status === "blocked").length;
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
export function myDeptTasksToday(tasks: PmTask[], userId: string): PmTask[] {
  return tasks
    .filter((t) => t.status !== "done" && t.assignee?.responsibleId === userId)
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
export function myBlockedTasks(tasks: PmTask[], userId: string): PmTask[] {
  return tasks.filter((t) => t.status === "blocked" && t.assignee?.responsibleId === userId);
}
