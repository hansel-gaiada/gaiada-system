import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { ProjectWorkspaceView } from "@/components/pm/ProjectWorkspaceView";

type Params = Promise<{ projectId: string }>;
type Search = Promise<{ view?: string; swimlane?: string; tags?: string | string[] }>;

// Standalone project workspace route — thin wrapper (P1-05, design spec §3).
// The full workspace body now lives in `ProjectWorkspaceView` so it can be
// mounted here AND nested inside a department console
// (`/departments/[deptId]/projects/[projectId]`) with identical behaviour.
// This route stays the target for search/notifications/rollups, so its own
// auth/tenant guard is kept (zero behaviour change).
export default async function ProjectWorkspace({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { projectId } = await params;
  const sp = await searchParams;

  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  return <ProjectWorkspaceView projectId={projectId} backHref="/projects" backLabel="Projects" searchParams={sp} />;
}
