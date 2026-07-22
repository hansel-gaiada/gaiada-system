import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPrefs } from "@/lib/prefs";
import { listDepartmentBriefs, type DeptBrief } from "@/lib/departments";
import { Shell } from "@/components/shell/Shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId).catch(() => null);
  if (!me) redirect("/login");
  const tenantId = await getActiveTenant(me);
  const prefs = await getPrefs();
  // The active company's departments for the Departments nav section.
  const departments: DeptBrief[] = tenantId
    ? await listDepartmentBriefs(userId, tenantId).catch(() => [] as DeptBrief[])
    : [];
  return (
    <Shell me={me} tenantId={tenantId} moduleLabel="My Workspace" prefs={prefs} departments={departments}>
      {children}
    </Shell>
  );
}
