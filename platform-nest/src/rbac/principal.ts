// Principal assembly (RBAC spec §2). Assembled per request from the DB — never from
// anything a client asserts. Assurance tiers (D4, v1-lite):
//   'high'    — platform-authenticated user (IdP once it exists; dev-header behind the
//               service token today, which only trusted services hold).
//   'linked'  — resolved from a VERIFIED identity_links row (dual-proof enrollment):
//               standard in-tenant access; sensitive/bulk/cross-tenant still need 'high'.
//   'low'     — unverified link or unknown external identity: no company data at all.
import { withGlobal, withTenants } from "../db";
import { isGrantScopeReachable } from "./scope-constrained-roles";

/** Local copy (2 lines, zero deps) rather than importing `isUuidShaped` from `core/dept-resolution.ts`:
 *  this file is the authz substrate and must not gain a dependency on a domain module. See
 *  `auditDecision` below for why a uuid shape-check is needed at all. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type Assurance = "low" | "linked" | "high";

// HIER-1 (2026-08-10) added `org_unit` to this union as a pure WIDENING. HIER-3 (2026-08-11) now
// retires `team`/`record` from it too, in the same change that removes migration 0100's DB-level
// CHECK values' last writers (`teams.controller.ts`, the `team_lead` persona seeds) — the DB and
// this TS union are back in agreement: both permit exactly `global | company | org_unit | project`.
export interface RoleGrant {
  role: string;
  scopeType: "global" | "company" | "org_unit" | "project";
  scopeId: string | null;
}

/** IAM-03a: a single resolved (permission key, scope) a principal holds — the role→permission
 *  expansion of one `RoleGrant` via `role_permissions` (IAM-02a, migration 0094). `key` is a
 *  `permissions.key` from the catalog (migration 0093, `permission-catalog.json`), e.g.
 *  `"core.task.update"`. `scopeType`/`scopeId` are copied from the GRANT the permission was
 *  reached through — a company-scope `manager` grant yields company-scope perms at that same
 *  company, not global ones; a global-scope `platform_admin` grant yields global-scope perms. */
export interface PermissionGrant {
  key: string;
  scopeType: "global" | "company" | "org_unit" | "project";
  scopeId: string | null;
}

export interface Principal {
  userId: string | null; // null = unknown external identity
  assurance: Assurance;
  companies: string[]; // authorized tenant set (active memberships)
  /** MON-00c (Wall 2). Every company sharing this principal's ROOT company tree. Cerbos's `inRoot`
   *  variable tests `resource.tenantId in rootCompanies`, which needs no handler change because
   *  tenantId is already on every resource.
   *
   *  Anchor precedence (assemblePrincipal, MON-00c + MON-00i): `users.home_company_id` first, else
   *  the roots of any ACTIVE `company_memberships` row ("staff anchors" — this is why
   *  `group_executive` still works despite holding a global grant with ZERO membership rows,
   *  IAM-TRAP4: its home_company_id carries it, not memberships); else, ONLY if neither exists, the
   *  roots of any ACTIVE `client_contacts` row (the "portal anchor" — MON-00i, closes the gap where
   *  a client-portal principal had no anchor at all and so could never satisfy a root-gated
   *  `portal` rule). The portal anchor is a fallback, never merged in alongside a staff anchor —
   *  see assemblePrincipal's own comment for why unioning them would let an unrelated portal
   *  identity widen a staff principal's root-gated reach.
   *
   *  EMPTY MEANS DENY, WITH NO EXCEPTION. An unanchored principal yields the empty set and therefore
   *  denies, including on the principal's own data. That is deliberate and it is the correction of a
   *  first attempt at this field which read "null => operator staff => every company": the very
   *  principal that leaks (a customer's group_executive) has no memberships and so lands on exactly
   *  that null, which would have handed it the whole estate while looking like a safe default.
   *
   *  Operator reach is therefore NOT expressed here. It comes from `platform_admin`, whose rules are
   *  not root-gated — an explicit grant rather than the absence of a value.
   *
   *  OPTIONAL only so existing fixtures need not be rewritten; omitting it is SAFE because
   *  cerbos.ts sends `?? []`, and the empty set denies. */
  rootCompanies?: string[];
  roles: RoleGrant[];
  /** IAM-03a: STRICTLY ADDITIVE alongside `roles` — every existing call site that only reads
   *  `roles` is unaffected. Resolved from `role_permissions` (IAM-02a); NEVER contains a
   *  `class='relationship'` key (Ruling 3) — enforced twice over, see `assemblePrincipal`'s query
   *  comment and 0093's `role_permissions_reject_relationship` trigger. Nothing consumes this yet
   *  (Cerbos still matches role names; the permission-matching rewrite is IAM-04).
   *
   *  Declared OPTIONAL, not required, so this ticket touches zero files outside `src/rbac/`:
   *  ~20 existing test files across `src/rbac/`, `src/modules/reports/`, `src/modules/search/`
   *  hand-construct `Principal` literals for mocking and are owned by other work/other concurrent
   *  agents in this checkout. `assemblePrincipal()` (the one real producer) always populates it;
   *  `principalHasPermission()` below defends with `p.perms ?? []` for the synthetic literals that
   *  don't. A later ticket that starts actually depending on `perms` can tighten this to required
   *  once those call sites are updated — not this one's remit. */
  perms?: PermissionGrant[];
  sessionVersion: number; // D11

