// TR-25 — THE person-axis authorization boundary for the whole tracker/reporting program.
//
// ══════════════════════════ WHY THIS FILE EXISTS (the §15 ① decision) ══════════════════════════
// §15 recorded that the "unit scope" question had been settled by accident three times — TR-09
// narrowed check-ins in-app with a bespoke `WHERE`, TR-13 left report documents BROADER than §8's
// literal text, and TR-22 needed a unit's leads and had no way to ask. TR-25's brief demanded a
// deliberate choice between:
//   (a) accept in-app narrowing as THE pattern — but then make it a first-class, uniformly-applied,
//       uniformly-tested boundary rather than an ad-hoc clause per controller; or
//   (b) introduce a real unit-scoped derived role / grant scope so Cerbos alone decides.
//
// ─────────────────── DECISION: (a). Two substrate facts make (b) unavailable, and one
// ─────────────────── deeper fact makes it undesirable even if the substrate allowed it.
//
//  1. A unit-scoped GRANT IS NOT REPRESENTABLE TODAY. `user_roles.scope_type` already admits
//     `'team'` (0001_core.sql:59) and `derived_roles.yaml`'s `team_lead` already matches
//     `resource.attr.teamId` — so at first glance (b) looks free. It is not: `user_roles.scope_id`
//     is **`uuid`**, while an org-unit node id is FREE-FORM TEXT (0055's header: "`unit_node_id` is
//     a free-form org-node id (0029 convention: org-node ids are not a database table)" — real
//     values are `'d-hr'`, `'d-seo'`, `'dv-web'`). A `{scope_type:'team', scope_id:'d-hr'}` grant
//     therefore cannot be stored. (b) requires DDL — widening `scope_id` on the core RBAC table
//     that every policy in the estate reads, or adding a parallel unit-grant table. The brief
//     rules that a grant-scope change "deserves a decision rather than a surprise", so it is
//     REPORTED, not improvised.
//
//  2. EVEN WITH THAT GRANT, CERBOS COULD NOT DECIDE ALONE. The question on the person axis is "is
//     *this subject* in a unit the caller leads, **as of date D**". The subject→unit mapping lives
//     in `org_unit_memberships` (validity-interval rows) and the unit→subtree mapping in
//     `company_org_structure.structure` (a JSONB tree). Cerbos evaluates attributes handed to it;
//     it cannot read either. So the application would still have to DERIVE "subject's unit as of D"
//     and "the caller's led subtree" and pass them in. (b) moves the *comparison* into Cerbos while
//     leaving the *derivation* — the part that can actually be wrong, and the part TR-37 proved
//     wrong once already — in the app. That is ceremony, not authority.
//
// So in-app narrowing is not a deviation to be apologized for on this axis; it is the only place
// the decision can be made correctly. What WAS wrong is that it was ad-hoc: three controllers, two
// divergent tier-detection helpers, one surface (report documents) with NO narrowing at all. This
// file is the fix — ONE implementation, imported by every person-axis read, tested as a first-class
// boundary. §8 has been rewritten to describe this rather than to claim a Cerbos-only boundary the
// codebase does not have.
//
// ══════════════════════════ THE THREE WALLS, AND WHICH ONE THIS IS ══════════════════════════
//   1. RLS bounds the TENANT       — `withTenants([tenantId], …)` + FORCE RLS (D5).
//   2. The third wall bounds the MODULE — `{modules:['reports','pm','hr']}`; a handler that forgot
//      a scope reads ZERO report_* rows rather than leaking.
//   3. Cerbos bounds the TIER      — which grants may attempt which action on which grain.
//   4. ← THIS FILE bounds the PERSON AXIS within the tier Cerbos left coarse.
// Walls 1–3 are unchanged and remain authoritative for everything they cover. This file is strictly
// SUBTRACTIVE: it can only ever deny a request Cerbos already allowed. It never grants anything.
//
// ══════════════════════════ THE BUG THIS CLOSES ══════════════════════════
// Before TR-25, `reports.controller.ts`'s `authorizeReportDocumentRead` applied NO narrowing, so
// any principal holding a bare company-scoped `manager` grant could read the full person-grain
// report document — every KPI, every band input — of EVERY employee in the tenant. §8 says "own
// unit's members". §11 principle 3 says "never peers, never other departments". That gap shipped in
// TR-13 and was live until this ticket.
import { ForbiddenException } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { Principal } from "../../rbac/principal";

