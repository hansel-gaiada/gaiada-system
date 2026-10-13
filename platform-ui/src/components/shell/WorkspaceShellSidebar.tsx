import type { Me } from "@/lib/platform";
import { getSidebarState } from "@/lib/prefs";
import { accessibleCompanies, canSwitchCompany } from "@/lib/rbac";
import { servedCompanyBadge } from "@/lib/serviceAssignments";
import { newMenuItems } from "./Sidebar";
import { SidebarState } from "./sidebarState";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

// DW-2a: the server half of the workspace sidebar. It reads what only the server can (the collapse
// cookie, the company list with its service badges, the New menu's gates) and hands it to the client
// half; the shell model and the area (from the URL) live in the WorkspaceShellProvider around it.
export async function WorkspaceShellSidebar({ me, tenantId }: { me: Me; tenantId: string | null }) {
  const collapsed = (await getSidebarState()) === "collapsed";
  const companies = accessibleCompanies(me);
  const current = companies.find((c) => c.id === tenantId) ?? companies[0] ?? null;
  return (
    <SidebarState initial={collapsed}>
      <WorkspaceSidebar
        tenantId={tenantId}
        company={current ? { id: current.id, name: current.name, badge: servedCompanyBadge(me, current.id) } : null}
        // The same list and the same rule as CompanyContext: a switch only for more than one company.
        companies={canSwitchCompany(me) ? companies.map((c) => ({ id: c.id, name: c.name, badge: servedCompanyBadge(me, c.id) })) : []}
        newItems={newMenuItems(me, tenantId)}
      />
    </SidebarState>
  );
}
