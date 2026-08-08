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
  | "search_staff" | "search_manager" // search-marketing (SEO/SEM/GEO) module derived roles (SM-03; same WSD-2 module_staff/module_manager linchpin as HR — string-composed from grants, resource.attr.module === "search"). Company-scoped; may be reconciler-materialized onto a SERVED company.
  // TR-25 — §8's fifth column (served-dept provider tier). Same WSD-2 module_staff/module_manager
  // linchpin, `resource.attr.module === "reports"`. Reconciler-materialized onto a SERVED company for
  // the members of a providing unit, and ONLY while the assignment is status='active'.
  // ⚠ These roles are NOT SEEDED in the platform yet (0026 seeds only the hr_* pair, and
  // `service-reconciler.ts` no-ops on an unseeded module role) — so this tier is currently inert in
  // production. Mirrored here so the UI is ready and the intent is recorded, not because it is live.
  | "reports_staff" | "reports_manager";

export type Capability =
  | "admin.access"       // /admin/* (users, identity, modules, compliance, audit)
  | "company.manage"     // company settings / module enablement
  | "org.edit"           // edit the org structure
  | "people.directory"   // browse the people directory
  | "rollups.view"       // cross-company rollups (global)
  | "pm.manage"          // create/delete tasks, CHANGE OWNERSHIP (Responsible), confirm tracker writes
  // Owner decision 2026-08-06: "anyone can pass the ball." Mirrors Cerbos's `pm_task:update`, which
  // resource_pm_task.yaml grants to member/viewer/team_lead/manager/company_admin — i.e. any member.
  // Passing the ball changes `assignee.refId` and leaves `assignee.responsibleId` alone; the server
  // diffs the two and only escalates to `manage` when OWNERSHIP actually changes. This capability
  // exists so the UI stops being stricter than the server: it previously gated the ball on
  // `pm.manage`, which silently made a hand-off leads-only.
  | "pm.contribute"      // pass the ball, execution edits (status/progress/dates) — any member
  | "it.manage"          // register/edit devices
  | "approvals.decide"   // approve/reject
  // D14-08 — retry a FAILED (or stuck-executing) automation write's execution (Cerbos action
  // `retry` on `automation_approval`). Deliberately NARROWER than `approvals.decide`: a plain
  // `manager` may decide but must not retry — retry re-attempts a write that already failed once,
  // which the backend restricts to superadmin/company_admin/group_executive (D14-07's grant).
  | "approvals.retry"
  | "knowledge.review"   // review/quarantine knowledge sources
  | "hr.view"            // read hr_cases/hr_records/leave/attendance for a company
  | "hr.manage"          // file/decide leave on others' behalf, edit cases/records/checklists, manage templates
  | "search.view"        // read search-marketing properties/engagements/keywords/audits/campaigns/reports/ledger for a company
  | "search.manage"      // create/edit properties/engagements/keywords/audits/campaign drafts+proposals/report drafts (draft-only working set — mirrors search_staff/search_manager's baseline Cerbos grant)
  | "search.scope.write" // set an engagement's tool-scope config + provider budget cap (D-11; Cerbos action `set_scope`, elevated-only)
  | "search.campaign.launch" // mark a manual-mode change proposal applied OR execute an api-mode one (Cerbos actions `launch`/`apply_manual`/`apply_negatives`/`set_budget`, elevated-only)
  | "search.report.approve"  // approve + deliver an engagement report (Cerbos actions `approve`/`deliver`, elevated-only)
  | "search.ledger.admin"    // override a provider budget stop-loss cap (Cerbos action `admin` on resource_search_ledger, elevated-only)
  // ─────────── TR-25: the tracker/reporting program (§8's matrix). Mirrors, never decides. ───────────
  // ⚠ READ THIS BEFORE USING ANY `reports.*` CAPABILITY FOR ANYTHING BUT RENDERING.
  // These capabilities answer "should the UI OFFER this?", never "may this user SEE this person?". The
  // person axis — WHICH people/units a dept lead reaches — is deliberately ABSENT from this file and
  // cannot be expressed here: it depends on `org_unit_memberships` + the org tree as of a date, which
  // the browser does not have and must never be trusted to evaluate. That boundary lives in
  // `platform-nest/src/modules/reports/person-scope.ts` and is enforced server-side on every read (403
  // — the UI renders a limited-access state). So `reports.person.view` means "this role reads person
  // documents AT ALL", not "this user reads THAT person". Gate a nav item on it; never a data decision.
  | "reports.person.view"      // person-grain report documents (Cerbos `read_person`) — SERVER narrows to the caller's line
  | "reports.project.view"     // project-grain (Cerbos `read_project`)
  | "reports.department.view"  // department-grain (Cerbos `read_department`) — SERVER narrows to the led unit subtree
  | "reports.company.view"     // company-grain (Cerbos `read_company`) — exec/company_admin ONLY; §8 excludes dept lead AND HR ("person data yes, company strategy no")
  | "reports.period.seal"      // seal / amend / pin a period (Cerbos `seal`/`amend`/`pin` on report_period) — exec/company_admin only; dept lead ⛔
  | "reports.facts.admin"      // rebuild the fact fabric (Cerbos `recompute` on report_admin) — exec/company_admin only; a lead who re-derives a window moves their own team's appraisal inputs
  | "reports.ops.poll"         // the n8n reminder/escalation reads (Cerbos `pending_reminders`/`missed_by_unit`) — company_admin ONLY, not a human console
  | "checkin.read"             // read others' check-in history + the compliance grid (Cerbos `read`) — SERVER narrows to the caller's line
  | "checkin.excuse"           // excuse a missed day (Cerbos `excuse`) — rewrites an appraisal-SAFE metric, so hr_manager not hr_staff
  | "appraisal.read"           // read appraisal packs beyond one's own (Cerbos `read`)
  | "appraisal.score"          // write/submit scores (Cerbos `write`/`submit`) — the ASSIGNED manager only; server narrows to manager_user_id
  | "appraisal.cycle.admin";   // cycle CRUD + generate + finalize (Cerbos `cycle_admin`/`finalize`) — hr_manager ONLY (TR-25 finding ②)