/** The module scopes every person-axis read declares (identical to `CHECKIN_MODULES` /
 *  `REPORT_JOB_MODULES` — `reports` for the report_* third wall, `hr` for the leave/attendance
 *  guard, `pm` for forward-compat visibility). */
export const PERSON_SCOPE_MODULES = ["reports", "pm", "hr"];

/** The one 403 message every person-axis denial uses. §8 hard rule 2: an unauthorized read is
 *  **403, never 404** — the UI renders a limited-access state, and a 404 would additionally leak
 *  "this id does not exist" vs "you may not see it" as distinguishable outcomes. */
export const OUT_OF_LINE_MESSAGE = "outside your reporting line";

// ═══════════════════════════════ TIER RESOLUTION (one implementation) ═══════════════════════════

/**
 * How far the caller's grants reach on the PERSON axis, within one tenant.
 *
 * Replaces THREE divergent hand-rolled helpers that this ticket consolidated:
 * `checkins.controller.ts`'s `isManagerTierOnly`, and `appraisals.controller.ts`'s
 * `hasBroadAppraisalReadTier` + `isManagerCoarseOnly`. They disagreed: the check-in one counted
 * `hr_staff` as broad but ignored the (then-live, since HIER-3-retired) `team_lead`; the appraisal
 * one counted `team_lead` but not `company_admin`. Two spellings of one boundary is exactly how an
 * over-broad read ships unnoticed.
 *
 * - `unrestricted` — `platform_admin`. Holds an unconditional Cerbos wildcard everywhere else in
 *   this codebase; narrowing it here would be inconsistent with the rest of the estate.
 * - `company_wide` — §8's "Exec group" + "HR-appraisal role" columns, plus the tenant's own
 *   `company_admin`, plus a reconciler-materialized served-company module grant. Legitimately reads
 *   every person in the tenant, so nothing to narrow.
 * - `unit_scoped` — §8's "Dept lead (own unit)" column: a `manager` grant (COMPANY-scoped) or an
 *   `org_unit_lead` grant (org-unit-scoped, HIER-2's subtree cascade) and nothing broader; this
 *   file narrows either to the caller's own led unit subtree.
 * - `self_only` — a plain `member` (or no relevant grant). Cerbos's own self-rules
 *   (`owns` / `subjectUserId == principal.id`) already bound these; reaching a narrowing check at
 *   all means the request was for someone else, which is denied.
 */
export type PersonAxisTier = "unrestricted" | "company_wide" | "unit_scoped" | "self_only";

/** Grant-name sets, kept as data so the mirror in `platform-ui/src/lib/rbac.ts` and the parity
 *  matrix test can be read against ONE list rather than a chain of `||`s. */
