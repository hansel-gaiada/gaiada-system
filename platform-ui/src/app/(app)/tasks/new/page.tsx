import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getFieldDefs, listProjects } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { TaskForm } from "@/components/forms/TaskForm";
import { createTaskInProject } from "../actions";

export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<{ projectId?: string }>;
}) {
  const { projectId } = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/tasks");

  if (!projectId) {
    const projects = await listProjects(userId, tenant);
    return (
      <>
        <PageHeader eyebrow="Task" title="New task" subtitle="Choose the project this task belongs to." />
        <Card>
          {projects.length === 0 ? (
            <div className="dash-empty">
              <p>No projects yet — create a project first.</p>
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {projects.map((p) => (
                <li key={p.id}>
                  <Link href={`/tasks/new?projectId=${p.id}`} className="lux-btn lux-btn--ghost lux-btn--sm">
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </>
    );
  }

  const defs = await getFieldDefs(userId, tenant, "task");

  return (
    <>
      <PageHeader eyebrow="Task" title="New task" />
      <TaskForm action={createTaskInProject.bind(null, projectId)} defs={defs} members={[]} />
    </>
  );
}
