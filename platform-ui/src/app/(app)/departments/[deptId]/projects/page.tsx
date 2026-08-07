import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { listProjects } from "@/lib/entities";
import { isDoneStatus, projectUrgency, type PmTask } from "@/lib/pm";
import { formatDate } from "@/lib/format";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { UrgencyChip } from "@/components/pm/UrgencyChip";
import { taskDateEnvelope, tallyProjectTasks } from "./page-helpers";

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

  // Task counts per project, from the work routed into this department. P4-H3: was a literal
  // `t.status === "done"`, disagreeing with the Urgency column's `isDoneStatus` the moment a
  // project used a custom (renamed or extra) done status — see `tallyProjectTasks` above.
  const byProject = tallyProjectTasks(dept.tasks, dept.statusesByProject);
  const owned = allProjects.filter((p) => p.department_id === deptId);

  // One pass, keyed by project, reused below for the urgency roll-up AND the new Range column
  // (P4-H3) so both read the identical task subset.
  const tasksByProject = new Map<string, PmTask[]>();
  for (const t of dept.tasks) {
    const arr = tasksByProject.get(t.projectId) ?? [];
    arr.push(t);
    tasksByProject.set(t.projectId, arr);
  }

  // P4-G5: project-grain urgency roll-up (worst tier + counts) — the roll-up half of the ticket,
  // "glance many projects without opening any of them". `today` resolved ONCE for this render.
  // Scoped to the SAME task subset this page's "Tasks here"/"Done" columns already use (work
  // routed into this department, not necessarily every task the project owns — see the comment
  // on `byProject` above) so the three columns never disagree about which tasks they're counting.
  // The project's own authored `due_date` is folded in via `projectDueDate` so an owned project
  // that has itself slipped reads as overdue even when every remaining task looks fine. Its
  // own isDone check is now `isDoneStatus`, not a literal string, for the same reason as the
  // "Done" column fix above — a project itself can sit on a custom done status.
  const today = new Date().toISOString().slice(0, 10);
  const projectStatusesByProject = dept.statusesByProject;
  const projectUrgencyById = new Map(
    owned.map((p) => {
      const tasksHere = tasksByProject.get(p.id) ?? [];
      const roll = projectUrgency(
        tasksHere.map((t) => ({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, projectStatusesByProject[p.id]) })),
        today,
        { projectDueDate: p.due_date, projectIsDone: isDoneStatus(p.status, projectStatusesByProject[p.id]) },
      );
      return [p.id, roll] as const;
    }),
  );
  // P4-H3 — range: this list's `p.due_date` is the project's AUTHORED target (the bulk
  // `/api/:t/projects` read has no `start_date` column yet, unlike the single-project PM read —
  // see the ticket report), shown alongside the TASK-DERIVED envelope (min task start / max task
  // due, same subset as above) so a reader can see the gap between the two (decision 12).
  const rangeById = new Map(owned.map((p) => [p.id, taskDateEnvelope(tasksByProject.get(p.id) ?? [])] as const));

  return (
    <Card
      title="Department projects"
      headerRight={<span className="dash-pending-chip">{owned.length}</span>}
    >
      {owned.length === 0 ? (
        <EmptyNote>No projects owned by this department yet. Create one from Projects and set its owning department, or assign work here from a shared project — it appears on the Board tab.</EmptyNote>
      ) : (
        <HairlineTable
          columns={[{ label: "Project" }, { label: "Tasks here" }, { label: "Done" }, { label: "Urgency" }, { label: "Range", align: "right" }, { label: "Status", align: "right" }]}
          tcols="2fr 1fr 1fr 1.3fr 1.6fr 1fr"
          rows={owned.map((p) => {
            const c = byProject[p.id] ?? { total: 0, done: 0 };
            const roll = projectUrgencyById.get(p.id);
            const env = rangeById.get(p.id) ?? { start: null, end: null };
            return [
              <Link key={p.id} href={`/departments/${deptId}/projects/${p.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{p.name}</Link>,
              String(c.total),
              String(c.done),
              roll ? <UrgencyChip key="u" tier={roll.tier} variant="chip" count={roll.counts[roll.tier] || undefined} /> : "—",
              <span
                key="r"
                style={{ display: "inline-flex", flexDirection: "column", gap: 2, alignItems: "flex-end", font: "400 12px var(--font-body)" }}
              >
                <span>Target {p.due_date ? formatDate(p.due_date) : "—"}</span>
                <span style={{ color: "var(--erp-ink-50)" }}>
                  Tasks {env.start || env.end ? `${env.start ? formatDate(env.start) : "—"} → ${env.end ? formatDate(env.end) : "—"}` : "—"}
                </span>
              </span>,
              <StatusBadge key="s" label={p.status} />,
            ];
          })}
        />
      )}
    </Card>
  );
}
