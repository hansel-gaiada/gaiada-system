// DW-3f: the Overview's Work band, as data: Projects, Campaigns and Requests. Each block is what its reader said,
// kept in the three kinds of `ReadResult` so a refused or failed read can never become "no projects", "no shared
// campaigns" or "0 waiting" (plan §3.3, §3.7). Everything here is pure; the widgets do the reading.
import type { ReadResult } from "./readResult";
import { computeProjectHealth } from "./departments";
import { statusFlags, type Milestone, type PmTask, type ProjectStatus } from "./pm";
import type { DeptCampaignRow } from "./campaigns";
import type { RequestSummary } from "./requests";
import { GENERIC_WORKSPACE, WORKSPACES, hrefFor } from "./workspaces";

export const NO_ACCESS = "No access";
export const UNAVAILABLE = "Unavailable";

/** What a block says in place of its content when its read did not return data. */
export function refusalText(kind: "forbidden" | "unavailable"): string {
  return kind === "forbidden" ? NO_ACCESS : UNAVAILABLE;
}

// ── Where the blocks are placed ──────────────────────────────────────────────────────────────────

const WORK_KEYS = ["projects", "campaigns", "requests"] as const;

/** Every Work block reads for ONE unit (`unitId` / `departmentId` = the department's org node id). A workspace without
 *  one (HR, Finance and IT are functional: no org node) has nothing to scope to, so its Work blocks are not placed
 *  at all, and the band is dropped with them. Other widget keys are not this ticket's business and stay placed. */
export function workWidgetPlaced(key: string, subject: { deptId: string | null }): boolean {
  return !(WORK_KEYS as readonly string[]).includes(key) || !!subject.deptId;
}

/** A tab of the workspace's own registry rows, made concrete; null when the workspace has no such tab. The generic workspace is
 *  not in `WORKSPACES` (it takes the department's own name) but has the Project Management row, so a generic department's
 *  Projects block links to its projects too (DW-3z: Project health leaves the Home because this link says where the rest lives). */
function tabHref(workspaceKey: string | null, rowKey: string, tabKey: string, deptId: string | null): string | null {
  const tab = [...WORKSPACES, GENERIC_WORKSPACE].find((w) => w.key === workspaceKey)?.work
    .filter((r) => r.key === rowKey).flatMap((r) => r.tabs).find((t) => t.key === tabKey);
  return tab ? hrefFor(tab.href, { deptId }) : null;
}

export interface WorkLinks {
  projects: string | null;
  campaigns: string | null;
  requestsIncoming: string | null;
  requestsSent: string | null;
}

/** The pages each block links to, from the registry's own tabs: Requests > Incoming only where the workspace has
 *  that tab, Campaigns > Shared only where it has that one. The projects list is every department workspace's. */
export function workLinks(subject: { workspaceKey: string | null; deptId: string | null }): WorkLinks {
  const { workspaceKey: ws, deptId } = subject;
  return {
    projects: tabHref(ws, "pm", "projects", deptId),
    campaigns: tabHref(ws, "campaigns", "shared", deptId),
    requestsIncoming: tabHref(ws, "requests", "incoming", deptId),
    requestsSent: tabHref(ws, "requests", "sent", deptId),
  };
}

// ── Projects ─────────────────────────────────────────────────────────────────────────────────────

/** The fields of a project the block needs (`Project` from `lib/entities` fits). */
export interface WorkProject { id: string; name: string; status: string; due_date: string | null }

export type ProjectHealthReading =
  | { kind: "ok"; atRisk: boolean; reason: string | null; hasTasks: boolean; riskScore: number }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

export interface ProjectRowModel {
  id: string;
  name: string;
  health: ProjectHealthReading;
  /** The next date something is due (ISO day), or null when nothing upcoming is dated. */
  nextDue: string | null;
}

/** A project that is finished is not work left to watch. */
const CLOSED_STATUSES = new Set(["completed", "done", "closed", "cancelled", "canceled", "archived"]);
export const isOpenProject = (p: Pick<WorkProject, "status">): boolean => !CLOSED_STATUSES.has(p.status.toLowerCase());

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const dayOf = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : isoDay(d);
};

/** The earliest date from today on among the project's open tasks, its open milestones and its own due date.
 *  Dates already past are not "next": they show as overdue in the health. Null when nothing upcoming is dated. */
export function nextDueDate(
  tasks: readonly PmTask[], milestones: readonly Milestone[], projectDue: string | null, now: Date, statuses?: ProjectStatus[],
): string | null {
  const today = isoDay(now);
  const open = tasks.filter((t) => !statusFlags(t.status, statuses).isDone).map((t) => t.dueDate);
  const ms = milestones.filter((m) => m.status !== "done").map((m) => m.dueDate);
  const days = [...open, ...ms, projectDue].map(dayOf).filter((d): d is string => d !== null && d >= today).sort();
  return days[0] ?? null;
}

/** One project's row from what its work read said. A failed or refused read keeps the row (the project exists) but
 *  says its health could not be read; it is never "on track" by default. */
