import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { getProject } from "@/lib/entities";
import { getPmTask } from "@/lib/pm";
import { TaskDetailView } from "@/components/pm/TaskDetailView";

type Params = Promise<{ deptId: string; projectId: string; taskId: string }>;

// Task detail nested INSIDE the department console (P1-06, design spec §5).
// Rendered under `departments/[deptId]/layout.tsx`, so DeptTabs + the
// full-bleed shell apply automatically. Same `TaskDetailView` body as the
// standalone `/tasks/[taskId]` route; only the breadcrumb's first hop
// differs (back -> this project's in-console workspace).
//
// Ownership guard: a task only renders here when (a) it actually belongs to
// `projectId` and (b) that project is owned by `deptId`
// (`project.department_id === deptId`, same field the Projects tab's
// ownership rollup uses). Either mismatch redirects to the standalone
// `/tasks/[taskId]` route rather than rendering a spoofed
// department/project breadcrumb for a task that isn't really this
// department's.
export default async function DepartmentTaskDetailPage({ params }: { params: Params }) {
  const { deptId, projectId, taskId } = await params;

  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const [task, project] = await Promise.all([
    getPmTask(userId, tenant, taskId),
    getProject(userId, tenant, projectId).catch(() => null),
  ]);

  if (!task || task.projectId !== projectId || !project || project.department_id !== deptId) {
    redirect(`/tasks/${taskId}`);
  }

  return (
    <TaskDetailView
      taskId={taskId}
      backHref={`/departments/${deptId}/projects/${projectId}`}
      backLabel={project.name}
    />
  );
}
