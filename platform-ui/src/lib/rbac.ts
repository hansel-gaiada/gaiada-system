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
  | "platform_admin"   // superadmin — everything, everywhere
  | "group_executive"  // owner — everything across the group's companies
  | "company_admin"    // admin within a company
  | "manager"          // runs work within a company
  | "member"           // baseline access
  | "it_admin" | "it_manager" | "it"; // IT operators

export type Capability =
  | "admin.access"       // /admin/* (users, identity, modules, compliance, audit)
  | "company.manage"     // company settings / module enablement
  | "org.edit"           // edit the org structure
  | "people.directory"   // browse the people directory
  | "rollups.view"       // cross-company rollups (global)
  | "pm.manage"          // create/assign/move tasks, confirm AI-tracker writes
  | "it.manage"          // register/edit devices
  | "approvals.decide"   // approve/reject
  | "knowledge.review";  // review/quarantine knowledge sources

// What each role grants (within its own scope). Order/duplication is harmless.
const ALL: Capability[] = [
  "admin.access", "company.manage", "org.edit", "people.directory",
  "rollups.view", "pm.manage", "it.manage", "approvals.decide", "knowledge.review",
];
export const ROLE_CAPS: Record<Role, Capability[]> = {
  platform_admin: ALL,
  group_executive: ALL,
  company_admin: ["admin.access", "company.manage", "org.edit", "people.directory", "pm.manage", "it.manage", "approvals.decide", "knowledge.review"],
  manager: ["pm.manage", "approvals.decide", "people.directory"],
  member: [],
  it_admin: ["it.manage", "company.manage"],
  it_manager: ["it.manage"],
  it: ["it.manage"],
};

type Grant = Me["roles"][number];

// Does a grant's scope cover the target company? A global grant covers
// everything. With no companyId (a cross-company question) only global counts.
// A company grant with a null scopeId is treated as covering any company in the
// user's set (defensive — the backend already limits the set). Team grants are
// treated as company-level for now (refine when team scoping lands).
function scopeCovers(g: Grant, companyId?: string | null): boolean {
  if (g.scopeType === "global") return true;
  if (companyId == null) return false;
  if (g.scopeType === "company") return g.scopeId == null || g.scopeId === companyId;
  if (g.scopeType === "team") return true;
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
  if (isElevated(me)) return me.companies;
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