  /**
   * ── THE CO-AUTHOR (2026-08-20) — the interim half of [agent-attribution-gate] ──────────────────
   *
   * The channel this request arrived on, and the agent driving it if any. Until now `Principal`
   * carried userId · assurance · companies · roles · sessionVersion and NOTHING about the channel, so
   * every `activities` row, `work_activity` fact and ledger entry recorded "Alice did X" when the
   * truth was "Alice's agent did X" — unrecoverably. That was not a dropped log line: it was
   * information with nowhere to live.
   *
   * The owner's framing settles the design as git's `Co-Authored-By`:
   *   AUTHOR    = the human (authority, permission, accountability — Cerbos still decides on THEM,
   *               and an agent can never do what its principal could not);
   *   CO-AUTHOR = the agent (mechanism, recorded ALONGSIDE, never INSTEAD).
   *
   * That makes this additive and AUTHORIZATION-NEUTRAL: no new rights are minted, so no policy needs
   * re-reasoning. Nothing in `can()`/Cerbos reads it. It exists to be stamped onto writes.
   *
   * OPTIONAL for the same reason `perms` is: ~dozens of test files hand-construct `Principal`
   * literals, and this ticket has no business touching them. `assemblePrincipal` does not set it —
   * the AuthGuard does, because the channel is a property of the REQUEST, not of the user.
   *
   * This is step 1 of 2. Step 2 (a real persona per department with its own `users` row, roles and
   * lifecycle) depends on the `users.kind` migration and is deliberately not here.
   */
  via?: {
    /** `whatsapp` · `platform` · `n8n` · … — the OBO envelope's provider, or `session` for a cookie. */
    provider: string;
    externalId: string;
    /** Present only when an AGENT drove the call. Its absence is the meaningful case: a human did it. */
    agent?: string;
  };

