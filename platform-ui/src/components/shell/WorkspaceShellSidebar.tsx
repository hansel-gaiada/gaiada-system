import type { Me } from "@/lib/platform";
import { getSidebarState } from "@/lib/prefs";
import { accessibleCompanies, can, canSwitchCompany } from "@/lib/rbac";
import { servedCompanyBadge } from "@/lib/serviceAssignments";
import { activeCompany, groupNameOf } from "@/lib/companyContext";
import { SidebarState } from "./sidebarState";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

// RBAC-gated global create menu (the sidebar floor's "New" button). The list is the same in every
// workspace; DW-2f may make it workspace-aware.
export function newMenuItems(me: Me, tenantId?: string | null): { label: string; href: string }[] {
  return [
    { label: "Project", href: "/projects/new" },
    { label: "Task", href: "/tasks/new" },
    { label: "Campaign", href: "/agency/new" },
    ...(can(me, "pm.manage", tenantId) ? [{ label: "Client", href: "/clients/new" }, { label: "Deliverable", href: "/deliverables/new" }] : []),
    ...(can(me, "company.manage", tenantId) ? [{ label: "Company", href: "/companies/new" }, { label: "Invoice", href: "/invoices/new" }] : []),
    ...(can(me, "admin.access", tenantId) ? [{ label: "Employee", href: "/people/new" }] : []),
  ];
}

// DW-2a: the server half of the workspace sidebar. It reads what only the server can (the collapse
// cookie, the company list with its service badges, the New menu's gates) and hands it to the client
// half; the shell model and the area (from the URL) live in the WorkspaceShellProvider around it.
export async function WorkspaceShellSidebar({ me, tenantId }: { me: Me; tenantId: string | null }) {
  const collapsed = (await getSidebarState()) === "collapsed";
  const companies = accessibleCompanies(me);
  const current = companies.find((c) => c.id === tenantId) ?? companies[0] ?? null;
  // PV-D13: the group's name from data, else the company's name (a person outside the root).
  const brand = groupNameOf(me, tenantId) ?? activeCompany(me, tenantId)?.name ?? null;
  return (
    <SidebarState initial={collapsed}>
      <WorkspaceSidebar
        tenantId={tenantId}
        company={current ? { id: current.id, name: current.name, badge: servedCompanyBadge(me, current.id) } : null}
        // The same list and the same rule as CompanyContext: a switch only for more than one company.
        companies={canSwitchCompany(me) ? companies.map((c) => ({ id: c.id, name: c.name, badge: servedCompanyBadge(me, c.id) })) : []}
        newItems={newMenuItems(me, tenantId)}
        brand={brand}
      />
    </SidebarState>
  );
}
