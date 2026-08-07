import "server-only";
// The one place that answers "which tasks + which status registries does THIS scope cover" for
// every `/pm` view (Board/Gantt/Charts) — P4-A3. Same-shape output whichever kind, so the pages
// never fork per scope; only the fetch behind `resolveScopeWork` differs.
//
// Module-trio naming per platform-ui/CLAUDE.md: `pmScope.ts` (client-safe types) / this file
// (server-only readers) / `pmScopeActions.ts` ("use server" cookie writes). This file is free to
// import BOTH `lib/pm.ts` and `lib/departments.ts` — `departments.ts` already imports `pm.ts`, so
// importing `departments.ts` FROM `pm.ts` would be a cycle; importing both from a third file has
// no such constraint.
import {
  listAllPmTasksPaged, listPmTasks, getPmProject, statusesForTasks, listMilestones, listTags,
  getFlow, getBurndown, getTenantFlow, getTenantBurndown,
  aggregateFlow, aggregateBurndown, flowSeries, burndownOverlay, timelineFromDates,
  tagBreakdown, resolveTags, distinctTagLabels, projectProgress, isDoneStatus, synthDefaultStatuses,
  type PmTask, type ProjectStatus, type Milestone, type Tag, type TagBreakdownRow,
  type FlowSeries, type BurndownPoint, type BurndownOverlayPoint, type Timeline,
} from "./pm";
import type { ChartsKpis } from "@/components/pm/Charts";
import { getDepartment, listDepartmentBriefs } from "./departments";
import { listProjects, type Project } from "./entities";
import { PM_TERMS } from "./pmVocabulary";
import { PM_SCOPE_ALL, type PmScope } from "./pmScope";

// ---- scope switcher options ----
export interface ScopeOption { id: string; name: string }
export async function pmScopeOptions(u: string, t: string): Promise<{ departments: ScopeOption[]; projects: ScopeOption[] }> {
  const [departments, projects] = await Promise.all([
    listDepartmentBriefs(u, t).catch(() => [] as ScopeOption[]),
    listProjects(u, t).catch(() => [] as Project[]),
  ]);
  return { departments, projects: projects.map((p) => ({ id: p.id, name: p.name })) };
}

// ---- the scope resolver (P4-A3) ----
export interface ScopeWork {
  scope: PmScope;
  label: string;
  tasks: PmTask[];
  // P2-05: each project this scope's tasks touch -> its own status registry. Never empty for a
  // project that has any task in `tasks` (the "project" branch below always supplies at least the
  // synth defaults) — every existing board/Gantt/Charts helper (unionStatusColumns, isDoneStatus,
  // taskUrgency's isDone input, …) already expects exactly this shape.
  statusesByProject: Record<string, ProjectStatus[]>;
  projectIds: string[];
  // True when the requested scope (a department/project id from a stale cookie, or one the caller
  // can no longer read) didn't resolve and this fell back to `@all` — the page surfaces this as a
  // quiet notice rather than a 404, same "never brick the surface" precedent as `parsePmScope`.
  fellBackToAll: boolean;
}

export async function resolveScopeWork(u: string, t: string, scope: PmScope): Promise<ScopeWork> {
  if (scope.kind === "department" && scope.id) {
    const dept = await getDepartment(u, t, scope.id);
    if (dept) {
      return {
        scope, label: dept.name, tasks: dept.tasks, statusesByProject: dept.statusesByProject,
        projectIds: [...new Set(dept.tasks.map((x) => x.projectId))], fellBackToAll: false,
      };
    }
  } else if (scope.kind === "project" && scope.id) {
    const project = await getPmProject(u, t, scope.id);
    if (project) {
      const tasks = await listPmTasks(u, t, scope.id);
      const statuses = project.statuses.length ? project.statuses : synthDefaultStatuses();
      return {
        scope, label: project.name, tasks, statusesByProject: { [scope.id]: statuses },
        projectIds: [scope.id], fellBackToAll: false,
      };
    }
  }
  // "all", or a department/project id that no longer resolves.
  const tasks = await listAllPmTasksPaged(u, t, { includeClosed: true });
  const statusesByProject = await statusesForTasks(u, t, tasks);
  return {
    scope: PM_SCOPE_ALL, label: PM_TERMS.crossProject, tasks, statusesByProject,
    projectIds: [...new Set(tasks.map((x) => x.projectId))],
    fellBackToAll: scope.kind !== "all",
  };
}

// ---- tag registries for the scope's involved projects (board filter bar + Charts tag rows) ----
export async function scopeTagRegistries(u: string, t: string, projectIds: string[]): Promise<Record<string, Tag[]>> {
  const registries = await Promise.all(projectIds.map((pid) => listTags(u, t, pid)));
  const out: Record<string, Tag[]> = {};
  projectIds.forEach((pid, i) => { out[pid] = registries[i]; });
  return out;
}

// ---- Gantt data for any scope ----
export async function scopeMilestones(u: string, t: string, projectIds: string[]): Promise<Milestone[]> {
  const lists = await Promise.all(projectIds.map((pid) => listMilestones(u, t, pid)));
  return lists.flat();
}

// Burndown overlay positioned on the Gantt's own shared axis. `@all` uses the tenant-grain reader
// directly (already summed server-side); department/project scope aggregates per-project series
// the same way the department Timeline page already does (`aggregateBurndown`), just driven by
// this scope's own `projectIds` instead of a department's owned-projects list.
export async function scopeBurndownOverlay(u: string, t: string, work: ScopeWork, timeline: Timeline): Promise<BurndownOverlayPoint[]> {
  const series = work.scope.kind === "all"
    ? await getTenantBurndown(u, t)
    : aggregateBurndown(await Promise.all(work.projectIds.map((pid) => getBurndown(u, t, pid))));
  return burndownOverlay(timeline, series);
}

