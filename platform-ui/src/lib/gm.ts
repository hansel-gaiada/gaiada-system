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
// ── OQ-1 (narrowed department-head view) IS NOT IMPLEMENTED HERE, ON PURPOSE ──────────────────────
// The ratified answer is that a department head SHOULD get a narrowed console (their own
// department's row plus the company north stars). It is not built yet because the UI cannot
// currently identify a department lead: `Me` (`lib/platform.ts`) carries `userId/name/email/title/
// assurance/companies/roles` and nothing about positions or unit leadership, and `positions.is_lead`
// is display-and-backfill only on the backend (the P2-05 reconciler that would turn
// `position_roles` into real grants is NOT BUILT — see platform-nest `seed/positions.ts`).
// Guessing at lead identity here would ship a leak, so the narrowed tier is tracked as GM-02b with
// an explicit prerequisite: a lead/position signal on `/api/me` or a positions read. Until then a
// department head gets the same honest refusal a member does.
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

/** The one gate. Company-scoped on purpose: the console's subject is the ACTIVE company's business,
 *  so a `company_admin` of one tenant must not read another's cockpit by switching the URL. Callers
 *  pass the active tenant; `platform_admin`'s global grant satisfies `scopeCovers` either way. */
export function canReadGmConsole(me: Me, companyId?: string | null): boolean {
  return can(me, "reports.company.view", companyId);
}

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