  /**
   * ── DELEGATION (2026-08-22) — step 2 of [agent-attribution-gate], owner-accepted ───────────────
   *
   * The HUMAN this call is made on behalf of, when the caller is a persona acting for someone.
   *
   * ⚠ THIS IS THE ONE FIELD ON `Principal` THAT IS AUTHORIZATION-BEARING RATHER THAN NEUTRAL.
   * `via` records who drove a call and changes no decision. This CHANGES DECISIONS — and it can only
   * ever change them one way.
   *
   * THE PROBLEM IT SOLVES. `Principal` holds ONE `userId`, and OBO resolves to either the human or
   * the bot. There was no delegation, so "a persona helps an employee within that employee's scope,
   * and escalates beyond it" could not be expressed: whichever identity the envelope named got that
   * identity's full authority. A persona with `hr_manager` helping a junior would act with
   * hr_manager's reach; a junior's own request routed through a powerful persona would too.
   *
   * THE MODEL (owner's ruling, plan §Deferred): effective permission = persona scope ∩ acting user's
   * permissions. `authorize()` checks Cerbos TWICE — once as the caller, once as the acting user —
   * and denies if EITHER denies. Both identities are audited.
   *
   * ⚠ WHY A HEADER CAN BE TRUSTED FOR THIS, which is not obvious given it decides authorization.
   * Because an intersection is MONOTONICALLY NARROWING: adding `actFor` can only ever subtract from
   * what the caller could already do alone. A caller that lies about it does not gain reach — it
   * loses reach, and incriminates a human who did not ask. That is a strictly stronger safety
   * argument than `via`'s ("a lie gains nothing"), and it is the property `authorize()`'s tests pin.
   * It is still read only inside the OBO block, which already requires the service token.
   *
   * THE ALTERNATIVE REJECTED: persona authority plus a redaction layer. That trades an architectural
   * guarantee for a filter which must be correct on every field, every endpoint, forever — and its
   * failure mode is silent over-disclosure rather than a denial.
   */
  actFor?: {
    /** The acting human's `users.id`. Resolved by the guard, never taken on faith from the body. */
    userId: string;
  };

  /**
   * ── WHY THIS PRINCIPAL IS ANONYMOUS (2026-08-24) ────────────────────────────────────────────────
   *
   * Set by the AuthGuard when an OBO envelope WAS presented and could not be resolved to a verified,
   * active user. The degrade to `ANONYMOUS` is correct and stays — an unknown WhatsApp number must
   * still reach the public surface — but it was SILENT, and that cost real diagnostic time: every
   * subsequent route answered `403 not authorized: cerbos denied <action> on <kind>`, which reads as
   * a policy bug in the resource being asked for. The actual cause was one bad identifier in the
   * envelope, three layers up, and nothing in the response pointed at it.
   *
   * ⚠ AUTHORIZATION-NEUTRAL, like `via` and unlike `actFor`. Nothing in Cerbos, `check()`, or the
   * permission expansion reads it. It changes only what a denial SAYS. The principal denies exactly
   * as it denied before this field existed — the 403 now just names the reason it is anonymous
   * instead of describing the symptom.
   *
   * Absent on every other principal, including a legitimately anonymous caller who presented no
   * envelope at all: there is nothing unresolved about not having asked.
   */
  oboUnresolved?: {
    /** `no-identity-link` — the (provider, external_id) pair matches no `identity_links` row at all.
     *  `link-unverified` — a link exists but has never completed dual-proof enrollment (`verified_at`
     *  is null), so it names a claim, not an identity.
     *  `user-inactive` — the link is verified, but the user it points at is deleted, disabled, or
     *  otherwise no longer assembles into a principal. */
    reason: "no-identity-link" | "link-unverified" | "user-inactive";
    provider: string;
    externalId: string;
  };
}

export const ANONYMOUS: Principal = {
  userId: null,
  assurance: "low",
  companies: [],
  rootCompanies: [],
  roles: [],
  perms: [],
  sessionVersion: 0,
};

