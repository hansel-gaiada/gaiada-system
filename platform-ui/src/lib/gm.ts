// GM console — the gate and the shared vocabulary (GM-02).
// Design: `docs/blueprints/gm-console-foundation.md` §6.
//
// ── WHY THIS FILE EXISTS AT ALL ──────────────────────────────────────────────────────────────────
// The GM console is the FIRST department console whose Home is not safe to render for every member.
// Every other department Home shows that department's own projects; GM's Home shows company-grain
// figures across the whole business. Sidebar `Departments` rows are deliberately ungated (they come
// from the active company's org structure), so without a gate a junior who clicks "GM" reads the
// company's numbers. Every GM tab page therefore calls `canReadGmConsole` and renders
// `GmAccessDenied` on refusal.
//
// ── WHY `reports.company.view` AND NOT A NEW `gm.view` (NOR `rollups.view`) ──────────────────────
// The cockpit's Tier 1 IS a company-grain report read, so the gate is the capability that already
// names that exact §8 boundary: `reports.company.view` ("company-grain (Cerbos `read_company`) —
// exec/company_admin ONLY; §8 excludes dept lead AND HR"). Minting a `gm.view` with the same meaning
// would create a second source of truth for one boundary, and `lib/rbac.ts` is a MIRROR of Cerbos,
// never a second opinion — so the mirror must key on the same fact the server will.
//
// ⚠ The design doc's first draft said reuse `rollups.view` (it gates `/rollups` and, in `nav.ts`,
// the Company Report row). MEASURED against `ROLE_CAPS`, that is wrong: `rollups.view` appears in NO
// role bundle except `platform_admin`'s wholesale `ALL`, while `company_admin` — the tenant's own
// administrator, who holds the whole `EXEC_ONLY_REPORTS` tier — does not have it. Gating on it would
// have locked the one non-superadmin principal who is entitled to this data out of the console,
// while the backend happily served the same figures at `/reports/company`. That is the precise
// failure mode the standing ruling warns about: a UI-only gate hiding a page the server would serve
// reads as broken, not as forbidden.
//
// ── WHAT THIS GATE DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────────
// It does NOT hide the sidebar row. The row is derived from the org structure, and hiding a
// department from the tree in order to hide a console would lie about the org chart. Content is
// gated; the tree stays true.
//
// ── OQ-1 — THE NARROWED DEPARTMENT-HEAD VIEW (GM-02b) ────────────────────────────────────────────
// This was originally deferred as "blocked: the UI cannot identify a department lead" — `Me` carries
// no position or unit-leadership signal, and `positions.is_lead` is display-only server-side with the
// P2-05 reconciler unbuilt. **That framing was wrong, and the capability declarations say why.**
//
// The UI never needs to identify a lead. `reports.department.view`'s own comment in `CAPABILITIES`
// reads: "department-grain (Cerbos `read_department`) — **SERVER narrows to the led unit subtree**".
// So the correct implementation is to ask for department grain and let Cerbos decide which units come
// back — which is precisely the standing rule (Cerbos is the authority, this file is a mirror, never
// a second opinion). Identifying the lead in the browser would have been the second opinion.
//
// Hence three states, not two:
//   "full"     — holds `reports.company.view` (platform_admin, company_admin). Company tier + the
//                department tier.
//   "narrowed" — holds `reports.department.view` but NOT the company one (manager, hr_staff,
//                hr_manager, reports_staff/manager, org_unit_lead). **No company tier at all**, and
//                the department tier carries whatever the server chose to return.
//   "none"     — everyone else (member, viewer, search_staff, social_staff, it_*, agency_approver).
//
// Two locks on the narrowed tier, deliberately: the UI mirror (`reports.department.view`, which
// `member` and `viewer` do NOT hold) and the server's own subtree narrowing. Either alone would be
// enough for correctness; both together mean a mirror drift cannot become a data leak.
import { can } from "@/lib/rbac";
import { deptSlug } from "@/lib/deptToolkits";
import type { Me } from "@/lib/platform";

/** The toolkit slug. `deptSlug("GM") === "gm"` is pinned by `deptToolkits.test.ts`. */
export const GM_SLUG = "gm";

/** True when this department IS the GM department. Keyed on the NAME slug, not the id, so every
 *  company in the holding resolves its own GM node without a hardcoded `d-gm`. */
export function isGmDept(deptName: string): boolean {
  return deptSlug(deptName) === GM_SLUG;
}

/** How much of the GM console this principal may read. See the OQ-1 block above. */
export type GmAccess = "full" | "narrowed" | "none";

