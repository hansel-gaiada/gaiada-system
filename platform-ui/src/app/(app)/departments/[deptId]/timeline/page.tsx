import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartment, getOwnedProjectsPm } from "@/lib/departments";
import {
  computeTimeline, groupTimelineBars, milestoneMarkers, dependencyEdges,
  getBurndown, aggregateBurndown, burndownOverlay, isDoneStatus, taskUrgency,
  type PmTask, type Milestone, type UrgencyTier,
} from "@/lib/pm";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Gantt } from "@/components/pm/Gantt";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Timeline — the department's owned projects' tasks + milestones aggregated onto
// one shared Gantt axis (P1-04). Projects with no dated work are surfaced as
// collapsed note groups (never silently dropped). The Gantt is `interactive`:
// drag-to-reschedule + dependency-draw, gated on pm.manage (server enforces).
export default async function DepartmentTimelinePage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const owned = await getOwnedProjectsPm(userId, tenant, deptId);

  const isDated = (op: { tasks: PmTask[]; milestones: Milestone[] }) =>
    op.tasks.some((t) => t.startDate || t.dueDate) || op.milestones.some((m) => m.dueDate);
  const datedOwned = owned.filter(isDated);
  const undated = owned.filter((op) => !isDated(op));

  // Tag each task with its owning project's name so grouping labels are correct
  // even when the PM reader didn't populate projectName.
  const allTasks: PmTask[] = datedOwned.flatMap((op) => op.tasks.map((t) => ({ ...t, projectName: op.project.name })));
  const allMilestones: Milestone[] = datedOwned.flatMap((op) => op.milestones);

  const timeline = computeTimeline(allTasks);
  const canEdit = can(me, "pm.manage", tenant);

  // P4-G5: urgency, resolved ONCE for this render — each task's own owning project's status
  // registry decides its `isDone` (same registry `statusesByProject` already keys the board by).
  const today = new Date().toISOString().slice(0, 10);
  const taskUrgencyById: Record<string, UrgencyTier> = {};
  for (const t of allTasks) taskUrgencyById[t.id] = taskUrgency({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, dept.statusesByProject[t.projectId]) }, today);

  if (!timeline) {
    return (
      <Card title="Timeline">
        {owned.length === 0 ? (
          <EmptyNote>No owned projects yet — projects with this department as owner will appear here.</EmptyNote>
        ) : (
          <EmptyNote>None of this department&apos;s {owned.length} owned project{owned.length === 1 ? "" : "s"} has dated tasks or milestones yet. Add start/due dates to see them on the timeline.</EmptyNote>
        )}
      </Card>
    );
  }

  const groups = groupTimelineBars(timeline.bars, "project", allMilestones.map((m) => ({ id: m.id, name: m.name })));
  const markers = milestoneMarkers(timeline, allMilestones);
  const edges = dependencyEdges(timeline.bars);
  const undatedGroups = undated.map((op) => ({ key: op.project.id, label: op.project.name, note: "No scheduled tasks or milestones yet." }));

  // Burndown overlay (P2-08, design spec §4 phase-2): one series per dated owned project,
  // summed onto a single department-wide line and positioned on this shared axis.
  const burndownSeries = await Promise.all(datedOwned.map((op) => getBurndown(userId, tenant, op.project.id)));
  const burndown = burndownOverlay(timeline, aggregateBurndown(burndownSeries));

  return (
    <Card
      title="Timeline"
      headerRight={<span style={{ font: "700 10px var(--font-body)", letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>{datedOwned.length} project{datedOwned.length === 1 ? "" : "s"} scheduled</span>}
    >
      <Gantt
        timeline={timeline}
        groups={groups}
        groupBy="project"
        milestones={markers}
        depEdges={edges}
        undatedGroups={undatedGroups}
        interactive
        canEdit={canEdit}
        burndown={burndown}
        taskUrgency={taskUrgencyById}
        // Server-resolved today — the same one that decided every tier in taskUrgencyById, so the
        // marker line and the bars around it can never disagree about what day it is.
        todayISO={today}
      />
    </Card>
  );
}
