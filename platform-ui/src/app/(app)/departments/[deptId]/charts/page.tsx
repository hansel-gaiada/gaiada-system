import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment, getOwnedProjectsPm } from "@/lib/departments";
import {
  getFlow, getBurndown, aggregateFlow, aggregateBurndown, flowSeries, burndownOverlay, timelineFromDates,
  listProjectStatuses, listTags, isDoneStatus, projectProgress, distinctTagLabels, resolveTags, tagBreakdown,
  type PmTask, type Tag, type ProjectStatus, type TagBreakdownRow,
} from "@/lib/pm";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Charts, type ChartsKpis } from "@/components/pm/Charts";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// A tag-cloud rollup across the department's owned projects, each with its OWN tag registry
// (same "different ids can share a label" reality as the board's tag filter, D-1). Builds a
// synthetic registry keyed by LABEL (colour from the first project's registry carrying it —
// same rule aggregateFlow uses for status colours) and remaps every task's own tag ids to that
// shared label-id space, so the single-registry `tagBreakdown` helper can run once, unchanged,
// over the whole union. Page-local (not lib/pm.ts) — this ticket only adds `aggregateFlow` there.
function unionTagBreakdown(owned: { tasks: PmTask[]; registry: Tag[] }[]): TagBreakdownRow[] {
  const registriesByProject: Record<string, Tag[]> = {};
  owned.forEach((o, i) => { registriesByProject[String(i)] = o.registry; });
  const labels = distinctTagLabels(registriesByProject);
  if (labels.length === 0) return tagBreakdown(owned.flatMap((o) => o.tasks), []);
  const colorByLabel = new Map<string, Tag["color"]>();
  for (const o of owned) for (const tg of o.registry) if (!colorByLabel.has(tg.label)) colorByLabel.set(tg.label, tg.color);
  const syntheticRegistry: Tag[] = labels.map((label) => ({ id: label, label, color: colorByLabel.get(label)! }));
  const remappedTasks: PmTask[] = owned.flatMap((o) =>
    o.tasks.map((t) => ({ ...t, tags: resolveTags(t.tags, o.registry).map((tg) => tg.label) })),
  );
  return tagBreakdown(remappedTasks, syntheticRegistry);
}

// Charts — the department's owned projects' flow/burndown/tag data aggregated onto one set of
// P3-06 Charts cards (P3-07). Mirrors the Timeline page's owned-project fetch pattern (P1-04):
// each owned project contributes its own /flow + /burndown series + status/tag registries, summed
// here (aggregateFlow/aggregateBurndown, both BY LABEL across differing per-project registries)
// before handing serializable props to the (client) Charts component.
export default async function DepartmentChartsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const owned = await getOwnedProjectsPm(userId, tenant, deptId);

  if (owned.length === 0) {
    return <Card title="Charts"><EmptyNote>No owned projects yet — projects with this department as owner will appear here.</EmptyNote></Card>;
  }

  const [statusesList, tagsList, flowList, burndownList] = await Promise.all([
    Promise.all(owned.map((op) => listProjectStatuses(userId, tenant, op.project.id))),
    Promise.all(owned.map((op) => listTags(userId, tenant, op.project.id))),
    Promise.all(owned.map((op) => getFlow(userId, tenant, op.project.id))),
    Promise.all(owned.map((op) => getBurndown(userId, tenant, op.project.id))),
  ]);

  const hasData = flowList.some((f) => f.length > 0) || burndownList.some((b) => b.length > 0) || owned.some((op) => op.tasks.length > 0);
  if (!hasData) {
    return (
      <Card title="Charts">
        <EmptyNote>None of this department&apos;s {owned.length} owned project{owned.length === 1 ? "" : "s"} has chart data yet.</EmptyNote>
      </Card>
    );
  }

  const allTasks: PmTask[] = owned.flatMap((op, i) => op.tasks.map((t) => ({ ...t, projectName: op.project.name, projectId: op.project.id })));
  const statusesByProject: Record<string, ProjectStatus[]> = {};
  owned.forEach((op, i) => { statusesByProject[op.project.id] = statusesList[i]; });

  const kpis: ChartsKpis = {
    open: allTasks.filter((t) => !isDoneStatus(t.status, statusesByProject[t.projectId])).length,
    done: allTasks.filter((t) => isDoneStatus(t.status, statusesByProject[t.projectId])).length,
    avgProgress: projectProgress(allTasks),
  };

  const aggregatedFlow = aggregateFlow(owned.map((op, i) => ({ points: flowList[i], statuses: statusesList[i] })));
  const flow = flowSeries(aggregatedFlow.points, aggregatedFlow.statuses);

  const burndownSeries = aggregateBurndown(burndownList);
  const bdTl = burndownSeries.length ? timelineFromDates(burndownSeries[0].date, burndownSeries[burndownSeries.length - 1].date) : null;
  const bdOverlay = bdTl ? burndownOverlay(bdTl, burndownSeries) : [];

  const tagRows = unionTagBreakdown(owned.map((op, i) => ({ tasks: op.tasks, registry: tagsList[i] })));

  // P5-C1 — no wrapping Card. The three figures each own one, so the page was nesting cards
  // inside a card, and its title repeated the sub-tab that is already highlighted above it. The
  // scope line that used to sit in that card header says something the tab cannot.
  return (
    <>
      <p className="dept-timeline__facts">
        <span className="dept-timeline__fact">{owned.length} project{owned.length === 1 ? "" : "s"} owned</span>
        <span className="dept-timeline__fact"><span className="dept-timeline__fact-sep" aria-hidden>·</span>{allTasks.length} task{allTasks.length === 1 ? "" : "s"}</span>
        <span className="dept-timeline__fact"><span className="dept-timeline__fact-sep" aria-hidden>·</span>{kpis.done} done</span>
      </p>
      <Charts kpis={kpis} flow={flow} burndownSeries={burndownSeries} burndownOverlay={bdOverlay} tagRows={tagRows} taskTotal={allTasks.length} />
    </>
  );
}
