// Role-Based Access Control — the single source of truth for "who can do what,
// where". Pure (no server-only APIs) so it's importable from server components,
// server actions, and tests alike. The BACKEND (Cerbos/RLS) remains the real
// authority; this enforces the same model in the UI so nav, the company
// switcher, and write actions all gate consistently and fail closed.
//
// Model: a user has role GRANTS, each scoped global | company | team. A grant
// confers a set of CAPABILITIES within its scope. `can()` answers a capability
// question, optionally against a specific company. Cross-company capabilities
// (rollups, admin-wide) are asked with no companyId and require a GLOBAL grant.
import type { Me } from "./platform";

export type Role =
  | "platform_admin"   // superadmin — everything, everywhere (unrestricted)
  | "group_executive"  // owner — everything across the group's companies (unrestricted)
  | "company_admin"    // admin within a company
  | "manager"          // runs work within a company
  | "member"           // baseline access
  | "it_admin" | "it_manager" | "it"  // IT operators
  | "hr_staff" | "hr_manager" // HR module derived roles (WSD-2 module_staff/module_manager, string-composed from grants — see hr module design §2.1). Company-scoped; may be reconciler-materialized onto a SERVED company (Me.serviceScopes) when the grant rides a service assignment.
  | "search_staff" | "search_manager"; // search-marketing (SEO/SEM/GEO) module derived roles (SM-03; same WSD-2 module_staff/module_manager linchpin as HR — string-composed from grants, resource.attr.module === "search"). Company-scoped; may be reconciler-materialized onto a SERVED company.

export type Capability =
  | "admin.access"       // /admin/* (users, identity, modules, compliance, audit)
  | "company.manage"     // company settings / module enablement
  | "org.edit"           // edit the org structure
  | "people.directory"   // browse the people directory
  | "rollups.view"       // cross-company rollups (global)
  | "pm.manage"          // create/assign/move tasks, confirm AI-tracker writes
  | "it.manage"          // register/edit devices
  | "approvals.decide"   // approve/reject
  | "knowledge.review"   // review/quarantine knowledge sources
  | "hr.view"            // read hr_cases/hr_records/leave/attendance for a company
  | "hr.manage"          // file/decide leave on others' behalf, edit cases/records/checklists, manage templates
  | "search.view"        // read search-marketing properties/engagements/keywords/audits/campaigns/reports/ledger for a company
  | "search.manage"      // create/edit properties/engagements/keywords/audits/campaign drafts+proposals/report drafts (draft-only working set — mirrors search_staff/search_manager's baseline Cerbos grant)
  | "search.scope.write" // set an engagement's tool-scope config + provider budget cap (D-11; Cerbos action `set_scope`, elevated-only)
  | "search.campaign.launch" // mark a manual-mode change proposal applied OR execute an api-mode one (Cerbos actions `launch`/`apply_manual`/`apply_negatives`/`set_budget`, elevated-only)
  | "search.report.approve"  // approve + deliver an engagement report (Cerbos actions `approve`/`deliver`, elevated-only)
  | "search.ledger.admin";   // override a provider budget stop-loss cap (Cerbos action `admin` on resource_search_ledger, elevated-only)

// What each role grants (within its own scope). Order/duplication is harmless.
const ALL: Capability[] = [
  "admin.access", "company.manage", "org.edit", "people.directory",
  "rollups.view", "pm.manage", "it.manage", "approvals.decide", "knowledge.review",
  "hr.view", "hr.manage",
  "search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin",
];
export const ROLE_CAPS: Record<Role, Capability[]> = {
  platform_admin: ALL,
  group_executive: ALL,
  company_admin: [
    "admin.access", "company.manage", "org.edit", "people.directory", "pm.manage", "it.manage", "approvals.decide", "knowledge.review",
    "hr.view", "hr.manage",
    "search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin",
  ],
  manager: ["pm.manage", "approvals.decide", "people.directory"],
  member: [],
  it_admin: ["it.manage", "company.manage"],
  it_manager: ["it.manage"],
  it: ["it.manage"],
  hr_staff: ["hr.view"],
  hr_manager: ["hr.view", "hr.manage"],
  // search_staff = Cerbos module_staff (draft-only baseline: read/create/update, propose_change,
  // research/run — never launch/set_scope/approve/admin). search_manager = module_manager (adds
  // the elevated actions). Mirrors hr_staff/hr_manager's split exactly (SM-03).
  search_staff: ["search.view", "search.manage"],
  search_manager: ["search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin"],
};

type Grant = Me["roles"][number];

