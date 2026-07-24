import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { TaskDetailView } from "@/components/pm/TaskDetailView";

// Standalone task detail route — thin wrapper (P1-06, design spec §5). The
// full detail body now lives in `TaskDetailView` so it can be mounted here
// AND nested inside a department console
// (`/departments/[deptId]/projects/[projectId]/tasks/[taskId]`) with
// identical behaviour. This route stays the target for search/notifications/
// rollups, so its own auth/tenant guard is kept (zero behaviour change).
export default async function TaskDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  return <TaskDetailView taskId={taskId} backHref="/projects" backLabel="Projects" />;
}