const UNRESTRICTED_ROLES = new Set(["platform_admin"]);
const COMPANY_WIDE_ROLES = new Set([
  "group_executive",
  "company_admin",
  // §8's "HR-appraisal role" column. BOTH HR tiers read person-grain reports company-wide (that is
  // `hr.view`-shaped); they diverge only on APPRAISAL and on check-in `excuse`, which is a Cerbos
  // matter (`hr_people_ops` vs `hr_people_reader`), not a person-axis matter. See derived_roles.yaml.
  "hr_staff",
  "hr_manager",
  // The served-company case (§8's fifth column). The reconciler materializes `<module>_staff` /
  // `<module>_manager` scoped to the SERVED tenant, and ONLY while the assignment is `status='active'`
  // (service-reconciler.ts: "status='active' ⇒ grants; anything else ⇒ EMPTY"). Cerbos bounds WHICH
  // GRAINS this tier may read — `read_department`/`read_project` only, never `read_person` (see
  // resource_report_document.yaml's header for why that §8 cell is not enforceable as written), so
  // this entry never actually widens the person axis; it exists so a served lead is not mistaken for
  // a `unit_scoped` caller and narrowed against a unit subtree in the WRONG tenant's org tree.
  "reports_staff",
  "reports_manager",
]);
// HIER-2 (2026-08-11) added `org_unit_lead` alongside `team_lead` as a pure widening. HIER-3
// (2026-08-11) now retires `team_lead` itself — the role, its Cerbos derived role, and every
// writer that could mint the grant are gone — so it comes out of this set in the same change, per
// the HIER-01 consolidation plan's own sketch (`{"manager","unit_lead"}`).
const UNIT_SCOPED_ROLES = new Set(["manager", "org_unit_lead"]);

/** Does this grant apply to `tenantId`? A `global` grant covers everything; `company` must match
 *  exactly (a null/absent scopeId is NEVER a wildcard — the same A4 rule `rbac.ts`'s `scopeCovers`
 *  enforces on the UI side). `project`/`org_unit` grants are unit-ish by nature and are only ever
 *  consulted for the `unit_scoped` tier. */
function grantCoversTenant(g: Principal["roles"][number], tenantId: string): boolean {
  if (g.scopeType === "global") return true;
  return g.scopeType === "company" && g.scopeId === tenantId;
}

/**
 * Resolve the caller's person-axis tier. Reads ONLY `principal.roles` — server-assembled from
 * `user_roles` at auth time, never client input — which is the same data Cerbos's derived roles
 * evaluate, so the two can never disagree about what grants exist (only about what they permit,
 * which is the point of the split).
 */
export function personAxisTier(principal: Principal, tenantId: string): PersonAxisTier {
  const roles = principal.roles;
  if (roles.some((g) => UNRESTRICTED_ROLES.has(g.role) && g.scopeType === "global")) return "unrestricted";
  if (roles.some((g) => COMPANY_WIDE_ROLES.has(g.role) && grantCoversTenant(g, tenantId))) return "company_wide";
  if (
    roles.some(
      (g) =>
        UNIT_SCOPED_ROLES.has(g.role) &&
        // HIER-2: `org_unit` added — an `org_unit_lead` grant is never company/global/project-
        // scoped by construction (0100's shape CHECK), so without this branch an org_unit_lead
        // holder would never register as `unit_scoped` at all. HIER-3 (2026-08-11) removed the
        // `team`/`record` branches — both scope_type values are retired.
        (grantCoversTenant(g, tenantId) ||
          g.scopeType === "project" ||
          g.scopeType === "org_unit"),
    )
  ) {
    return "unit_scoped";
  }
  return "self_only";
}

/** True when the caller must be narrowed to their own led unit subtree. The ONLY predicate any
 *  controller should branch on — never a re-derived role check. */
export function requiresUnitNarrowing(principal: Principal, tenantId: string): boolean {
  return personAxisTier(principal, tenantId) === "unit_scoped";
}

/** True when the caller has no tier above "self" — used to decide whether a self-only fallback
 *  read (e.g. TR-39's own-row compliance) applies. */
export function isSelfOnlyTier(principal: Principal, tenantId: string): boolean {
  return personAxisTier(principal, tenantId) === "self_only";
}

// ═══════════════════════════════ PURE CORE — the unit subtree walk ═══════════════════════════════

/** The tolerant org-node shape this file walks. Deliberately structural rather than importing an
 *  admin-side type: `company_org_structure.structure` is free-form JSONB and this walk must survive
 *  a node missing `kind` or `children` entirely. */
export interface UnitTreeNode {
  id?: string;
  kind?: string;
  children?: UnitTreeNode[] | null;
}

