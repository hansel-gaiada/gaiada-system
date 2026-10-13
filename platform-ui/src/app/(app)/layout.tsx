import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPrefs } from "@/lib/prefs";
import { listDepartmentBriefs, type DeptBrief } from "@/lib/departments";
import { Shell } from "@/components/shell/Shell";
import { isClientOnly } from "@/lib/rbac";
import { myWorkspaces } from "@/lib/workspaces-data";
import { buildShellModel, type ShellModel } from "@/lib/shellModel";

// `drawer` is the parallel slot the intercepted task route renders into (see @drawer/). It sits
// OUTSIDE <Shell>'s scroll container so the slide-over is positioned against the viewport rather
// than the scrolled main column.
export default async function AppLayout({ children, drawer }: { children: React.ReactNode; drawer: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId).catch(() => null);
  if (!me) redirect("/login");

  // An external client has no business anywhere in the STAFF group. This lives in the layout, not on
  // the root page, because the layout is the only place that covers the whole group: redirecting from
  // `(app)/page.tsx` alone still let a client reach /projects, /tasks or /meetings and get the staff
  // shell, where every read 403-degrades into an empty page that reads like "you have no projects".
  //
  // The inverse is deliberately NOT symmetric: `(portal)/portal/layout.tsx` does NOT bounce staff,
  // because a manager legitimately opens the portal to see what their client sees. Only the
  // client -> staff direction is a mistake.
  if (isClientOnly(me)) redirect("/portal");

  const tenantId = await getActiveTenant(me);
  const prefs = await getPrefs();
  // The active company's departments for the Departments nav section.
  const departments: DeptBrief[] = tenantId
    ? await listDepartmentBriefs(userId, tenantId).catch(() => [] as DeptBrief[])
    : [];
  // DW-2a: only the pilot switch reads the person's workspaces, so the classic shell makes no extra call.
  // A model that cannot be built leaves the classic sidebar, never a broken page.
  let workspaceModel: ShellModel | null = null;
  if (prefs.shell === "workspaces") {
    try {
      workspaceModel = buildShellModel({ me, tenantId, workspaces: await myWorkspaces(me, tenantId) });
    } catch {
      workspaceModel = null;
    }
  }
  return (
    <>
      <Shell me={me} tenantId={tenantId} moduleLabel="My Workspace" prefs={prefs} departments={departments} workspaceModel={workspaceModel}>
        {children}
      </Shell>
      {drawer}
    </>
  );
}
