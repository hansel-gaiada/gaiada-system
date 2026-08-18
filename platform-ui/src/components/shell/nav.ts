import type { Me } from "@/lib/platform";
import { can, isElevated, isClientOnly, canManageIT } from "@/lib/rbac";
import { PM_TERMS } from "@/lib/pmVocabulary";
import type { IconName } from "./icons";

// Access helpers live in lib/rbac (the RBAC source of truth); re-exported here
// because existing call sites import them from the nav module.
export { isElevated, canManageIT } from "@/lib/rbac";

export interface NavItem { label: string; href: string; icon: IconName }
/** `icon` is the collapsed rail's category glyph; `pinned` keeps a group's rows one
 *  click away — open by default when expanded, flat (never a flyout) in the rail. */
export interface NavGroup { label: string; items: NavItem[]; icon?: IconName; pinned?: boolean }

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
    // CP-7: the portal is now its OWN route group with its own shell, so an external client never
    // renders this nav at all — `(portal)/portal/layout.tsx` replaces `(app)/layout.tsx` for every
    // `/portal/*` path. This entry is kept as the belt to that braces: if a client ever lands on an
    // `(app)` route (a stale bookmark, a notification href pointing at a staff page), the staff shell
    // draws around them and this is the one link out. Removing it would leave them with an empty
    // sidebar and no way back.
    return [{ label: "Portal", items: [{ label: "Your portal", href: "/portal", icon: "home" }] }];
  }
  // 2026-08-10 owner directive: Business collapses Projects+Tasks into ONE entry
  // (PM_TERMS.projectManagement) — those two are the PM-domain items, now tabs on
  // `/project-management` alongside Overview/Ball/Timeline/Charts/Productivity (see that page's
  // own header). Clients/Deliverables/Timesheets/Billing/Agency/Meetings/Delivery Pipeline/Rollups
  // stay siblings — folding those in too would make one page mean everything, defeating the point.
  const business: NavItem[] = [
    { label: PM_TERMS.projectManagement, href: "/project-management", icon: "projects" },
    { label: "Clients", href: "/clients", icon: "finance" },
    { label: "Deliverables", href: "/deliverables", icon: "box" },
    { label: "Timesheets", href: "/timesheets", icon: "clock" },
    ...(can(me, "company.manage", tenantId) ? [{ label: "Billing", href: "/billing", icon: "wallet" } as NavItem] : []),
    { label: "Agency", href: "/agency", icon: "sales" },
    { label: "Meetings", href: "/meetings", icon: "clock" },
    { label: "Delivery Pipeline", href: "/pipeline", icon: "pulse" },
    // Monitoring is Plane B — the CLIENT's properties and services, not our own containers
    // (that is Plane A and lives in Grafana, deliberately off the ERP surface). It sits in
    // Business rather than Systems for exactly that reason: the subject is client work.
    // Ungated for now, matching the Clients/Deliverables precedent — the backend's Cerbos
    // `monitoring.read` is the real boundary and this row is only a mirror.
    { label: "Monitoring", href: "/monitoring", icon: "pulse" },
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
    // "Me" is FIRST and ungated (employee-portal wave A). Every principal with a staff surface has a
    // personal hub — there is no capability to hold, and gating it would be gating someone out of
    // their own leave, loans and inbox. It sits above Workspace because "my things" is what an
    // employee opens the ERP for; Workspace is the shared surface.
    //
    // Deliberately SHORT: Leave and Loans are the two surfaces that existed nowhere else, Inbox is
    // the personal read of the notification feed, and /me itself re-homes the seven self-service
    // pages that already live under Business/Reports/Appraisals. Repeating those seven here would
    // duplicate nav entries rather than give them a home.
    //
    // In the collapsed rail it is a flyout category (`user` glyph), not pinned: pinning both Me and
    // Workspace would put 7 flat rows above the 7 category glyphs and undo the rail's point. Flip
    // `pinned: true` here if the personal rows should out-rank that.
    { label: "Me", icon: "user", items: [
      { label: "Overview", href: "/me", icon: "home" },
      { label: "Inbox", href: "/me/inbox", icon: "check" },
      { label: "Leave", href: "/me/leave", icon: "clock" },
      { label: "Loans", href: "/me/loans", icon: "wallet" },
    ] },
    // Daily destinations: always reachable in one click, in either mode.
    { label: "Workspace", pinned: true, items: [
      { label: "Dashboard", href: "/", icon: "home" },
      // P4-A5: the cross-project (`@all`) PM surface — plan decision 1 makes this the new PM home
      // (`/` stays the personal My Work landing). Ungated, same precedent as Business's own
      // Project Management row below (no `pm.view` capability exists — the server/Cerbos side is
      // the authority on what a caller's tasks actually contain; this is a place to look, not a
      // grant). Label 2026-08-10: "PM" read as the exact abbreviation the owner asked to stop —
      // see PM_RENAMES in pmVocabulary.ts. Same string as Business's row and every department
      // console's Work group, so the surface reads identically everywhere it appears; only the
      // scope differs (this one keeps its `ScopeSwitcher`, Business's is fixed to `@all`).
      { label: PM_TERMS.projectManagement, href: "/pm", icon: "projects" },
      { label: "Calendar", href: "/calendar", icon: "clock" },
      { label: "Approvals", href: "/approvals", icon: "check" },
    ] },
    // Companies now live inside the Organization Overview.
    { label: "Organization", icon: "sitemap", items: [
      { label: "Overview", href: "/organization", icon: "inventory" },
    ] },
    { label: "Departments", icon: "hr", items: deptItems },
    { label: "Business", icon: "briefcase", items: business },
    // TR-17: the tracker/reporting program's grain report pages. Person/project/department are
    // always listed (§8 lets everyone read at least their own person-grain document; the BFF is
    // the real authority for project/department scoping) — Company is nav-gated by `rollups.view`
    // the same way the existing Rollups link is, since §8 makes company-grain exec-only.
    { label: "Reports", icon: "chart", items: [
      { label: "My Report", href: "/reports/person", icon: "pulse" },
      { label: "Project Reports", href: "/reports/project", icon: "pulse" },
      { label: "Department Reports", href: "/reports/department", icon: "pulse" },
      ...(can(me, "rollups.view") ? [{ label: "Company Report", href: "/reports/company", icon: "pulse" } as NavItem] : []),
    ] },
    // TR-26: `/appraisals/mine` is self-service (every principal reads their own record, always —
    // same reasoning as check-ins, no capability gates it). The other two rows are capability-gated
    // per the TR-25 rbac.ts mirror: manager/HR scoring console, then HR-only cycle administration.
    { label: "Appraisals", icon: "award", items: [
      { label: "My Appraisals", href: "/appraisals/mine", icon: "check" },
      ...(can(me, "appraisal.score", tenantId) || can(me, "appraisal.read", tenantId) ? [{ label: "Team Appraisals", href: "/appraisals", icon: "check" } as NavItem] : []),
      ...(can(me, "appraisal.cycle.admin", tenantId) ? [{ label: "Appraisal Cycles", href: "/appraisals/cycles", icon: "check" } as NavItem] : []),
    ] },
    // ASST-07: owner-private end to end (no admin/company_admin/group_executive bypass — see
    // resource_assistant_thread.yaml), so this needs no `can()` gate: every signed-in staff user
    // gets their own thread history, nothing more, mirroring the backend's owner-only Cerbos rule.
    { label: "Intelligence", icon: "agents", items: [
      { label: "Assistant", href: "/assistant", icon: "assistant" },
      { label: "Knowledge", href: "/knowledge", icon: "box" },
      { label: "AI Agents", href: "/agents", icon: "agents" },
    ] },
    { label: "Systems", icon: "server", items: [
      { label: "WA/TG Bot", href: "/systems/bot", icon: "bot" },
      { label: "AI Gateway", href: "/systems/gateway", icon: "gateway" },
      { label: "MCP Hub", href: "/systems/hub", icon: "hub" },
      { label: "Automation", href: "/systems/automation", icon: "automation" },
      // MON-09i. Plane A (this box) belongs in Systems, which is where OUR infrastructure
      // consoles live -- as opposed to Business > Monitoring, which is the CLIENT's sites.
      // Until now Plane A had no ERP surface at all: server metrics were collected for weeks
      // and readable only by SSH-tunnelling to Prometheus, which is how a completely broken
      // datastore exporter stayed invisible. The backend gates on platform-admin; this row is
      // ungated like its siblings, and a non-admin gets an explicit "restricted" page rather
      // than a missing row -- a hidden row reads as "gone", a refusal reads as "not yours".
      { label: "Observability", href: "/systems/observability", icon: "pulse" },
    ] },
  ];
  // Settings (formerly "Admin") — a single sidebar entry; its sub-sections
  // (users/identity/modules/compliance/audit) are in-page tabs on the page itself.
  if (can(me, "admin.access", tenantId)) {
    groups.push({ label: "", items: [{ label: "Settings", href: "/admin", icon: "settings" }] });
  }
  return groups;
}
