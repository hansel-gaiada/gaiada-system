import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPrefs } from "@/lib/prefs";
import { myPlacement, listDepartmentBriefs, type MyPlacement, type DeptBrief } from "@/lib/departments";
import { Shell } from "@/components/shell/Shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId).catch(() => null);
  if (!me) redirect("/login");
  const tenantId = await getActiveTenant(me);
  const prefs = await getPrefs();
  // The signed-in employee's own department/division in the active company (sidebar "My team"),
  // plus the active company's departments for the expandable Departments nav (shares the
  // org-structure fetch via cache — no extra round-trip).
  const [placement, departments]: [MyPlacement | null, DeptBrief[]] = tenantId
    ? await Promise.all([
        myPlacement(userId, tenantId, userId).catch(() => null),
        listDepartmentBriefs(userId, tenantId).catch(() => [] as DeptBrief[]),
      ])
    : [null, []];
  return (
    <Shell me={me} tenantId={tenantId} moduleLabel="My Workspace" prefs={prefs} placement={placement} departments={departments}>
      {children}
    </Shell>
  );
}
