// IAM-SEC-06 — proves `assemblePrincipal()`'s new resolution-time filter (principal.ts, guarded by
// `isGrantScopeReachable()` in `./scope-constrained-roles.ts`) against every acceptance criterion the
// ticket named. See docs/superpowers/plans/2026-08-13-iam-sec-06-report.md and the ruling it
// implements, docs/superpowers/plans/2026-08-12-iam-04c-ruling.md §8 option (A).
//
// THE DEFECT: a grant recorded at a scope the role's OWN Cerbos derived-role condition can never be
// satisfied at (`platform_admin@company`, `org_unit_lead@company`) used to resolve its FULL
// `role_permissions` bundle at that mis-scoped scope anyway — inert under role-name matching, but
// honoured by any `perm_*` mirror that only checks "global-or-company". This file proves the fix:
// such a grant now resolves ZERO permissions, while every LEGITIMATELY-scoped grant (including
// `org_unit_lead@org_unit`, the role's own correct scope — the "over-refusal" case the ticket
// explicitly warns against getting backwards) is completely unaffected.
//
// Bundle sizes are read from the checked-in `role-permission-bundles.json` artifact, never
// hardcoded — same discipline `principal-permissions.db.test.ts` established and for the identical
// reason (a legitimate bundle change must not turn this file red).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "./principal";
import { check } from "./cerbos";

interface BundlesDoc {
  roles: Record<string, string[]>;
}

const BUNDLE_SIZES: Record<string, number> = (() => {
  const doc = JSON.parse(
    readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8"),
  ) as BundlesDoc;
  return Object.fromEntries(Object.entries(doc.roles).map(([role, keys]) => [role, keys.length]));
})();

function bundleSize(role: string): number {
  const n = BUNDLE_SIZES[role];
  if (n === undefined) {
    throw new Error(`principal-scope-constrained-perms: no bundle for role "${role}" — regenerate role-permission-bundles.json.`);
  }
  return n;
}