export async function assemblePrincipal(userId: string, assurance: Assurance): Promise<Principal | null> {
  const user = await withGlobal((c) =>
    c.query<{ id: string; status: string; session_version: number }>(
      `SELECT id, status, session_version FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    ),
  );
  if (!user.rows[0] || user.rows[0].status !== "active") return null;

  // IAM-03a: `roles` (unchanged query, unchanged shape — every existing caller keeps working) and
  // its `perms` expansion resolved in the SAME connection checkout (one extra query, not one extra
  // pool round trip) — see the IAM-03b report for the measured cost. The perms query joins through
  // `role_permissions` (IAM-02a, 0094) to the SAME `user_roles` grant row, so a permission's
  // scopeType/scopeId is always the scope the enclosing ROLE grant was made at, never invented.
  // `p.class = 'grantable'` is defense-in-depth, not the only thing preventing a relationship-class
  // leak here: 0093's `role_permissions_reject_relationship` trigger already makes it structurally
  // impossible for any of the 15 class='relationship' permissions to be a row in `role_permissions`
  // in the first place, so this WHERE clause can never actually have anything to filter out — kept
  // anyway so this query's own correctness doesn't depend on a reader remembering that fact, and so
  // a future bug that somehow got a relationship row into `role_permissions` would still be caught
  // here rather than surfacing only in the DB trigger.
  //
  // IAM-SEC-06: the query ALSO selects the grant's own role NAME (one more JOIN to `roles`, already
  // paid for by `rolesRes` above on a different connection round trip — this is still exactly ONE
  // query, not one per grant) so each resolved row can be checked against
  // `isGrantScopeReachable(role, scopeType)` (`./scope-constrained-roles.ts`) BEFORE it survives into
  // `perms`. A row whose (role, scopeType) pairing is one that role's OWN Cerbos derived-role
  // condition could never satisfy — `platform_admin@company`, `org_unit_lead@company`, … — is
  // DROPPED here: the grant itself is untouched (still visible in `roles`/the DB), only the
  // permission this filter would otherwise have let a `perm_*` mirror honour at that mis-scoped scope
  // is withheld. This is the fix IAM-04c's ruling (§8 option A) calls for: the write-path guard
  // (`admin-identity.controller.ts`'s `ROLE_SCOPE_CONSTRAINTS`) is defense-in-depth, not the
  // authority — seeds/migrations write grants directly, and a guard is only as good as its
  // completeness (IAM-SEC-05 found it wasn't). Filtering here closes the hazard regardless of how the
  // mis-scoped grant row came to exist.
  //
  // De-duplication moves from SQL to this function's own loop because adding `roleName` to the
  // SELECT list would otherwise make `DISTINCT` stop collapsing the case two DIFFERENT roles reach
  // the identical (key, scopeType, scopeId) triple (e.g. `member` and `manager` both reaching
  // `core.task.read` at the same company scope) — `roleName` differs between those two rows, so
  // `DISTINCT` alone would no longer merge them. The loop below re-establishes that exact guarantee
  // (and still absorbs the pre-existing duplicate-global-grant defect, Finding F / migration 0092)
  // by keying on (key, scopeType, scopeId) itself, AFTER the per-row scope-reachability filter —
  // so a (key, scope) pair is dropped only if EVERY grant that would have produced it was mis-scoped,
  // and kept if any OTHER, validly-scoped grant also reaches it.
  const { roles, perms } = await withGlobal(async (c) => {
    const rolesRes = await c.query<RoleGrant>(
      // P2-09/§12.4 — EXPIRY IS ENFORCED AT RESOLUTION, not only by the nightly sweep.
      // `user_roles.expires_at` shipped in 0109; P2-08 became its first writer (time-boxed grants and
      // §6.5 overrides) and P2-09 added the sweep that revokes on it. A sweep alone means an expired
      // grant is FULLY LIVE until the next tick — up to a day of access a human explicitly time-boxed
      // — because nothing in this resolver looked at the column. This conjunct closes that window: the
      // moment the timestamp passes, the grant stops resolving into the principal, so Cerbos never
      // sees it and the sweep's job is reduced to tidying the row and auditing it.
      // NULL = permanent, which is every pre-P2-08 row, so this is a no-op for existing grants.
      `SELECT r.name AS role, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [userId],
    );
    const permsRes = await c.query<PermissionGrant & { roleName: string }>(
      `SELECT DISTINCT p.key AS key, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId",
              r.name AS "roleName"
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND p.class = 'grantable'
         AND (ur.expires_at IS NULL OR ur.expires_at > now())`,
      [userId],
    );
    const filtered = new Map<string, PermissionGrant>();
    for (const row of permsRes.rows) {
      if (!isGrantScopeReachable(row.roleName, row.scopeType)) continue; // IAM-SEC-06
      const dedupeKey = `${row.key} ${row.scopeType} ${row.scopeId ?? ""}`;
      if (!filtered.has(dedupeKey)) {
        filtered.set(dedupeKey, { key: row.key, scopeType: row.scopeType, scopeId: row.scopeId });
      }
    }
    return { roles: rolesRes.rows, perms: [...filtered.values()] };
  });

  // Memberships are RLS-protected; the dedicated principal_lookup policy exposes only
  // the rows of the user being resolved, keyed on this transaction-local setting.
  //
  // W0 — the UNION with client_contacts is what gives an external client portal contact a tenant at
  // all. `resource_portal.yaml` grants its actions to the `client` derived role gated on
  // `variables.inTenant`, and inTenant is `resource.tenantId in principal.companies`, so without this
  // a client authenticates fine and is then refused everything, with nothing to say why.
  //
  // WHY NOT A company_memberships ROW FOR CLIENTS (the alternative, deliberately rejected — see
  // migration 0072's header): only 6 of 27 non-test queries over company_memberships filter `kind`,
  // so putting clients there would have required a defensive filter at ~10 staff-listing sites and
  // left every future site free to forget, with a client contact showing up in /people and HR as an
  // employee. Keeping clients out of that table entirely makes the leak structurally impossible;
  // this UNION and `notify()` are the only two places that deliberately look at both.
  //
  // Safe because "user" — the parent of the `client` derived role — is granted by NO resource policy:
  // every grant in cerbos/policies names a concrete staff role or `client`, and derivedRoles:
  // ["client"] appears only in resource_portal.yaml. A principal whose only grant is `client`
  // therefore satisfies exactly one policy, so a tenant appearing here opens nothing else.
  //
  // client_contacts carries its own principal_lookup policy (0072 §7b) for the same reason
  // company_memberships does: this read happens BEFORE any tenant context exists, so under
  // tenant_isolation alone it would match zero rows.
  //
  // MON-00i — `companies` and `rootCompanies` are now resolved in the SAME transaction/GUC scope,
  // not two separate `withGlobal` calls. They used to be split, and the split was a live bug: the
  // root-anchor query joined `company_memberships` (FORCE RLS, `principal_lookup` policy keyed on
  // `app.principal_user_id`) from a plain `withGlobal` call that never set that GUC. RLS therefore
  // returned ZERO rows for that join regardless of how many real memberships existed, so the
  // membership-fallback branch the comment below describes was dead code — verified live: a user
  // with one active membership and no `home_company_id` resolved `rootCompanies: []`. Nothing
  // caught this because every existing root-anchored fixture (`cross-root-boundary.db.test.ts`'s
  // execA, etc.) sets `home_company_id` directly and so never exercised the membership branch.
  // Fixing it here is not a scope departure: MON-00i's own new client_contacts anchor (below) reads
  // the identical FORCE-RLS/`principal_lookup` shape, so it would have shipped with the exact same
  // defect if the two queries stayed apart.
  const { companies, rootCompanies } = await withGlobal(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
      const companiesRes = await c.query<{ tenant_id: string }>(
        `SELECT m.tenant_id FROM company_memberships m
          WHERE m.user_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL
         UNION
         SELECT cc.tenant_id FROM client_contacts cc
          WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL`,
        [userId],
      );

      // MON-00c + MON-00i. Resolved from the user's home company and memberships first ("staff
      // anchors"); a client-portal anchor (client_contacts) is consulted ONLY as a fallback when
      // NEITHER exists. A user with no anchor of any kind is operator staff or truly unanchored and
      // gets the empty set, which denies rather than allows.
      //
      // WHY PRECEDENCE, NOT A FLAT UNION ACROSS ALL THREE SOURCES: `users.email` is globally
      // unique (CLAUDE.md), so the SAME `users` row can in principle be both an internal employee
      // of one root (home_company_id, or a membership) AND, independently, an external portal
      // contact of a completely unrelated company under a DIFFERENT root (their client_contacts
      // row was added by some other agency's staff, using the same email). Unioning that
      // client_contacts root into a STAFF principal's `rootCompanies` would silently widen every
      // OTHER root-gated rule this same user's staff roles hold (`group_executive`'s `inRoot`, and
      // any future one) into a foreign root they merely happen to also be a client of — a real
      // escalation, not a portal-only concern. A pure portal principal (no staff anchor at all) has
      // no such rule to widen: its only root-gated reach is the 8 `portal` rules this ticket adds
      // (the `client` role-arm rule plus its 7 `perm_portal_*` mirrors), and those are ALSO gated on
      // `variables.inTenant` — which is independently pinned to the caller's own explicit
      // `client_contacts` rows — so `inRoot` there can only ever narrow, never widen, a decision
      // `inTenant` didn't already allow. See resource_portal.yaml's header for that argument in
      // full. `NOT EXISTS` (not a plain `UNION`) is what encodes "fallback, not merge" here.
      const rootRes = await c.query<{ id: string }>(
        `WITH staff_anchors AS (
           SELECT home.root_company_id
             FROM users u JOIN companies home ON home.id = u.home_company_id
            WHERE u.id = $1
           UNION
           SELECT co.root_company_id
             FROM company_memberships m JOIN companies co ON co.id = m.tenant_id
            WHERE m.user_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL
         ),
         portal_anchors AS (
           SELECT co.root_company_id
             FROM client_contacts cc JOIN companies co ON co.id = cc.tenant_id
            WHERE cc.user_id = $1 AND cc.status = 'active' AND cc.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM staff_anchors)
         ),
         anchors AS (
           SELECT root_company_id FROM staff_anchors
           UNION
           SELECT root_company_id FROM portal_anchors
         )
         SELECT co.id FROM companies co
          WHERE co.deleted_at IS NULL
            AND co.root_company_id IN (SELECT root_company_id FROM anchors)`,
        [userId],
      );

      await c.query("COMMIT");
      return { companies: companiesRes, rootCompanies: rootRes.rows.map((r) => r.id) };
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    }
  });

  return {
    userId,
    assurance,
    companies: companies.rows.map((r) => r.tenant_id),
    rootCompanies,
    roles,
    perms,
    sessionVersion: user.rows[0].session_version,
  };
}