// ---- Charts data for any scope ----
export interface ScopeChartsData {
  kpis: ChartsKpis;
  flow: FlowSeries;
  burndownSeries: BurndownPoint[];
  burndownOverlay: BurndownOverlayPoint[];
  tagRows: TagBreakdownRow[];
}

// A tag-cloud rollup across several projects, each with its OWN tag registry — copy of the
// department Charts page's page-local `unionTagBreakdown` (same "different ids can share a label"
// reality, D-1). Kept as a private duplicate rather than importing across page files: this is the
// PM-scope module's own private helper, not a third caller of a shared one — see the report for
// why a shared version wasn't hoisted into `lib/pm.ts` for this ticket.
// Exported (not just used internally) so it's unit-testable in isolation — same reasoning as
// `page-helpers.ts` files elsewhere in this app.
export function unionTagBreakdown(perProject: { tasks: PmTask[]; registry: Tag[] }[]): TagBreakdownRow[] {
  const registriesByProject: Record<string, Tag[]> = {};
  perProject.forEach((p, i) => { registriesByProject[String(i)] = p.registry; });
  const labels = distinctTagLabels(registriesByProject);
  if (labels.length === 0) return tagBreakdown(perProject.flatMap((p) => p.tasks), []);
  const colorByLabel = new Map<string, Tag["color"]>();
  for (const p of perProject) for (const tg of p.registry) if (!colorByLabel.has(tg.label)) colorByLabel.set(tg.label, tg.color);
  const syntheticRegistry: Tag[] = labels.map((label) => ({ id: label, label, color: colorByLabel.get(label)! }));
  const remappedTasks: PmTask[] = perProject.flatMap((p) =>
    p.tasks.map((t) => ({ ...t, tags: resolveTags(t.tags, p.registry).map((tg) => tg.label) })),
  );
  return tagBreakdown(remappedTasks, syntheticRegistry);
}

// The tenant-grain flow endpoint merges by literal status id (see `getTenantFlow`'s own doc for why
// that's safe), so the label/colour registry it needs is a union BY ID across every involved
// project's own registry — never by label (that's the department Charts page's different problem,
// aggregating INDEPENDENT per-project series that were never pre-merged). Ordered by each id's
// average position across the projects that carry it, same precedent as `distinctStatusLabels`.
export function representativeStatusesById(statusesByProject: Record<string, ProjectStatus[]>): ProjectStatus[] {
  const acc = new Map<string, { label: string; color: string; isDone: boolean; isBlocked: boolean; sum: number; count: number }>();
  for (const list of Object.values(statusesByProject)) {
    for (const s of list) {
      const a = acc.get(s.id);
      if (a) { a.sum += s.position; a.count += 1; }
      else acc.set(s.id, { label: s.label, color: s.color, isDone: s.isDone, isBlocked: s.isBlocked, sum: s.position, count: 1 });
    }
  }
  return [...acc.entries()]
    .sort((a, b) => a[1].sum / a[1].count - b[1].sum / b[1].count)
    .map(([id, v], i) => ({ id, label: v.label, color: v.color, isDone: v.isDone, isBlocked: v.isBlocked, position: i }));
}

export async function scopeChartsData(u: string, t: string, work: ScopeWork): Promise<ScopeChartsData> {
  const { tasks, statusesByProject, projectIds, scope } = work;
  const kpis: ChartsKpis = {
    open: tasks.filter((x) => !isDoneStatus(x.status, statusesByProject[x.projectId])).length,
    done: tasks.filter((x) => isDoneStatus(x.status, statusesByProject[x.projectId])).length,
    avgProgress: projectProgress(tasks),
  };

  let flow: FlowSeries;
  let burndownSeries: BurndownPoint[];
  if (scope.kind === "all") {
    const [flowPoints, bd] = await Promise.all([getTenantFlow(u, t), getTenantBurndown(u, t)]);
    flow = flowSeries(flowPoints, representativeStatusesById(statusesByProject));
    burndownSeries = bd;
  } else {
    const [flowList, bdList] = await Promise.all([
      Promise.all(projectIds.map((pid) => getFlow(u, t, pid))),
      Promise.all(projectIds.map((pid) => getBurndown(u, t, pid))),
    ]);
    const agg = aggregateFlow(projectIds.map((pid, i) => ({ points: flowList[i], statuses: statusesByProject[pid] ?? synthDefaultStatuses() })));
    flow = flowSeries(agg.points, agg.statuses);
    burndownSeries = aggregateBurndown(bdList);
  }

  const bdTimeline = burndownSeries.length ? timelineFromDates(burndownSeries[0].date, burndownSeries[burndownSeries.length - 1].date) : null;
  const overlay = bdTimeline ? burndownOverlay(bdTimeline, burndownSeries) : [];

  const registriesByProject = await scopeTagRegistries(u, t, projectIds);
  const tagRows = projectIds.length <= 1
    ? tagBreakdown(tasks, registriesByProject[projectIds[0] ?? ""] ?? [])
    : unionTagBreakdown(projectIds.map((pid) => ({ tasks: tasks.filter((x) => x.projectId === pid), registry: registriesByProject[pid] ?? [] })));

  return { kpis, flow, burndownSeries, burndownOverlay: overlay, tagRows };
}
