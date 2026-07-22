import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { listProjects } from "@/lib/entities";
import { moveTask } from "@/lib/pmActions";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";

type Params = Promise<{ deptId: string }>;

// Projects & Workflow — the department's working surface. The live board (tasks
// routed to this department, its divisions, or its people) plus a rollup of the
// projects that work sits in. Drag a card to move it; everything else lives in
// the full Projects / Delivery Pipeline sections.
export default async function DepartmentWorkflowPage({ params }: { params: Params }) {
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
  // Projects this department OWNS (department_id === deptId) — shown even with no
  // tasks yet. Cross-department work on projects owned elsewhere still appears on
  // the board below (routed by task assignment).
  const owned = allProjects.filter((p) => p.department_id === deptId);

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
        <div style={{ font: "700 10px var(--font-body)", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--erp-ink-50)" }}>Work board</div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link href="/pipeline" className="lux-btn lux-btn--ghost lux-btn--sm">Delivery Pipeline</Link>
          <Link href="/projects" className="lux-btn lux-btn--ghost lux-btn--sm">All projects</Link>
        </div>
      </div>

      {dept.tasks.length === 0 ? (
        <Card><EmptyNote>No work routed to this department yet. Tasks assigned to {dept.name}, its divisions, or its people appear here.</EmptyNote></Card>
      ) : (
        <Board columns={dept.columns} move={moveTask} />
      )}

      <div style={{ marginTop: 24 }}>
        <Card
          title="Department projects"
          headerRight={<span className="dash-pending-chip">{owned.length}</span>}
        >
          {owned.length === 0 ? (
            <EmptyNote>No projects owned by this department yet. Create one from Projects and set its owning department, or assign work here from a shared project — it appears on the board above.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Project" }, { label: "Tasks here" }, { label: "Done" }, { label: "Status", align: "right" }]}
              tcols="2.4fr 1fr 1fr 1fr"
              rows={owned.map((p) => {
                const c = byProject.get(p.id) ?? { total: 0, done: 0 };
                return [
                  <Link key={p.id} href={`/projects/${p.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{p.name}</Link>,
                  String(c.total),
                  String(c.done),
                  <StatusBadge key="s" label={p.status} />,
                ];
              })}
            />
          )}
        </Card>
      </div>
    </>
  );
}
