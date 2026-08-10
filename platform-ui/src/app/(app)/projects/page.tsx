import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listMembers, listProjects, type Member, type Project } from "@/lib/entities";
import { listDepartmentBriefs } from "@/lib/departments";
import { listAllPmTasks, statusesForTasks, isDoneStatus, projectUrgency, taskDateEnvelope, URGENCY_LABEL, type ProjectStatus } from "@/lib/pm";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";
import { PmSurfaceTabs } from "@/components/pm/PmSurfaceTabs";

const COLUMNS: Column[] = [
  { key: "name", header: "Name", sortable: true },
  { key: "department", header: "Department", sortable: true },
  { key: "status", header: "Status", format: "status", sortable: true },
  { key: "due_date", header: "Due date", format: "date", sortable: true },
  // P4-H3: the task-derived half of decision 12's range (min task start / max task due) shown as
  // plain text — DataTable rows are plain data (no custom cell renderer), and a composite range
  // string isn't a single parseable date, so this column stays `format: "text"` / unsortable
  // rather than mis-sorting on `format: "date"`. The AUTHORED half is the "Due date" column above
  // it; comparing the two IS the slippage signal. There is no authored START date here — the bulk
  // `/api/:t/projects` read this page uses has no `start_date` column yet (see the ticket report).
  { key: "task_range", header: "Task range" },
  { key: "urgency", header: "Urgency" },
  { key: "owner", header: "Owner", sortable: true, align: "right" },
];

// P4-H3 — the task-derived half of decision 12's range: min task start / max task due over the
// given tasks. Pure, dateStrings-only (lexical compare is safe on "YYYY-MM-DD"), no I/O — the same
// shape as the department projects list's own copy (`departments/[deptId]/projects/page.tsx`);
// duplicated rather than centralized in `lib/pm.ts` per this ticket's file-ownership boundary
// (see the ticket report for the follow-up to consolidate it there).

export default async function ProjectsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  let projects: Project[];
  let members: Member[];
  let departments: { id: string; name: string }[] = [];
  // P4-H3: tenant-wide tasks (same reader the Tasks page uses), grouped per project below, to
  // roll up urgency + the task-derived range for every row without an N+1 per-project fetch.
  let allTasks: Awaited<ReturnType<typeof listAllPmTasks>> = [];
  try {
    [projects, members, departments, allTasks] = tenant
      ? await Promise.all([
          listProjects(userId, tenant),
          listMembers(userId, tenant),
          listDepartmentBriefs(userId, tenant).catch(() => []),
          listAllPmTasks(userId, tenant),
        ])
      : [[], [], [], []];
  } catch (e) {
    if (e instanceof PlatformError && e.status === 403) {
      return (
        <>
          <PageHeader eyebrow="Business" title="Projects" />
          <PmSurfaceTabs active="projects" />
          <Card>
            <p style={{ margin: 0, font: "400 14px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
              You don&apos;t have access to this in the current company.
            </p>
          </Card>
        </>
      );
    }
    throw e;
  }
  const ownerName = new Map(members.map((m) => [m.user_id, m.name]));
  const deptName = new Map(departments.map((d) => [d.id, d.name]));

  // P4-H3: urgency + task-derived range, one pass over the tenant-wide task list, grouped by
  // project. `today` resolved ONCE for this render (never `new Date()` per row — see lib/pmUrgency.ts).
  const today = new Date().toISOString().slice(0, 10);
  const tasksByProject = new Map<string, typeof allTasks>();
  for (const t of allTasks) {
    const arr = tasksByProject.get(t.projectId) ?? [];
    arr.push(t);
    tasksByProject.set(t.projectId, arr);
  }
  const statusesByProject: Record<string, ProjectStatus[]> = tenant ? await statusesForTasks(userId, tenant, allTasks) : {};

  const rows = projects.map((p) => {
    const tasksHere = tasksByProject.get(p.id) ?? [];
    const statuses = statusesByProject[p.id];
    const isDone = isDoneStatus(p.status, statuses);
    const roll = projectUrgency(
      tasksHere.map((t) => ({ dueDate: t.dueDate, isDone: isDoneStatus(t.status, statuses) })),
      today,
      { projectDueDate: p.due_date, projectIsDone: isDone },
    );
    const env = taskDateEnvelope(tasksHere);
    return {
      id: p.id,
      name: p.name,
      department: (p.department_id && deptName.get(p.department_id)) ?? "—",
      status: p.status,
      due_date: p.due_date,
      task_range: env.start || env.end ? `${env.start ? formatDate(env.start) : "—"} → ${env.end ? formatDate(env.end) : "—"}` : "—",
      urgency: roll.counts[roll.tier] ? `${URGENCY_LABEL[roll.tier]} (${roll.counts[roll.tier]})` : URGENCY_LABEL[roll.tier],
      owner: (p.owner_id && ownerName.get(p.owner_id)) ?? "—",
    };
  });

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Projects"
        actions={<Link href="/projects/new" className="lux-btn lux-btn--solid lux-btn--sm">New project</Link>}
      />
      <PmSurfaceTabs active="projects" />
      {projects.length === 0 ? (
        <EmptyNote>No projects yet. Create the first project to get started.</EmptyNote>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/projects", idKey: "id", labelKey: "name" }} csvName="projects" pageSize={20} />
      )}
    </>
  );
}