/** Unit-bearing node kinds — the same pair `dept-resolution.ts`'s `UNIT_KINDS` uses, so a person's
 *  resolved `unit_node_id` and this subtree walk agree on what counts as a unit. */
const UNIT_KINDS = new Set(["department", "division"]);

/**
 * Unwrap `company_org_structure.structure`, which `sanitizeStructure()`
 * (`admin/company-admin.controller.ts`, its ONLY writer) always stores as `{root: OrgNode}`.
 *
 * ⚠ This is TR-37's bug verbatim, and the reason this unwrap lives INSIDE the walk rather than at
 * each call site: `deriveUnitDepartments()` was handed the WRAPPER instead of the root, so
 * `node.kind`/`node.children` were `undefined`, the walk terminated immediately, and department
 * roll-up silently returned an EMPTY map against all real data — while passing every test, because
 * the fixtures were written in the bare-root shape and therefore encoded the bug. Unwrapping here
 * (tolerating BOTH shapes, so legacy/seeded bare-root rows still work) makes reintroduction
 * structurally impossible. §15's lesson applied: derive a fixture's shape from the module that
 * WRITES the data, not from the reader under test.
 */
export function unwrapOrgRoot(structure: unknown): UnitTreeNode | null {
  if (!structure || typeof structure !== "object") return null;
  const s = structure as { root?: UnitTreeNode } & UnitTreeNode;
  if (s.root && typeof s.root === "object") return s.root;
  if (typeof s.id === "string") return s;
  return null;
}

/**
 * PURE. Every unit node id in `unitNodeId`'s subtree, INCLUSIVE of itself.
 *
 * This is the substantive correctness fix inside decision (a). TR-09's narrowing compared the
 * caller's unit to the subject's unit for **exact equality**, which is wrong for the org shape this
 * estate actually runs: TR-37 established that "the estate's org charts are
 * departments-containing-divisions" and `deriveBlobPlacements` resolves a person to their NEAREST
 * department/division ancestor. So a department lead placed at the department node whose reports sit
 * in divisions beneath it resolved to `'d-web'` vs `'dv-frontend'` — unequal — and the lead could
 * see NOBODY. §8's "own unit's members" means the unit the caller leads, which for a department
 * means the department and everything under it.
 *
 * Returns `[unitNodeId]` when the tree is absent or the node is not found — i.e. it degrades to
 * exactly the old exact-equality behaviour rather than to "everything", so an unreadable/missing org
 * blob narrows access, never widens it (fail-closed).
 */
export function collectUnitSubtree(structure: unknown, unitNodeId: string): string[] {
  const root = unwrapOrgRoot(structure);
  const found: string[] = [unitNodeId];
  if (!root) return found;

  const collectDescendants = (node: UnitTreeNode): void => {
    for (const child of node.children ?? []) {
      if (!child || typeof child !== "object") continue;
      if (typeof child.id === "string" && UNIT_KINDS.has(child.kind ?? "")) found.push(child.id);
      collectDescendants(child);
    }
  };

  const locate = (node: UnitTreeNode): boolean => {
    if (node.id === unitNodeId) {
      collectDescendants(node);
      return true;
    }
    for (const child of node.children ?? []) {
      if (child && typeof child === "object" && locate(child)) return true;
    }
    return false;
  };

  locate(root);
  return [...new Set(found)];
}

// ═══════════════════════════════ I/O EDGE — resolving the boundary ═══════════════════════════════

/** A caller's own primary unit(s) as of `asOf`. Plural because `org_unit_memberships` only
 *  guarantees non-overlap for PRIMARY rows via its EXCLUDE constraint per (tenant, user) — one row
 *  is the norm, but this never assumes it. Non-primary memberships (a committee, a temporary loan)
 *  are deliberately EXCLUDED: §3.2 makes `is_primary` the membership that counts for attribution,
 *  and letting a committee seat widen someone's read scope would be a silent privilege path. */
