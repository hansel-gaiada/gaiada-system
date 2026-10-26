import type { Me } from "@/lib/platform";
import type { Theme } from "@/lib/prefs";
import { logout } from "@/app/(app)/account/actions";
import { getSidebarState } from "@/lib/prefs";
import { accessibleCompanies, can, canSwitchCompany } from "@/lib/rbac";
import { servedCompanyBadge } from "@/lib/serviceAssignments";
import { activeCompany, groupNameOf } from "@/lib/companyContext";
import { SidebarState } from "./sidebarState";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { SkinPhoneBar } from "./SkinPhoneBar";

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
export async function WorkspaceShellSidebar({ me, tenantId, theme = "auto" }: { me: Me; tenantId: string | null; theme?: Theme }) {
  const collapsed = (await getSidebarState()) === "collapsed";
  const companies = accessibleCompanies(me);
  const current = companies.find((c) => c.id === tenantId) ?? companies[0] ?? null;
  // PV-D13: the group's name from data, else the company's name (a person outside the root).
  const brand = groupNameOf(me, tenantId) ?? activeCompany(me, tenantId)?.name ?? null;
  const sidebarCompany = current ? { id: current.id, name: current.name, badge: servedCompanyBadge(me, current.id) } : null;
  // The same list and the same rule as the old company switcher: a switch only for more than one company.
  const switchable = canSwitchCompany(me) ? companies.map((c) => ({ id: c.id, name: c.name, badge: servedCompanyBadge(me, c.id) })) : [];
  const newItems = newMenuItems(me, tenantId);
  // SCP-Kd: what the top bar's avatar menu offers, for the Social skin's More panel (the same name, title, initials and client-view rule as the top bar).
  const account = {
    name: me.name,
    secondary: me.title ?? me.email,
    initials: me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase(),
    clientView: (me.clientOf ?? []).length > 0,
    theme,
    logout,
  };
  return (
    <>
      <SidebarState initial={collapsed}>
        <WorkspaceSidebar tenantId={tenantId} company={sidebarCompany} companies={switchable} newItems={newItems} brand={brand} account={account} />
      </SidebarState>
      {/* SCP-Ke: the Social skin's phone bar, a sibling of the sidebar in the frame (never inside it: on a phone the sidebar is a transformed drawer that
          would trap a fixed child). It draws nothing for Standard. */}
      <SkinPhoneBar tenantId={tenantId} newItems={newItems} company={sidebarCompany} companies={switchable} account={account} />
    </>
  );
}
