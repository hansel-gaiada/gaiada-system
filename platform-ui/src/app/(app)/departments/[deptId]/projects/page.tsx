import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { listProjects } from "@/lib/entities";
import { isDoneStatus, projectUrgency } from "@/lib/pm";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { UrgencyChip } from "@/components/pm/UrgencyChip";

type Params = Promise<{ deptId: string }>;

// Projects — the projects this department OWNS (department_id === deptId,
// P1-01), shown even with no tasks routed yet. Cross-department work assigned
// to this department still shows on the Board tab (routed by task assignee),
// not here — this tab is the ownership rollup.
export default async function DepartmentProjectsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const [dept, allProjects] = await Promise.all([
    getDepartment(userId, tenant, deptId),
    listProjects(userId, tenant).catch(() => []),
  ]);
  if (!dept) notFound();

  // Task counts per project, from the work routed into this department.
  const byProject = new Map<string, { total: number; done: number }>();
  for (const t of dept.tasks) {
    const row = byProject.get(t.projectId) ?? { total: 0, done: 0 };
    row.total += 1;
    if (t.status === "done") row.done += 1;
    byProject.set(t.projectId, row);
  }
  const owned = allProjects.filter((p) => p.department_id === deptId);

  // P4-G5: project-grain urgency roll-up (worst tier + counts) — the roll-up half of the ticket,
  // "glance many projects without opening any of them". `today` resolved ONCE for this render.
  // Scoped to the SAME task subset this page's "Tasks here"/"Done" columns already use (work
  // routed into this department, not necessarily every task the project owns — see the comment
  // on `byProject` above) so the three columns never disagree about which tasks they're counting.
  // The project's own authored `due_date` is folded in via `projectDueDate` so an owned project
  // that has itself slipped reads as overdue even when every remaining task looks fine.
  const today = new Date().toISOString().slice(0, 10);
  const projectStatusesByProject = dept.statusesByProject;
  const projectUrgencyById = new Map(
    owned.map((p) => {
      const tasksHere = dept.tasks.filter((t) => t.projectId === p.id);
      const roll = projectUrgency(
        tasksHere.map((t) => ({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, projectStatusesByProject[t.projectId]) })),
        today,
        { projectDueDate: p.due_date, projectIsDone: p.status === "done" },
      );
      return [p.id, roll] as const;
    }),
  );

  return (
    <Card
      title="Department projects"
      headerRight={<span className="dash-pending-chip">{owned.length}</span>}
    >
      {owned.length === 0 ? (
        <EmptyNote>No projects owned by this department yet. Create one from Projects and set its owning department, or assign work here from a shared project — it appears on the Board tab.</EmptyNote>
      ) : (
        <HairlineTable
          columns={[{ label: "Project" }, { label: "Tasks here" }, { label: "Done" }, { label: "Urgency" }, { label: "Status", align: "right" }]}
          tcols="2.2fr 1fr 1fr 1.3fr 1fr"
          rows={owned.map((p) => {
            const c = byProject.get(p.id) ?? { total: 0, done: 0 };
            const roll = projectUrgencyById.get(p.id);
            return [
              <Link key={p.id} href={`/departments/${deptId}/projects/${p.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{p.name}</Link>,
              String(c.total),
              String(c.done),
              roll ? <UrgencyChip key="u" tier={roll.tier} variant="chip" count={roll.counts[roll.tier] || undefined} /> : "—",
              <StatusBadge key="s" label={p.status} />,
            ];
          })}
        />
      )}
    </Card>
  );
}