export function projectRow(
  project: WorkProject, work: ReadResult<{ tasks: PmTask[]; milestones: Milestone[]; statuses: ProjectStatus[] }>, now: Date,
): ProjectRowModel {
  if (work.kind !== "ok") {
    return { id: project.id, name: project.name, health: { kind: work.kind }, nextDue: null };
  }
  const { tasks, milestones, statuses } = work.data;
  const h = computeProjectHealth(tasks, milestones.map((m) => ({ name: m.name, dueDate: m.dueDate, status: m.status })), now, statuses);
  return {
    id: project.id,
    name: project.name,
    health: {
      kind: "ok", atRisk: h.atRisk, reason: h.atRiskReason ?? null, hasTasks: h.composition.total > 0,
      // More overdue and blocked tasks rank higher; atRisk is already "overdue or blocked".
      riskScore: h.composition.overdue + h.composition.blocked,
    },
    nextDue: nextDueDate(tasks, milestones, project.due_date, now, statuses),
  };
}

/** Rank: at risk first (the most overdue and blocked on top), then the projects whose health could not be read
 *  (unknown is not safe), then the ones on track. Ties go to the nearest next date (undated last), then the name. */
const rank = (r: ProjectRowModel): [number, number] => {
  if (r.health.kind === "ok") return r.health.atRisk ? [0, -r.health.riskScore] : [2, 0];
  return [1, 0];
};

export function sortByRisk(rows: readonly ProjectRowModel[]): ProjectRowModel[] {
  return [...rows].sort((a, b) => {
    const [ra, sa] = rank(a);
    const [rb, sb] = rank(b);
    if (ra !== rb) return ra - rb;
    if (sa !== sb) return sa - sb;
    if (a.nextDue !== b.nextDue) return a.nextDue === null ? 1 : b.nextDue === null ? -1 : a.nextDue.localeCompare(b.nextDue);
    return a.name.localeCompare(b.name);
  });
}

export const PROJECTS_SHOWN = 4;

export type ProjectsView =
  | { kind: "ok"; rows: ProjectRowModel[]; total: number }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** The block's state. `total` counts every open project, so "4 of 9" can say what was cut. An empty `ok` is a real
 *  "this department owns no open project"; a failed list never reaches it. */
export function projectsView(result: ReadResult<ProjectRowModel[]>): ProjectsView {
  if (result.kind !== "ok") return { kind: result.kind };
  return { kind: "ok", rows: sortByRisk(result.data).slice(0, PROJECTS_SHOWN), total: result.data.length };
}

/** The health in words: "At risk · 2 overdue", "On track", "No tasks yet", or why it could not be read. */
export function healthText(h: ProjectHealthReading): string {
  if (h.kind !== "ok") return refusalText(h.kind);
  if (h.atRisk) return h.reason ? `At risk · ${h.reason}` : "At risk";
  return h.hasTasks ? "On track" : "No tasks yet";
}

// ── Campaigns ────────────────────────────────────────────────────────────────────────────────────

export const CAMPAIGNS_SHOWN = 4;

export interface CampaignRowModel {
  id: string;
  name: string;
  /** OUR part's status, or in words why there is none (the department only leads it, or has no part). */
  ourPart: string;
  /** OUR part's status as the backend sends it, drawn as a status badge like the Campaigns pages do; null when
   *  `ourPart` is the sentence saying why there is no part. */
  partStatus: string | null;
  startsOn: string | null;
  endsOn: string | null;
}

export type CampaignsView =
  | { kind: "ok"; rows: CampaignRowModel[]; total: number }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** Campaigns where the department has a part come first (the ones it must act on), the soonest ending first and the
 *  undated last; the rest follow. The cut is the top few; `total` says how many there are. */
export function campaignsView(result: ReadResult<DeptCampaignRow[]>, deptId: string | null): CampaignsView {
  if (result.kind !== "ok") return { kind: result.kind };
  const rows = [...result.data].sort((a, b) => {
    if (!!a.part !== !!b.part) return a.part ? -1 : 1;
    if (a.endsOn !== b.endsOn) return a.endsOn === null ? 1 : b.endsOn === null ? -1 : a.endsOn.localeCompare(b.endsOn);
    return a.name.localeCompare(b.name);
  });
  return {
    kind: "ok",
    total: rows.length,
    rows: rows.slice(0, CAMPAIGNS_SHOWN).map((r) => ({
      id: r.id, name: r.name, startsOn: r.startsOn, endsOn: r.endsOn,
      ourPart: r.part ? r.part.status : r.leadUnitId && r.leadUnitId === deptId ? "Lead, no part" : "No part",
      partStatus: r.part ? r.part.status : null,
    })),
  };
}

// ── Requests ─────────────────────────────────────────────────────────────────────────────────────

export type RequestsView =
  | { kind: "ok"; incoming: number; sent: number; oldestOpenAt: string | null; oldestAge: string | null }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

const HOUR_MS = 3600 * 1000;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** How long ago, in the unit a person would say it: days, else hours, else "under an hour". Null for a date that is not one
 *  or lies in the future (a clock skew is not an age). */
export function ageText(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t) || t > now.getTime()) return null;
  const hours = Math.floor((now.getTime() - t) / HOUR_MS);
  if (hours >= 24) return plural(Math.floor(hours / 24), "day");
  return hours >= 1 ? plural(hours, "hour") : "under an hour";
}

/** The counts only from a successful read. The oldest waiting is shown only while something waits. */
export function requestsView(result: ReadResult<RequestSummary>, now: Date): RequestsView {
  if (result.kind !== "ok") return { kind: result.kind };
  const { incoming, sent } = result.data;
  const oldest = incoming.open > 0 ? incoming.oldestOpenAt : null;
  return { kind: "ok", incoming: incoming.open, sent: sent.open, oldestOpenAt: oldest, oldestAge: ageText(oldest, now) };
}
