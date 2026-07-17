import type { Me } from "@/lib/platform";
import { can, isElevated, isClient, canManageIT } from "@/lib/rbac";
import type { IconName } from "./icons";

// Access helpers live in lib/rbac (the RBAC source of truth); re-exported here
// because existing call sites import them from the nav module.
export { isElevated, canManageIT } from "@/lib/rbac";

export interface NavItem { label: string; href: string; icon: IconName }
export interface NavGroup { label: string; items: NavItem[] }

// Nav is capability-gated against the ACTIVE company (tenantId). Company-scoped
// capabilities (people.directory, admin.access) resolve for that company;
// cross-company ones (rollups.view) require a global grant.
export function navFor(me: Me, tenantId?: string | null): NavGroup[] {
  // WS11: an external client (not also staff) gets a clean portal-only nav — never the staff surface.
  if (isClient(me) && !isElevated(me)) {
    return [{ label: "Portal", items: [{ label: "Project Portal", href: "/portal", icon: "home" }] }];
  }
  const business: NavItem[] = [
    { label: "Projects", href: "/projects", icon: "projects" },
    { label: "Tasks", href: "/tasks", icon: "check" },
    { label: "Clients", href: "/clients", icon: "finance" },
    { label: "Deliverables", href: "/deliverables", icon: "box" },
    { label: "Timesheets", href: "/timesheets", icon: "clock" },
    ...(can(me, "company.manage", tenantId) ? [{ label: "Billing", href: "/billing", icon: "wallet" } as NavItem] : []),
    { label: "Agency", href: "/agency", icon: "sales" },
    { label: "Delivery Pipeline", href: "/pipeline", icon: "pulse" },
    ...(can(me, "rollups.view") ? [{ label: "Rollups", href: "/rollups", icon: "pulse" } as NavItem] : []),
  ];
  const groups: NavGroup[] = [
    { label: "Workspace", items: [
      { label: "My Work", href: "/", icon: "home" },
      { label: "Calendar", href: "/calendar", icon: "clock" },
      { label: "Approvals", href: "/approvals", icon: "check" },
      ...(can(me, "people.directory", tenantId) ? [{ label: "People", href: "/people", icon: "hr" } as NavItem] : []),
    ] },
    { label: "Organization", items: [
      { label: "Overview", href: "/organization", icon: "inventory" },
      { label: "Companies", href: "/companies", icon: "finance" },
    ] },
    { label: "Business", items: business },
    { label: "Intelligence", items: [
      { label: "Knowledge", href: "/knowledge", icon: "box" },
      { label: "AI Agents", href: "/agents", icon: "agents" },
    ] },
    { label: "Systems", items: [
      { label: "WA/TG Bot", href: "/systems/bot", icon: "bot" },
      { label: "AI Gateway", href: "/systems/gateway", icon: "gateway" },
      { label: "MCP Hub", href: "/systems/hub", icon: "hub" },
      { label: "Automation", href: "/systems/automation", icon: "automation" },
    ] },
    // IT: read-only to everyone; write surfaces gate on canManageIT.
    { label: "IT", items: [
      { label: "Overview", href: "/it", icon: "pulse" },
      { label: "Devices", href: "/it/devices", icon: "inventory" },
      { label: "Topology", href: "/it/topology", icon: "hub" },
      { label: "Workflows", href: "/it/workflows", icon: "automation" },
    ] },
  ];
  if (can(me, "admin.access", tenantId)) {
    groups.push({ label: "Admin", items: [
      { label: "Users & Roles", href: "/admin/users", icon: "hr" },
      { label: "Identity Links", href: "/admin/identity", icon: "hub" },
      { label: "Modules & Fields", href: "/admin/modules", icon: "box" },
      { label: "Compliance Gates", href: "/admin/compliance", icon: "check" },
      { label: "Audit", href: "/admin/audit", icon: "clock" },
    ] });
  }
  return groups;
}