// What each role grants (within its own scope). Order/duplication is harmless.
const ALL: Capability[] = [
  "admin.access", "company.manage", "org.edit", "people.directory",
  "rollups.view", "pm.manage", "pm.contribute", "it.manage", "approvals.decide", "approvals.retry", "knowledge.review",
  "hr.view", "hr.manage",
  "search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin",
  "reports.person.view", "reports.project.view", "reports.department.view", "reports.company.view",
  "reports.period.seal", "reports.facts.admin", "reports.ops.poll",
  "checkin.read", "checkin.excuse",
  "appraisal.read", "appraisal.score", "appraisal.cycle.admin",
];

// TR-25 — the §8 tiers as capability bundles, so each role below reads as one line rather than a
// 12-item list, and a drift between two roles that should share a tier is visible.
//
// `group_executive` is in ALL above (owner tier, unrestricted). The three bundles here cover the
// columns §8 actually distinguishes:
//   REPORT_READS      — the per-grain document reads shared by dept-lead and BOTH HR tiers.
//   EXEC_ONLY_REPORTS — company grain + seal/amend + facts recompute. §8 excludes dept lead from all
//                       three; HR too. `company_admin` holds them as the tenant's own administrator.
//   HR_OPS            — the ACTING HR tier (hr_manager). See finding ② below.
const REPORT_READS: Capability[] = ["reports.person.view", "reports.project.view", "reports.department.view"];
const EXEC_ONLY_REPORTS: Capability[] = ["reports.company.view", "reports.period.seal", "reports.facts.admin"];
const HR_OPS: Capability[] = ["checkin.excuse", "appraisal.cycle.admin"];
export const ROLE_CAPS: Record<Role, Capability[]> = {
  platform_admin: ALL,
  group_executive: ALL,
  company_admin: [
    "admin.access", "company.manage", "org.edit", "people.directory", "pm.manage", "pm.contribute", "it.manage", "approvals.decide", "approvals.retry", "knowledge.review",
    "hr.view", "hr.manage",
    "search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin",
    // The tenant's own administrator holds the exec-only reporting tier within its company (§8's
    // company-grain / seal / recompute rows read "exec"; resource_report_period.yaml's header
    // establishes that §6.2's "lead" there means the COMPANY's lead, not a per-department manager).
    ...REPORT_READS, ...EXEC_ONLY_REPORTS, "reports.ops.poll", "checkin.read", "checkin.excuse", "appraisal.read",
  ],
  // §8's "Dept lead (own unit)" column. Reads person/project/department — NEVER company grain, NEVER
  // seal/amend, NEVER facts recompute, NEVER the n8n ops polls, NEVER cycle admin. May score the
  // appraisals they are ASSIGNED (the server narrows to `manager_user_id`; this only decides whether
  // the scoring UI renders at all).
  manager: [
    "pm.manage", "pm.contribute", "approvals.decide", "people.directory",
    ...REPORT_READS, "checkin.read", "checkin.excuse", "appraisal.read", "appraisal.score",
  ],
  // A plain member's own report, own check-in and own appraisal are NOT capabilities — they are
  // self-service, gated server-side by `ownerId`/`subjectUserId == principal.id` (§11 principle 2:
  // "nothing about you that you cannot read"). Adding a capability for them here would imply the UI
  // decides, and would have to be granted to everyone, which tells a gating check nothing.
  member: ["pm.contribute"],
  it_admin: ["it.manage", "company.manage"],
  it_manager: ["it.manage"],
  it: ["it.manage"],
  // ⚠ TR-25 finding ② — THE HR SPLIT, mirrored. `hr_staff` is the BASELINE read tier and `hr_manager`
  // the ACTING tier, exactly as this file already modelled `hr.view` vs `hr.manage`. TR-13's Cerbos
  // derived role had collapsed them (`hr_people_ops` == hr_staff OR hr_manager), which handed
  // appraisal cycle admin + finalize + every appraisal pack to HR rank-and-file — including, via the
  // service reconciler, on SERVED companies they do not work for. Cerbos is now split
  // (`hr_people_reader` vs `hr_people_ops`) and this mirror matches it: `hr_staff` reads person-grain
  // reports and check-in history (that IS `hr.view`-shaped work) but holds NO appraisal capability and
  // cannot excuse a missed day (which rewrites an appraisal-SAFE metric).
  hr_staff: ["hr.view", ...REPORT_READS, "checkin.read"],
  hr_manager: ["hr.view", "hr.manage", ...REPORT_READS, "checkin.read", "appraisal.read", ...HR_OPS],
  // search_staff = Cerbos module_staff (draft-only baseline: read/create/update, propose_change,
  // research/run — never launch/set_scope/approve/admin). search_manager = module_manager (adds
  // the elevated actions). Mirrors hr_staff/hr_manager's split exactly (SM-03).
  search_staff: ["search.view", "search.manage"],
  search_manager: ["search.view", "search.manage", "search.scope.write", "search.campaign.launch", "search.report.approve", "search.ledger.admin"],
  // §8's served-dept column: department + project grain ONLY. Deliberately NO `reports.person.view`
  // — §8's person-grain cell for this column ("only persons acting under the assignment, via the
  // provider view") is NOT enforceable, because no endpoint can bound a person read that way, so
  // granting it would expose ARBITRARY served-company persons. Cerbos denies it; this mirrors that.
  // Also no company grain, no appraisals, no check-ins, no seal, no recompute (§8: all ⛔).
  reports_staff: ["reports.department.view", "reports.project.view"],
  reports_manager: ["reports.department.view", "reports.project.view"],
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

/** Any staff grant at all — i.e. any role that is not `client`.
 *
 *  This is the correct companion to `isClient` for deciding "is this person EXTERNAL ONLY", and it
 *  replaces an `isElevated` check that was subtly wrong: `isElevated` is only global `platform_admin`
 *  / `group_executive`, so `isClient && !isElevated` classified a **manager or company_admin who is
 *  also a client contact** as an external client. `navFor` used that pair and handed such a person
 *  portal-only navigation, losing the entire staff surface. A PM added as a contact on their own
 *  client is an ordinary thing to do, so this was reachable, not theoretical.
 *
 *  Deliberately "has any non-client role" rather than a list of staff roles: a role added later is
 *  staff by default, which fails toward keeping someone's workspace rather than silently taking it. */
export function isStaff(me: Me): boolean {
  return me.roles.some((r) => r.role !== "client");
}

/** External client with no staff standing — the one case that gets the portal instead of the app. */
export function isClientOnly(me: Me): boolean {
  return isClient(me) && !isStaff(me);
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