/** THE gate. Company-scoped on purpose: the console's subject is the ACTIVE company's business, so a
 *  `company_admin` of one tenant must not read another's cockpit by switching the URL. Callers pass
 *  the active tenant; `platform_admin`'s global grant satisfies `scopeCovers` either way.
 *
 *  Order matters: the company tier is checked FIRST, so a principal holding both capabilities gets
 *  "full" rather than being narrowed by the more specific-sounding check. */
export function gmAccessFor(me: Me, companyId?: string | null): GmAccess {
  if (can(me, "reports.company.view", companyId)) return "full";
  if (can(me, "reports.department.view", companyId)) return "narrowed";
  return "none";
}

/** May this principal read company money (GM-09)?
 *
 *  SEPARATE from `gmAccessFor`, deliberately. Finance is its own Cerbos boundary
 *  (`finance_statement:read`) and its own per-tenant module — a `company_admin` holds both, but a
 *  narrowed department lead holds the reporting one and NOT the finance one. Folding money into the
 *  console's access state would have handed every dept lead the company's P&L.
 *
 *  ⚠ This is a mirror of two of five real holders. `finance.statement.read` is held by
 *  `company_admin`, `finance_manager`, `finance_staff`, `owner` and `platform_admin`, but the last
 *  three have no member in this file's `Role` union at all, so they resolve to zero capabilities
 *  here — an estate-wide gap affecting the whole `/finance` console, reported rather than widened
 *  inside a GM ticket. The server still authorizes correctly for them; only this mirror is short,
 *  and the card degrades to its honest refusal state rather than to a wrong number. */
export function canReadGmMoney(me: Me, companyId?: string | null): boolean {
  return can(me, "finance.statement.view", companyId);
}

/** Convenience for the many call sites that only need "may they open the console at all". */
export function canReadGmConsole(me: Me, companyId?: string | null): boolean {
  return gmAccessFor(me, companyId) !== "none";
}

/** Refusal text for a tab that is company-grain by nature and therefore has nothing to show a
 *  narrowed principal. Distinct from `GM_DENIED_REASON`: this reader HAS the console, just not this
 *  tab, and telling them "limited to group executives" would imply they should not be here at all. */
export const GM_COMPANY_ONLY_REASON =
  "This view reports on the company as a whole, which is limited to group executives. The rest of the GM console is scoped to the departments you lead.";

/** Banner text for the narrowed console — stated, never implied. A department-scoped figure that
 *  looks like a company figure is the whole failure mode this console is built to avoid. */
export const GM_NARROWED_NOTICE =
  "Scoped to the departments you lead. Company-wide figures are limited to group executives, so they are absent here rather than partial.";

/** The refusal text. Names the actual boundary rather than saying "no access" — same rule the
 *  reports grain pages follow with `ReportAccessDenied`. */
export const GM_DENIED_REASON =
  "The GM console reads company-grain figures across every department, so it is limited to group executives.";

/** Period kinds the GM console offers. Deliberately NOT the full `ReportPeriodKind` union: `day` is
 *  too short to review a business on and `custom` needs a range picker this console does not have
 *  yet (the Business Review inherits the real `PeriodSelector` when GM-05 lands). */
export const GM_PERIOD_KINDS = ["week", "month"] as const;
export type GmPeriodKind = (typeof GM_PERIOD_KINDS)[number];

/** OQ-2, ratified: **week**. The operating-cadence literature this console is modelled on treats
 *  the weekly review as the primary rhythm (foundation doc §9), and a GM who opens the cockpit daily
 *  wants the current week, not a month that is 3% elapsed. */
export const GM_DEFAULT_PERIOD: GmPeriodKind = "week";

export function parseGmPeriodKind(raw: string | undefined): GmPeriodKind {
  return (GM_PERIOD_KINDS as readonly string[]).includes(raw ?? "") ? (raw as GmPeriodKind) : GM_DEFAULT_PERIOD;
}

/** How many company-grain KPIs the cockpit's Tier-1 strip shows.
 *
 *  Six, because working memory holds 5–9 elements and dashboard engagement collapses past roughly a
 *  dozen KPIs (foundation doc §9). The cap is applied to whatever the backend's metric registry
 *  actually returns — the cockpit never hardcodes metric keys, so it cannot drift from the registry.
 *  Anything past the cap is not hidden, it is one click away in the Business Review, and the strip
 *  says so rather than silently truncating. */
export const GM_TIER1_LIMIT = 6;