describe.skipIf(!TEST_URL)("IAM-SEC-06 · assemblePrincipal() drops perms from a mis-scoped grant", () => {
  let companyA: string;
  let orgUnitId: string;

  let platformAdminMisScopedId: string;
  let orgUnitLeadMisScopedId: string;
  let orgUnitLeadLegitId: string;
  let clientLegitId: string;
  let companyAdminLegitId: string;
  let managerLegitId: string;
  let groupExecMisScopedId: string;

  beforeAll(async () => {
    await initTestDb();
    companyA = await createCompany("IAM-SEC-06 Co A");
    orgUnitId = "d-iam-sec-06-unit";

    const roleIds = {
      platform_admin: await createRole("platform_admin"),
      group_executive: await createRole("group_executive"),
      org_unit_lead: await createRole("org_unit_lead"),
      client: await createRole("client"),
      company_admin: await createRole("company_admin"),
      manager: await createRole("manager"),
    };

    // ── The two ACCEPTANCE-CRITERION mis-scoped grants ──
    platformAdminMisScopedId = await createUser("iam-sec-06-platform-admin-at-company@test.local");
    await grantRole(platformAdminMisScopedId, roleIds.platform_admin, "company", companyA);

    orgUnitLeadMisScopedId = await createUser("iam-sec-06-org-unit-lead-at-company@test.local");
    await grantRole(orgUnitLeadMisScopedId, roleIds.org_unit_lead, "company", companyA);

    // A THIRD mis-scoped instance beyond the two the ticket named explicitly, for the same reason
    // §6 of the ruling flags the global-only direction as sharing the identical hole: proves the
    // fix is general, not two special-cased role names.
    groupExecMisScopedId = await createUser("iam-sec-06-group-exec-at-company@test.local");
    await grantRole(groupExecMisScopedId, roleIds.group_executive, "company", companyA);

    // ── The over-refusal control: org_unit_lead at ITS OWN correct scope must be UNAFFECTED ──
    orgUnitLeadLegitId = await createUser("iam-sec-06-org-unit-lead-legit@test.local");
    await grantRole(orgUnitLeadLegitId, roleIds.org_unit_lead, "org_unit", orgUnitId);

    // ── Legitimate grants for the other named roles — must resolve completely normally ──
    clientLegitId = await createUser("iam-sec-06-client-legit@test.local");
    await grantRole(clientLegitId, roleIds.client, "company", companyA);

    companyAdminLegitId = await createUser("iam-sec-06-company-admin-legit@test.local");
    await grantRole(companyAdminLegitId, roleIds.company_admin, "company", companyA);

    managerLegitId = await createUser("iam-sec-06-manager-legit@test.local");
    await grantRole(managerLegitId, roleIds.manager, "company", companyA);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  // ═══════════════════════ ACCEPTANCE CRITERIA (verbatim from the ticket) ═══════════════════════

  it("ACCEPTANCE: a synthetic platform_admin@company grant resolves ZERO permissions", async () => {
    const p = await assemblePrincipal(platformAdminMisScopedId, "high");
    expect(p).not.toBeNull();
    // The GRANT itself is untouched — still visible in `roles` (only the resolved PERM is filtered).
    expect(p!.roles).toEqual([{ role: "platform_admin", scopeType: "company", scopeId: companyA }]);
    expect(p!.perms).toEqual([]);
  });

  it("ACCEPTANCE: a synthetic org_unit_lead@company grant resolves ZERO permissions", async () => {
    const p = await assemblePrincipal(orgUnitLeadMisScopedId, "high");
    expect(p).not.toBeNull();
    expect(p!.roles).toEqual([{ role: "org_unit_lead", scopeType: "company", scopeId: companyA }]);
    expect(p!.perms).toEqual([]);
  });

  // IAM Phase 2 (P2-02, 2026-08-13): org_unit_lead's bundle grew from 2 to 8 — the new role_grant
  // (create/read/revoke) and position (assign/read/unassign) kinds' own dept-head rules ALSO reuse
  // the org_unit_lead derived role (design §6.2), so a legitimate org_unit@org_unit grant now
  // resolves 6 more perms alongside the original 2 (reports.appraisal.read/read_department). This
  // is additive bundle growth, not a regression of the over-refusal control this test guards.
  it("ACCEPTANCE (over-refusal control): a legitimate org_unit_lead@org_unit grant resolves its permissions NORMALLY", async () => {
    const p = await assemblePrincipal(orgUnitLeadLegitId, "high");
    expect(p).not.toBeNull();
    expect(p!.perms!.length).toBe(bundleSize("org_unit_lead"));
    expect(p!.perms!.length).toBeGreaterThan(0);
    for (const g of p!.perms!) {
      expect(g.scopeType).toBe("org_unit");
      expect(g.scopeId).toBe(orgUnitId);
    }
    const keys = p!.perms!.map((g) => g.key).sort();
    expect(keys).toEqual([
      "core.position.assign", "core.position.read", "core.position.unassign",
      "core.role_grant.create", "core.role_grant.read", "core.role_grant.revoke",
      "reports.appraisal.read", "reports.document.read_department",
    ]);
  });

  it("ACCEPTANCE: a legitimate client@company grant is completely unaffected", async () => {
    const p = await assemblePrincipal(clientLegitId, "high");
    expect(p!.perms!.length).toBe(bundleSize("client"));
    expect(p!.perms!.length).toBeGreaterThan(0);
    expect(p!.perms!.every((g) => g.scopeType === "company" && g.scopeId === companyA)).toBe(true);
  });

  it("ACCEPTANCE: a legitimate company_admin@company grant is completely unaffected", async () => {
    const p = await assemblePrincipal(companyAdminLegitId, "high");
    expect(p!.perms!.length).toBe(bundleSize("company_admin"));
    expect(p!.perms!.every((g) => g.scopeType === "company" && g.scopeId === companyA)).toBe(true);
  });

  it("ACCEPTANCE: a legitimate manager@company grant is completely unaffected", async () => {
    const p = await assemblePrincipal(managerLegitId, "high");
    expect(p!.perms!.length).toBe(bundleSize("manager"));
    expect(p!.perms!.every((g) => g.scopeType === "company" && g.scopeId === companyA)).toBe(true);
  });

  // ═══════════════════════ GENERALIZATION BEYOND THE TWO NAMED ROLES ═══════════════════════

  it("GENERALIZATION: a synthetic group_executive@company grant ALSO resolves ZERO permissions (§6 of the ruling: the global-only direction shares the identical hole)", async () => {
    const p = await assemblePrincipal(groupExecMisScopedId, "high");
    expect(p!.roles).toEqual([{ role: "group_executive", scopeType: "company", scopeId: companyA }]);
    expect(p!.perms).toEqual([]);
  });

  // ═══════════════════════ FAIL-OPEN PIN (ticket's own explicit instruction) ═══════════════════════

  it("FAIL-OPEN PIN: a role with NO scope constraint in the derived map keeps working normally at every scope it's granted at", async () => {
    // agency_approver is reached only via module_approver's dynamic role-name composition — never a
    // literal `g.role == "agency_approver"` in derived_roles.yaml — so it has NO entry in
    // scope-constrained-roles.json (see that file's own test) and must be completely unaffected by
    // this filter, at whatever scope it is legitimately granted.
    const agencyApproverRoleId = await createRole("agency_approver");
    const userId = await createUser("iam-sec-06-agency-approver-unconstrained@test.local");
    await grantRole(userId, agencyApproverRoleId, "company", companyA);
    const p = await assemblePrincipal(userId, "high");
    expect(p!.perms!.length).toBe(bundleSize("agency_approver"));
    expect(p!.perms!.length).toBeGreaterThan(0);
    expect(p!.perms).toEqual([{ key: "agency.approval.approve", scopeType: "company", scopeId: companyA }]);
  });

  it("a user with BOTH a mis-scoped platform_admin grant AND a legitimate manager grant keeps exactly the manager perms, not zero and not platform_admin's", async () => {
    // Proves the filter drops the POISONED grant's contribution only — it does not zero out the
    // whole principal, and does not accidentally let the mis-scoped grant's bundle leak in via the
    // (key, scope) de-duplication now living in application code (principal.ts) rather than SQL.
    const platformAdminRoleId = await createRole("platform_admin");
    const managerRoleId = await createRole("manager");
    const userId = await createUser("iam-sec-06-mixed-mis-and-legit@test.local");
    await grantRole(userId, platformAdminRoleId, "company", companyA); // mis-scoped, poisoned
    await grantRole(userId, managerRoleId, "company", companyA); // legit

    const p = await assemblePrincipal(userId, "high");
    expect(p!.perms!.length).toBe(bundleSize("manager"));
    expect(p!.perms!.every((g) => g.scopeType === "company" && g.scopeId === companyA)).toBe(true);
  });
});

// ═══════════════ LIVE CERBOS END-TO-END — the real assemblePrincipal() -> check() pipe ═══════════════
//
// Needs BOTH a live test DB (TEST_URL) and a running Cerbos loaded with the CURRENT policy
// (CERBOS_URL) — skips otherwise. Restart `gaiada-test-cerbos` before trusting this: it does NOT
// hot-reload (see this repo's own trap). Unlike the tests above (which only inspect the resolved
// `Principal.perms` array), this proves the FULL chain: a real `user_roles` grant row -> the REAL
// `assemblePrincipal()` (now filtering) -> the REAL `principalPayload()`/`check()` -> a REAL Cerbos
// decision — on `kind: "user"`, which `resource_user.yaml` wires with BOTH a role-arm rule
// (company_admin/manager only; platform_admin has only the wildcard "*" rule, gated by its own
// global-scope-only derived-role condition) AND a perm-arm mirror (`perm_user_read`, checking
// `attr.perms` for "core.user.read" at global-or-company scope) — exactly the shape IAM-SEC-06 exists
// to close.
const live = !!process.env.CERBOS_URL;

describe.skipIf(!TEST_URL || !live)("IAM-SEC-06 · LIVE CERBOS — platform_admin@company is DENIED end-to-end", () => {
  let companyLive: string;
  let platformAdminLiveId: string;

  beforeAll(async () => {
    await initTestDb();
    companyLive = await createCompany("IAM-SEC-06 Cerbos-live Co");
    const roleId = await createRole("platform_admin");
    platformAdminLiveId = await createUser("iam-sec-06-cerbos-live-platform-admin@test.local");
    await grantRole(platformAdminLiveId, roleId, "company", companyLive);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("the REAL assemblePrincipal() resolves zero perms for this grant (repeats the acceptance criterion, DB-verified)", async () => {
    const p = await assemblePrincipal(platformAdminLiveId, "high");
    expect(p!.perms).toEqual([]);
  });

  it("Cerbos DENIES 'read' on kind=user for this principal (perm-arm cannot fire: perms is empty; role-arm cannot fire: platform_admin's condition requires global scope, not company)", async () => {
    const p = await assemblePrincipal(platformAdminLiveId, "high");
    p!.companies = [companyLive]; // authorized-tenant set (normally populated via company_memberships; irrelevant here since we're proving DENY regardless)
    const decision = await check(p!, { kind: "user", tenantId: companyLive }, "read");
    expect(decision.allow, JSON.stringify(decision)).toBe(false);
  });
});