// Does a grant's scope cover the target company? A global grant covers
// everything. With no companyId (a cross-company question) only global counts.
// A company grant must match the granted company EXACTLY — a null/absent
// scopeId is NOT a wildcard for "any company" (that over-grants; A4). A team
// grant is scoped to its unit, not the whole company: `can()` only reasons
// about companyId, so a team grant can never resolve "yes, this company" from
// here — it must not blanket-cover company-wide capabilities (A4). Unit-level
// checks belong to a caller that actually has the unit id.
function scopeCovers(g: Grant, companyId?: string | null): boolean {
  if (g.scopeType === "global") return true;
  if (companyId == null) return false;
  if (g.scopeType === "company") return g.scopeId != null && g.scopeId === companyId;
  return false;
}

export function can(me: Me, cap: Capability, companyId?: string | null): boolean {
  return me.roles.some((g) => {
    const caps = ROLE_CAPS[g.role as Role];
    return !!caps && caps.includes(cap) && scopeCovers(g, companyId);
  });
}

// "Elevated" = a global superadmin/owner grant. Kept as a named concept because
// several surfaces (People directory, org editing default) key off it.
const ELEVATED = new Set<Role>(["platform_admin", "group_executive"]);
export function isElevated(me: Me): boolean {
  return me.roles.some((r) => ELEVATED.has(r.role as Role) && r.scopeType === "global");
}

// Access tiers requested by the org:
// • UNRESTRICTED — owner (group_executive) + superadmin (platform_admin): may do anything, anywhere.
// • VIEW-ALL — same set as UNRESTRICTED today. There used to be a second,
//   narrower "view every company but not unrestricted" tier (`holding_head`,
//   people.directory + rollups.view only) — removed per the backbone-program
//   plan's A4 amendment: ORG-7/ORG-12's `serviceScopes` (a real, module-scoped,
//   consent-based grant materialized by the reconciler) supersedes the old
//   blanket "view everything" role. Cross-company oversight now happens
//   through an actual service assignment (Me.serviceScopes) or a normal
//   company/global grant — never a free-floating "can see all" role.
export function isUnrestricted(me: Me): boolean {
  return isElevated(me);
}
export function canViewAllCompanies(me: Me): boolean {
  return isUnrestricted(me);
}

// WS11: an external client (client-portal user). Gated by a `client` grant; drives portal-only nav.
// The real boundary is the portal BFF (client role + run ownership); this is nav/visibility.
export function isClient(me: Me): boolean {
  return me.roles.some((r) => r.role === "client");
}

// Can this user manage IT? Against a specific company when given; otherwise
// "anywhere" (used for nav visibility before a company is fixed).
export function canManageIT(me: Me, companyId?: string | null): boolean {
  if (companyId != null) return can(me, "it.manage", companyId);
  return me.roles.some((g) => ROLE_CAPS[g.role as Role]?.includes("it.manage"));
}

// The companies a user may switch between. The backend already returns only the
// companies the user can access in `me.companies`; a global (elevated) role can
// reach all of them, a company-scoped user reaches the ones they're granted in.
export function accessibleCompanies(me: Me): { id: string; name: string; type: string | null }[] {
  // Unrestricted (owner/superadmin) AND view-all (holding head-of-department)
  // reach every company under the holding — the switcher lists them all.
  if (canViewAllCompanies(me)) return me.companies;
  const scoped = new Set(
    me.roles.filter((g) => g.scopeType === "company" && g.scopeId).map((g) => g.scopeId as string),
  );
  // If the user has any company-scoped grants, prefer that set; else fall back
  // to full membership (e.g. plain members who belong to one company).
  const filtered = me.companies.filter((c) => scoped.has(c.id));
  return filtered.length > 0 ? filtered : me.companies;
}

// True when the switcher should offer a choice (vs. a static label).
export function canSwitchCompany(me: Me): boolean {
  return accessibleCompanies(me).length > 1;
}

// UX-2 §1.3 — Command Center (manager-tier) vs Queue+Agenda hybrid (everyone
// else). Keyed on role, not capability, so it's a simple lookup independent
// of scope/company. Deliberately does NOT include `holding_head` (D-UX-4 /
// the backbone A4 amendment already dropped that role from rbac.ts entirely —
// see `isUnrestricted`'s comment above; ORG-7/ORG-12 `serviceScopes` replaced
// it, and a served-company grant doesn't by itself imply manager-tier framing).
const MANAGER_TIER = new Set<Role>([
  "platform_admin", "group_executive", "company_admin", "manager", "it_admin", "it_manager",
]);

// "Any grant qualifies," not "every grant qualifies" — a user holding a
// manager-tier grant in one company and a plain `member`/`it`/`hr_*` grant in
// another still gets Command Center (UX-2 §1.3, explicit tie-break).
export function isManagerTier(me: Me): boolean {
  return me.roles.some((r) => MANAGER_TIER.has(r.role as Role));
}