/** IAM-03a: does `p` hold `key` in a grant that covers `scopeType`/`scopeId`? A `global`-scope
 *  grant of `key` covers every scope (global is the top of the cascade); any other grant must
 *  match the exact (scopeType, scopeId) pair it was resolved at. This does NOT resolve narrower
 *  cascades (e.g. whether a company-scope grant should also cover that company's teams/projects)
 *  — that cascade lives in Cerbos's derived-role policy conditions today (D16 PlanResources) and
 *  is deliberately left there; this only saves a future consumer the "global beats everything"
 *  special case and a linear re-scan of `perms`, not a full authorization decision. Nothing calls
 *  this yet — IAM-04's permission-matching derived roles and IAM-05a's `can()` are the intended
 *  consumers. */
export function principalHasPermission(
  p: Principal,
  key: string,
  scopeType: PermissionGrant["scopeType"],
  scopeId: string | null,
): boolean {
  return (p.perms ?? []).some(
    (g) => g.key === key && (g.scopeType === "global" || (g.scopeType === scopeType && g.scopeId === scopeId)),
  );
}

/** D11: sensitive paths re-check the live session version — a revoked/downgraded user
 *  is cut off immediately, not at token expiry. */
export async function sessionVersionCurrent(p: Principal): Promise<boolean> {
  if (!p.userId) return false;
  const { rows } = await withGlobal((c) =>
    c.query<{ session_version: number }>(`SELECT session_version FROM users WHERE id = $1`, [p.userId]),
  );
  return rows[0]?.session_version === p.sessionVersion;
}

