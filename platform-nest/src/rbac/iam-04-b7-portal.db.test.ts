// IAM-04-B7 — live-Cerbos + real-DB proofs for `portal`'s permission arm, retried after IAM-SEC-06
// closed the hazard that blocked it in IAM-04-B6. See
// docs/superpowers/plans/2026-08-13-iam-04-b7-report.md for the full account and the verbatim curl
// probes run against a freshly-restarted `gaiada-test-cerbos` alongside these.
//
// TWO INDEPENDENT PROOFS, deliberately kept apart:
//
//   SECTION 1 (live Cerbos only, no DB) — does the WIRED MIRROR ITSELF grant/deny correctly, given a
//   `Principal.perms` array built directly? Same technique `cerbos-permission-dual-match.test.ts`
//   uses for pm_task/hr_case: `roles: []` so the ROLE arm cannot possibly be the one firing — if any
//   of these regress to DENY, the permission arm broke; if any unexpectedly ALLOW, it over-granted.
//   This does NOT claim any real role currently produces this `perms` shape via `role_permissions`
//   (today only `client`'s own bundle does, seed-only data, migration-gated) — it proves the MIRROR's
//   own logic, independent of how `perms` came to be populated.
//
//   SECTION 2 (real DB + live Cerbos, the actual acceptance criterion) — the FULL pipe: a real
//   `user_roles` grant row -> the REAL `assemblePrincipal()` (IAM-SEC-06's filter included) -> the
//   REAL `principalPayload()`/`check()` -> a REAL Cerbos decision. This is what proves the specific
//   hazard IAM-04-B6 named ("a mis-scoped `client@global` grant resolves `client`'s bundle at global
//   scope, which a flat `perm_portal_*` mirror would then honour") is actually closed end-to-end, not
//   just closed in the unit sense Section 1 checks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { check, type Resource } from "./cerbos";
import { assemblePrincipal } from "./principal";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole, addMembership, createClient } from "../testing/fixtures";
import { withTenants, newId } from "../db";
import { config } from "../config";

const live = !!process.env.CERBOS_URL;
const T1 = "bbbbbbbb-0000-0000-0000-000000000001";
const T2 = "bbbbbbbb-0000-0000-0000-000000000002";
const PORTAL_ACTIONS = ["read", "decide", "sign", "pay", "update_profile", "request_change", "approve_post"] as const;

// MON-00i: `rootCompanies` defaults to `companies` (single-root fixture world) now that
// `resource_portal.yaml`'s role-arm rule and all 7 `perm_portal_*` mirrors carry `&& variables.
// inRoot`. Omitting it would default to `[]` via `cerbos.ts`'s `?? []`, which denies every ALLOW
// case below for a reason that has nothing to do with what each test actually means to exercise.
function principal(
  roles: RoleGrant[],
  perms: PermissionGrant[],
  companies: string[] = [T1],
  rootCompanies: string[] = companies,
): Principal {
  return { userId: "u1", assurance: "high", companies, roles, perms, rootCompanies, sessionVersion: 1 };
}

