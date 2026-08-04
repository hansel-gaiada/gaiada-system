import type { Me } from "@/lib/platform";
import { can, isElevated, isClientOnly, canManageIT } from "@/lib/rbac";
import type { IconName } from "./icons";

// Access helpers live in lib/rbac (the RBAC source of truth); re-exported here
// because existing call sites import them from the nav module.
export { isElevated, canManageIT } from "@/lib/rbac";

export interface NavItem { label: string; href: string; icon: IconName }
export interface NavGroup { label: string; items: NavItem[] }

// Nav is capability-gated against the ACTIVE company (tenantId). Company-scoped
// capabilities (people.directory, admin.access) resolve for that company;
// cross-company ones (rollups.view) require a global grant.
//
// `departments` (id+name for the active company) are threaded in so the
// Organization → Departments item becomes an expandable disclosure, one child
// per department linking straight into that department's console/interface.
export function navFor(me: Me, tenantId?: string | null, departments: { id: string; name: string }[] = []): NavGroup[] {
  // WS11: an external client (not also staff) gets a clean portal-only nav — never the staff surface.
  // `isClientOnly`, not `isClient && !isElevated`: the latter is true for a MANAGER or company_admin
  // who is also a client contact (isElevated covers only global admin/exec), and handed that person
  // portal-only nav — losing their whole staff surface. See rbac.ts::isStaff.
  if (isClientOnly(me)) {
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
    { label: "Meetings", href: "/meetings", icon: "clock" },
    { label: "Delivery Pipeline", href: "/pipeline", icon: "pulse" },
    ...(can(me, "rollups.view") ? [{ label: "Rollups", href: "/rollups", icon: "pulse" } as NavItem] : []),
  ];
  // Departments is its own section (rendered exactly like Organization — a group
  // header with a flat list of rows): the business departments (from the org
  // structure) plus the always-present functional departments HR and IT. Each
  // row opens that department's console.
  const deptItems: NavItem[] = [
    ...departments.map((d) => ({ label: d.name, href: `/departments/${d.id}`, icon: "hr" as IconName })),
    { label: "HR", href: "/hr", icon: "hr" },
    { label: "IT", href: "/it", icon: "pulse" },
  ];
  const groups: NavGroup[] = [
    { label: "Workspace", items: [
      { label: "Dashboard", href: "/", icon: "home" },
      { label: "Calendar", href: "/calendar", icon: "clock" },
      { label: "Approvals", href: "/approvals", icon: "check" },
    ] },
    // Companies now live inside the Organization Overview.
    { label: "Organization", items: [
      { label: "Overview", href: "/organization", icon: "inventory" },
    ] },
    { label: "Departments", items: deptItems },
    { label: "Business", items: business },
    // TR-17: the tracker/reporting program's grain report pages. Person/project/department are
    // always listed (§8 lets everyone read at least their own person-grain document; the BFF is
    // the real authority for project/department scoping) — Company is nav-gated by `rollups.view`
    // the same way the existing Rollups link is, since §8 makes company-grain exec-only.
    { label: "Reports", items: [
      { label: "My Report", href: "/reports/person", icon: "pulse" },
      { label: "Project Reports", href: "/reports/project", icon: "pulse" },
      { label: "Department Reports", href: "/reports/department", icon: "pulse" },
      ...(can(me, "rollups.view") ? [{ label: "Company Report", href: "/reports/company", icon: "pulse" } as NavItem] : []),
    ] },
    // TR-26: `/appraisals/mine` is self-service (every principal reads their own record, always —
    // same reasoning as check-ins, no capability gates it). The other two rows are capability-gated
    // per the TR-25 rbac.ts mirror: manager/HR scoring console, then HR-only cycle administration.
    { label: "Appraisals", items: [
      { label: "My Appraisals", href: "/appraisals/mine", icon: "check" },
      ...(can(me, "appraisal.score", tenantId) || can(me, "appraisal.read", tenantId) ? [{ label: "Team Appraisals", href: "/appraisals", icon: "check" } as NavItem] : []),
      ...(can(me, "appraisal.cycle.admin", tenantId) ? [{ label: "Appraisal Cycles", href: "/appraisals/cycles", icon: "check" } as NavItem] : []),
    ] },
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
  ];
  // Settings (formerly "Admin") — a single sidebar entry; its sub-sections
  // (users/identity/modules/compliance/audit) are in-page tabs on the page itself.
  if (can(me, "admin.access", tenantId)) {
    groups.push({ label: "", items: [{ label: "Settings", href: "/admin", icon: "settings" }] });
  }
  return groups;
}