/** Audit a decision into the tenant's activity feed (allow AND deny — RBAC spec §6). */
export async function auditDecision(
  tenantId: string | null,
  p: Principal,
  action: string,
  resourceKind: string,
  resourceId: string | null,
  allow: boolean,
  reason: string,
): Promise<void> {
  if (!tenantId) return; // global-scope decisions have no tenant feed (logged by caller)

  // ⚠ TR-25 BUG FIX (pre-existing, found by the person-axis parity suite). `activities
  // .target_entity_id` is `uuid` (0001_core.sql:212), but not every resource id in this codebase is a
  // uuid: an org-unit node id is FREE-FORM TEXT by the 0029 convention (`'d-web'`, `'d-hr'`), and
  // `reports.controller.ts`'s `authorizeReportDocumentRead` passes the department-grain `scopeRef`
  // straight through as `resource.id`. So a DENIED department-grain report read raised
  // `invalid input syntax for type uuid: "d-web"` INSIDE this audit write and surfaced as a bare
  // **500**, not the 403 the caller must get — violating the BFF convention (§8 hard rule 2: an
  // unauthorized read is 403, never 404, and certainly never a server error the UI cannot render a
  // limited-access state for). It went unnoticed because no test had ever asserted a DENIED
  // department-grain read; every existing case used a uuid scopeRef or was allowed.
  //
  // Fixed HERE rather than at the call site because the defect is generic — any resource kind whose id
  // is not a uuid has the same failure mode on denial, and dropping `resource.id` at the call site
  // would change what Cerbos's `manager`/`member` project-scope conditions match on
  // (`g.scopeId == request.resource.attr.id`). Nothing is lost: a non-uuid id is preserved verbatim in
  // `metadata.resourceId`, so the audit trail still names the exact resource that was denied.
  const uuidId = resourceId !== null && UUID_RE.test(resourceId) ? resourceId : null;
  const detail: Record<string, unknown> = { action, reason };
  if (resourceId !== null && uuidId === null) detail.resourceId = resourceId;

  // ⚠ SAME BUG CLASS, SECOND INSTANCE (2026-08-24) — this time on `tenant_id`, not
  // `target_entity_id`. A WELL-FORMED uuid naming a company that does not exist is a perfectly
  // ordinary request (a typo, a stale bookmark, a probe). Cerbos correctly denies it, and then the
  // audit write for that denial violated `activities_tenant_id_fkey` — so the caller received a
  // **500** for a decision that had already been made correctly, exactly the outcome the TR-25
  // comment above exists to forbid. `tenant-param.ts` catches the malformed shape at the router;
  // this catches the well-formed-but-unknown id, which no shape check can.
  //
  // Swallowed NARROWLY: only foreign-key violations (23503), and only after logging. An unknown
  // company has no activity feed to file under, so there is no trail being lost — there was never
  // one to write to. Every other failure still throws, because a broken audit write against a REAL
  // tenant is a genuine fault and must not be hidden: this trail is what makes least privilege
  // accountable, and a blanket catch here would be the quiet end of it.
  try {
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'authz')`,
        [
          tenantId,
          p.userId,
          allow ? "authz.allow" : "authz.deny",
          resourceKind,
          uuidId,
          JSON.stringify(detail),
        ],
      ),
    );
  } catch (e) {
    if ((e as { code?: string }).code !== "23503") throw e;
    console.warn(
      `[authz-audit] decision not filed: company ${tenantId} does not exist ` +
        `(${allow ? "allow" : "deny"} ${action} on ${resourceKind}). The decision itself stands.`,
    );
  }
}
