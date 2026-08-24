import type { Me } from "@/lib/platform";
import { can, isElevated, isClientOnly, canManageIT } from "@/lib/rbac";
import { PM_TERMS } from "@/lib/pmVocabulary";
import { deptSlug } from "@/lib/deptToolkits";
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
  //
  // GM-01/OQ-4: **GM sorts FIRST, not alphabetically among its own children.** `d-gm` is the root of
  // the department spine (platform-nest `seed/roster.ts`: `DEPT_PARENT["d-gm"] = null`, every other
  // department parents to it), so filing it between Creatives and SEO puts the parent inside the
  // list of its children. The row is otherwise unchanged — same href, same glyph, and deliberately
  // NOT capability-gated: these rows come from the active company's org structure, and hiding a
  // department from the tree to hide its console would lie about the org chart. The GM console gates
  // its own CONTENT (`lib/gm.ts`), so a non-exec who clicks here gets an explanation, not a 404.
  //
  // Ordering only — no new group. A pinned single-row group above Departments was the alternative
  // (OQ-4) and was not taken: it spends a rail glyph and a group header on one row that already has
  // a natural home.
  const isGmRow = (name: string) => deptSlug(name) === "gm";
  const orderedDepartments = [
    ...departments.filter((d) => isGmRow(d.name)),
    ...departments.filter((d) => !isGmRow(d.name)),
  ];
  // Finance has a bespoke console at /finance rather than the generic /departments/[id] shell —
  // it is an operating surface (aging, the close gate, integrity checks), not a department read.
  // `wallet` over `chart` for the same reason: this is where money is worked, not charted.
  //
  // ⚠ AND IT MUST NOT PRODUCE TWO ROWS. An estate's org structure frequently DOES contain a
  // department called Finance (nav.test.ts's own wide-estate fixture has one), so appending a
  // functional row unconditionally — the way HR and IT are appended — would render "Finance" twice:
  // once to /departments/<id> and once to /finance. Two identical labels pointing at different
  // screens is the kind of thing a user learns to distrust rather than report.
  //
  // So: if the org structure claims the name, that row is re-pointed at the console. Only when no
  // department claims it is a functional row appended. Exactly one Finance row either way, and it
  // always opens the real console.
  const isFinanceRow = (name: string) => deptSlug(name) === "finance";
  const orgHasFinance = orderedDepartments.some((d) => isFinanceRow(d.name));
  const deptItems: NavItem[] = [
    ...orderedDepartments.map((d) =>
      isFinanceRow(d.name)
        ? { label: d.name, href: "/finance", icon: "wallet" as IconName }
        : { label: d.name, href: `/departments/${d.id}`, icon: "hr" as IconName },
    ),
    { label: "HR", href: "/hr", icon: "hr" },
    { label: "IT", href: "/it", icon: "pulse" },
    ...(orgHasFinance ? [] : [{ label: "Finance", href: "/finance", icon: "wallet" as IconName }]),
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
      // Ungated, like every other Me row: mandatory training is an obligation the employee is
      // told to meet, so the one page that tells them what they owe can never be behind a grant.
      { label: "Learning", href: "/me/learning", icon: "learning" },
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
      // P2-11 / P2-12-FE. Both are listed for anyone who can browse the directory rather than gated on
      // a grant capability, because a DEPARTMENT HEAD's authority comes from holding a lead position —
      // it is not in `me.roles` as a capability this function can test, and the pages themselves render
      // the server's own refusal. Nav-gating on `admin.access` would hide the surface from exactly the
      // person the wave was built for.
      ...(can(me, "people.directory", tenantId) || isElevated(me)
        ? [
            { label: "Positions", href: "/organization/positions", icon: "sitemap" as const },
            { label: "Access", href: "/organization/access", icon: "user" as const },
          ]
        : []),
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
    // The LMS is its OWN module serving all eight departments, so it is a top-level group rather
    // than a row under Departments > HR — filing it there would have implied Creative's or SEO's
    // training depends on `hr` being served to them, which it does not.
    //
    // Catalogue is ungated on purpose (`member` holds `lms.catalogue.view`): training you cannot
    // see is a support ticket, not a security posture. Compliance is where the gate belongs — that
    // page reads other people's progress.
    { label: "Learning", icon: "learning", items: [
      { label: "Overview", href: "/learning", icon: "home" },
      { label: "Catalogue", href: "/learning/catalogue", icon: "box" },
      // L3: the HOD authoring surface. Gated on `lms.authoring` — a plain member has no draft to
      // write, and the page would open only to tell them so.
      ...(can(me, "lms.authoring", tenantId) ? [{ label: "Authoring", href: "/learning/authoring", icon: "projects" } as NavItem] : []),
      ...(can(me, "lms.progress.view", tenantId) ? [{ label: "Compliance", href: "/learning/compliance", icon: "check" } as NavItem] : []),
    ] },
    // ASST-07: owner-private end to end (no admin/company_admin/group_executive bypass — see
    // resource_assistant_thread.yaml), so this needs no `can()` gate: every signed-in staff user
    // gets their own thread history, nothing more, mirroring the backend's owner-only Cerbos rule.
    { label: "Intelligence", icon: "agents", items: [
      { label: "Assistant", href: "/assistant", icon: "assistant" },
      { label: "Knowledge", href: "/knowledge", icon: "box" },
      { label: "AI Agents", href: "/agents", icon: "agents" },
      // The Office is the SPATIAL view of the same principals `/agents` lists — one event spine,
      // two renderers (docs/superpowers/plans/2026-08-23-virtual-office-plan.md §1) — so it belongs
      // beside its operational twin, not in a group of its own. It shipped in 6ecc954 with no nav
      // entry at all and was reachable only by typing the URL, which is how a feature quietly does
      // not exist. Staff-only comes free from `(app)/layout.tsx`'s isClientOnly redirect.
      { label: "The Office", href: "/office", icon: "pulse" },
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

