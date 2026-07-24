import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { ProjectWorkspaceView } from "@/components/pm/ProjectWorkspaceView";

type Params = Promise<{ deptId: string; projectId: string }>;
type Search = Promise<{ view?: string; swimlane?: string; tags?: string | string[] }>;

// Project workspace nested INSIDE the department console (P1-05, design spec
// §3). Rendered under `departments/[deptId]/layout.tsx`, so DeptTabs + the
// full-bleed shell (DeptShellFrame's manual `/departments/{deptId}/projects/
// {x}` match) apply automatically — no shell wiring needed here. Same
// `ProjectWorkspaceView` body as the standalone `/projects/[projectId]`
// route; only the breadcrumb's first hop differs (back -> this department).
export default async function DepartmentProjectWorkspacePage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, projectId } = await params;
  const sp = await searchParams;

  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <ProjectWorkspaceView
      projectId={projectId}
      backHref={`/departments/${deptId}/projects`}
      backLabel={dept.name}
      searchParams={sp}
    />
  );
}