const portalResource = (tenantId: string): Resource => ({ kind: "portal", id: "p-1", tenantId });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SECTION 1 — the wired mirror's own behaviour, isolated from how `perms` gets populated.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!live)("IAM-04-B7 · portal permission arm ALONE (roles: [] — role arm cannot be firing)", () => {
  it.each(PORTAL_ACTIONS)("PERMISSION ARM ALONE grants %s in the resource's own tenant", async (action) => {
    const p = principal([], [{ key: `portal.${action}`, scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, portalResource(T1), action)).toBe(true);
  });

  it.each(PORTAL_ACTIONS)("PERMISSION ARM ALONE denies %s cross-tenant (scopeId mismatch)", async (action) => {
    const p = principal([], [{ key: `portal.${action}`, scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, portalResource(T2), action)).toBe(false);
  });

  it("PERMISSION ARM ALONE does not bleed a granted action into a sibling one", async () => {
    const p = principal([], [{ key: "portal.read", scopeType: "company", scopeId: T1 }]);
    expect(await allow(p, portalResource(T1), "read")).toBe(true);
    for (const other of ["decide", "sign", "pay", "update_profile", "request_change", "approve_post"]) {
      expect(await allow(p, portalResource(T1), other), other).toBe(false);
    }
  });

  it("a GLOBAL-SCOPE permission entry does NOT grant portal actions — the mirror faithfully mirrors client's company-only reach, never the generic global-or-company shape", async () => {
    // This is the structural belt-and-suspenders check for the mirror's OWN shape, independent of
    // IAM-SEC-06: even if a `{key:"portal.read", scopeType:"global"}` entry somehow reached Cerbos
    // (which IAM-SEC-06 already prevents for `client` grants — Section 2 below), this mirror
    // wouldn't honour it anyway, because it was deliberately built without a global branch.
    const p = principal([], [{ key: "portal.read", scopeType: "global", scopeId: null }]);
    expect(await allow(p, portalResource(T1), "read")).toBe(false);
    expect(await allow(p, portalResource(T2), "read")).toBe(false);
  });

  it("ROLE ARM identical to before: a real client grant (no perms at all) still gets every action in its own tenant, none cross-tenant", async () => {
    const p = principal([{ role: "client", scopeType: "company", scopeId: T1 }], []);
    for (const action of PORTAL_ACTIONS) {
      expect(await allow(p, portalResource(T1), action), action).toBe(true);
      expect(await allow(p, portalResource(T2), action), action).toBe(false);
    }
  });

  it("a company_admin role grant (no client role, no perms) is denied everywhere on portal — DR-12 unchanged", async () => {
    const p = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }], []);
    for (const action of PORTAL_ACTIONS) {
      expect(await allow(p, portalResource(T1), action), action).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SECTION 2 — the real end-to-end pipe: a real `user_roles` row -> real `assemblePrincipal()`
// (IAM-SEC-06 filter included) -> real `check()` -> real Cerbos. THE acceptance criterion this
// ticket exists to prove: a synthetic `client@global` grant resolves ZERO permissions and is denied
// everywhere, exactly as IAM-04-B6 identified as the hazard that blocked wiring this mirror.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!TEST_URL || !live)("IAM-04-B7 · LIVE CERBOS + real DB — the client@global hazard is closed end-to-end", () => {
  let companyA: string;
  let companyB: string;
  let clientGlobalId: string;
  let clientLegitId: string;
  let clientContactId: string;
  let staffId: string;
  let clientRowId: string;

  beforeAll(async () => {
    await initTestDb();
    companyA = await createCompany("IAM-04-B7 Co A");
    companyB = await createCompany("IAM-04-B7 Co B (rival tenant)");
    const clientRoleId = await createRole("client");
    const companyAdminRoleId = await createRole("company_admin");

    // ── THE hazard grant this ticket must prove is now inert end-to-end ──
    clientGlobalId = await createUser("iam-04-b7-client-global@test.local");
    await grantRole(clientGlobalId, clientRoleId, "global", null);

    // ── Legitimate client, with a REAL client_contacts row so `variables.inTenant` actually holds
    //    (principal.ts's own header: clients are deliberately excluded from company_memberships,
    //    so client_contacts is the only path to a tenant for this role) ──
    clientLegitId = await createUser("iam-04-b7-client-legit@test.local");
    await grantRole(clientLegitId, clientRoleId, "company", companyA);
    clientRowId = await createClient(companyA, "IAM-04-B7 Test Client Co");
    clientContactId = newId();
    await withTenants([companyA], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', $5)`,
        [clientContactId, companyA, clientRowId, clientLegitId, config.originSite],
      ),
    );

    // ── Realistic staff — a real company_admin, real membership, real (portal-free) bundle ──
    staffId = await createUser("iam-04-b7-staff@test.local");
    await addMembership(companyA, staffId);
    await grantRole(staffId, companyAdminRoleId, "company", companyA);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("ACCEPTANCE: the synthetic client@global grant resolves ZERO permissions via the REAL assemblePrincipal()", async () => {
    const p = await assemblePrincipal(clientGlobalId, "high");
    expect(p).not.toBeNull();
    // The grant itself is untouched — still visible in `roles` (IAM-SEC-06 only filters `perms`).
    expect(p!.roles).toEqual([{ role: "client", scopeType: "global", scopeId: null }]);
    expect(p!.perms).toEqual([]);
  });

  it("ACCEPTANCE: that same principal is DENIED every portal action end-to-end (real Cerbos, real payload)", async () => {
    const p = await assemblePrincipal(clientGlobalId, "high");
    for (const action of PORTAL_ACTIONS) {
      const decision = await check(p!, portalResource(companyA), action);
      expect(decision.allow, `${action}: ${JSON.stringify(decision)}`).toBe(false);
    }
  });

  it("REGRESSION CONTROL: a LEGITIMATE client@company grant's reach is byte-identical to before this ticket — ALLOW in own tenant, all 7 actions", async () => {
    const p = await assemblePrincipal(clientLegitId, "high");
    expect(p).not.toBeNull();
    expect(p!.companies).toContain(companyA);
    for (const action of PORTAL_ACTIONS) {
      const decision = await check(p!, portalResource(companyA), action);
      expect(decision.allow, `${action}: ${JSON.stringify(decision)}`).toBe(true);
    }
  });

  it("REGRESSION CONTROL: the SAME legitimate client is DENIED cross-tenant (isolation unchanged)", async () => {
    const p = await assemblePrincipal(clientLegitId, "high");
    const decision = await check(p!, portalResource(companyB), "read");
    expect(decision.allow, JSON.stringify(decision)).toBe(false);
  });

  it("REGRESSION CONTROL: realistic staff (real company_admin bundle, real membership) is DENIED every portal action — DR-12 unchanged, the new mirror grants nothing to a role that never held these keys", async () => {
    const p = await assemblePrincipal(staffId, "high");
    expect(p).not.toBeNull();
    expect(p!.perms!.some((g) => g.key.startsWith("portal.")), "company_admin's real bundle must hold zero portal.* keys").toBe(false);
    for (const action of PORTAL_ACTIONS) {
      const decision = await check(p!, portalResource(companyA), action);
      expect(decision.allow, `${action}: ${JSON.stringify(decision)}`).toBe(false);
    }
  });
});