async function ownPrimaryUnits(c: PoolClient, tenantId: string, userId: string, asOf: string): Promise<string[]> {
  const { rows } = await c.query<{ unit_node_id: string }>(
    `SELECT DISTINCT unit_node_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND user_id = $2 AND is_primary
        AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $3::date)`,
    [tenantId, userId, asOf],
  );
  return rows.map((r) => r.unit_node_id);
}

/** The tenant's org tree, or `null`. Read under the caller's existing transaction (so RLS/the third
 *  wall still bound it) — `company_org_structure` is FORCE-RLS'd, so a missing tenant GUC yields
 *  zero rows and `collectUnitSubtree` degrades to exact-unit equality. */
async function loadOrgStructure(c: PoolClient, tenantId: string): Promise<unknown> {
  const { rows } = await c.query<{ structure: unknown }>(
    `SELECT structure FROM company_org_structure WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.structure ?? null;
}

/**
 * THE unit boundary: every unit id the caller may read the person axis within, as of `asOf`.
 *
 * An EMPTY set means "this caller leads no unit" — which must read as *no access*, never as
 * *unfiltered access*. Every consumer below honours that, and it is asserted by the parity suite.
 *
 * HIER-2: `principal`, when passed, adds a SECOND, GRANT-DERIVED source — the union of the
 * caller's `org_unit`-scoped `org_unit_lead` grant scopeIds, each expanded by the SAME
 * `collectUnitSubtree` walk used for the placement-derived `manager` path below. Additive, never
 * replacing: leadership is now also explicit and grant-auditable (D-3), not solely inferred from
 * where the caller happens to sit in the chart. `principal` is OPTIONAL and defaults to no
 * grant-derived source, so every pre-existing call site that doesn't pass it keeps its exact
 * prior behaviour.
 */
export async function loadLedUnitScope(
  c: PoolClient,
  tenantId: string,
  userId: string | null,
  asOf: string,
  principal?: Principal,
): Promise<Set<string>> {
  if (!userId) return new Set();
  const own = await ownPrimaryUnits(c, tenantId, userId, asOf);
  const grantedUnits = (principal?.roles ?? [])
    .filter((g) => g.role === "org_unit_lead" && g.scopeType === "org_unit" && !!g.scopeId)
    .map((g) => g.scopeId as string);
  if (own.length === 0 && grantedUnits.length === 0) return new Set();
  const structure = await loadOrgStructure(c, tenantId);
  const scope = new Set<string>();
  for (const unit of own) for (const id of collectUnitSubtree(structure, unit)) scope.add(id);
  for (const unit of grantedUnits) for (const id of collectUnitSubtree(structure, unit)) scope.add(id);
  return scope;
}

/** A subject's primary unit as of `asOf`, or `null` when they have none (pre-adoption history, or
 *  offboarded). `null` is NOT in any led scope, so such a subject is unreachable by a `unit_scoped`
 *  caller — fail-closed, and deliberately so: an unplaceable person cannot be shown to be inside
 *  anyone's line. */
export async function resolveSubjectUnit(
  c: PoolClient,
  tenantId: string,
  subjectUserId: string,
  asOf: string,
): Promise<string | null> {
  const units = await ownPrimaryUnits(c, tenantId, subjectUserId, asOf);
  return units[0] ?? null;
}

/**
 * Assert that `subjectUserId` is inside the caller's line, for a caller Cerbos has ALREADY allowed.
 * Self always passes (a person is always in their own line — §11 principle 2: "nothing about you
 * that you cannot read").
 *
 * Throws `ForbiddenException` — 403, never 404 (§8 hard rule 2).
 */
export async function assertPersonInLedScope(
  c: PoolClient,
  tenantId: string,
  principal: Principal,
  subjectUserId: string,
  asOf: string,
): Promise<void> {
  if (!requiresUnitNarrowing(principal, tenantId)) return;
  if (principal.userId && principal.userId === subjectUserId) return;
  const scope = await loadLedUnitScope(c, tenantId, principal.userId, asOf, principal);
  if (scope.size === 0) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
  const theirs = await resolveSubjectUnit(c, tenantId, subjectUserId, asOf);
  if (!theirs || !scope.has(theirs)) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
}

/**
 * Assert that a DEPARTMENT-grain `scopeRef` (an org unit node id) is inside the caller's line.
 * §8's "department-grain document read · dept lead ✅ own unit" — which before TR-25 was
 * unenforced, so a bare `manager` grant read every department's document in the tenant.
 */
export async function assertUnitInLedScope(
  c: PoolClient,
  tenantId: string,
  principal: Principal,
  unitNodeId: string,
  asOf: string,
): Promise<void> {
  if (!requiresUnitNarrowing(principal, tenantId)) return;
  const scope = await loadLedUnitScope(c, tenantId, principal.userId, asOf, principal);
  if (!scope.has(unitNodeId)) throw new ForbiddenException(OUT_OF_LINE_MESSAGE);
}

/**
 * As-of date for every person-axis narrowing decision: TODAY in the deployment's `REPORTS_TZ`.
 *
 * THE canonical implementation — `checkins.controller.ts` re-exports this one rather than keeping the
 * copy TR-09 wrote, so the boundary and the check-in surface can never disagree about what day it is.
 * `en-CA` is the one built-in `Intl.DateTimeFormat` locale that formats as `YYYY-MM-DD`, so no manual
 * re-assembly of parts (and no risk of a locale silently reordering them).
 *
 * ⚠ WHY TODAY AND NOT THE REQUESTED RANGE'S END — a deliberate, security-relevant choice. The
 * narrowing question is "is this person in my line", which is a question about the CALLER'S CURRENT
 * line of sight, not about org history. Resolving it as-of the range end instead would mean a lead who
 * asks for a PAST range gets judged against a PAST org chart — so a lead could read the report of
 * someone who has since transferred out of their unit simply by choosing a start date from before the
 * transfer. That is a one-parameter bypass of the whole boundary. Anchoring on today is strictly
 * tighter and cannot be influenced by request input. The consequence is accepted and correct: a lead
 * loses access to a former report's numbers when that person leaves their unit, while (per §15's TR-04
 * ruling) the person's own department HISTORY is untouched — the numbers still roll up where they
 * always did, they are just no longer readable by a lead who no longer leads them.
 */
export function todayIsoInTz(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Primary unit as of `asOf` for MANY users in one round trip — the listing-surface counterpart to
 *  `resolveSubjectUnit`. A user absent from the result (or mapped to `null`) is in NO led scope. */
export async function loadUnitByUser(
  c: PoolClient,
  tenantId: string,
  userIds: string[],
  asOf: string,
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (userIds.length === 0) return map;
  const { rows } = await c.query<{ user_id: string; unit_node_id: string }>(
    `SELECT user_id, unit_node_id FROM org_unit_memberships
      WHERE tenant_id = $1 AND is_primary AND user_id = ANY($2::uuid[])
        AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $3::date)`,
    [tenantId, userIds, asOf],
  );
  for (const r of rows) if (!map.has(r.user_id)) map.set(r.user_id, r.unit_node_id);
  return map;
}

/** PURE. Filter an already-computed set of per-person rows to the caller's line. Used for LISTING
 *  surfaces, where denying the whole call would be wrong — the caller legitimately sees *their*
 *  slice. Slicing an already-correct grid (rather than re-deriving it under a filter) is what makes
 *  a lead's number for a person IDENTICAL to that person's own number (TR-39's bar). */
export function sliceRowsToUnitScope<T>(
  rows: T[],
  unitByUser: Map<string, string | null>,
  scope: Set<string>,
  userIdOf: (row: T) => string,
): T[] {
  return rows.filter((row) => {
    const unit = unitByUser.get(userIdOf(row));
    return !!unit && scope.has(unit);
  });
}
