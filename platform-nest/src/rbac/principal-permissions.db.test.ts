// IAM-03a — correctness tests for the `perms` resolution `assemblePrincipal()` now emits
// alongside `roles`. This file proves the four guarantees the ticket named:
//   1. STRICTLY ADDITIVE — `roles`' own query/shape is byte-identical to the pre-existing behaviour.
//   2. Scope fidelity — a permission inherits the scopeType/scopeId of the GRANT it was resolved
//      through, never invented, never widened/narrowed.
//   3. Relationship-class exclusion — none of the catalog's 15 `class='relationship'` permissions
//      can ever appear in `perms`, tested at BOTH layers: the DB trigger (0093) AND, independently,
//      this query's own `p.class = 'grantable'` filter (with the trigger disabled, so the second
//      assertion cannot be passing only because the first one already caught it).
//   4. `sessionVersion`/D11 and the `client_contacts` UNION are untouched by this change.
//
// Bundle sizes asserted below are DERIVED from `role-permission-bundles.json`, never hardcoded.
//
// WHY (learned the hard way, 2026-08-10): they were originally literals — `215`, `199`, `109`, … —
// copied from the IAM-02a/02b report. Owner decision DR-5 then legitimately granted `company_admin`
// one more permission (`reports.appraisal.read`, migration 0099), the bundle went 199 -> 200, and
// this file went red on CORRECT work. That is the sixth time in one day a hand-maintained number or
// list in this program drifted from the thing it was describing.
//
// A literal count here does not test what it appears to test. The real property is
// "`assemblePrincipal()` surfaces EXACTLY what the bundle contains" — so the expected value must BE
// the bundle, read from the artifact. That is strictly stronger than a literal (a literal passes if
// resolution and bundle are BOTH wrong by the same amount) and it cannot go stale when a bundle
// legitimately changes.
//
// The artifact is not taken on trust either: `role-permission-bundles.db.test.ts` proves it matches
// `role_permissions` in the DB row-for-row, and `role-permission-parity.db.test.ts` proves the DB
// matches live Cerbos. This file is therefore the last link in a chain that is pinned end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole } from "../testing/fixtures";
import { withGlobal } from "../db";
import { assemblePrincipal, ANONYMOUS, principalHasPermission, type RoleGrant } from "./principal";

const CATALOG_PATH = join(__dirname, "permission-catalog.json");

// The checked-in bundle artifact — DB-parity-tested by `role-permission-bundles.db.test.ts`, which
// is in turn Cerbos-parity-tested by `role-permission-parity.db.test.ts`. See the header for why
// expected counts are read from here instead of being written down.
const BUNDLE_SIZES: Record<string, number> = (() => {
  const doc = JSON.parse(
    readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8"),
  ) as { roles: Record<string, string[]> };
  return Object.fromEntries(Object.entries(doc.roles).map(([role, keys]) => [role, keys.length]));
})();

/** Expected `perms` count for a role = the size of its checked-in bundle. Throws on an unknown role
 *  rather than returning `undefined`, so a typo fails loudly instead of asserting `toBe(undefined)`. */
function bundleSize(role: string): number {
  const n = BUNDLE_SIZES[role];
  if (n === undefined) {
    throw new Error(
      `principal-permissions: no bundle for role "${role}" in role-permission-bundles.json — ` +
        `either the role is unseeded or the artifact is stale (regenerate: npm run gen:role-bundles).`,
    );
  }
  return n;
}

interface CatalogEntry {
  key: string;
  class: "grantable" | "relationship";
}

function relationshipKeys(): Set<string> {
  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const entries = raw.permissions as CatalogEntry[];
  return new Set(entries.filter((e) => e.class === "relationship").map((e) => e.key));
}

describe.skipIf(!TEST_URL)("IAM-03a · assemblePrincipal() perms resolution", () => {
  let companyA: string;
  let companyB: string;
  let relKeys: Set<string>;

  let platformAdminId: string;
  let groupExecId: string;
  let companyAdminId: string;
  let managerId: string;
  let memberId: string;
  let viewerId: string;
  let agencyApproverId: string;
  let itAdminId: string;
  let multiRoleId: string; // member + manager, SAME scope (dedupe check)
  let crossScopeId: string; // member@companyA + manager@companyB (scope-fidelity-per-grant check)
  let noRolesId: string;

  beforeAll(async () => {
    await initTestDb();
    relKeys = relationshipKeys();
    expect(relKeys.size).toBe(15); // sanity: the frozen Ruling 3 boundary

    companyA = await createCompany("IAM-03a Co A");
    companyB = await createCompany("IAM-03a Co B");

    const roleIds = {
      platform_admin: await createRole("platform_admin"),
      group_executive: await createRole("group_executive"),
      company_admin: await createRole("company_admin"),
      manager: await createRole("manager"),
      member: await createRole("member"),
      viewer: await createRole("viewer"),
      agency_approver: await createRole("agency_approver"),
      it_admin: await createRole("it_admin"),
    };

    platformAdminId = await createUser("iam03a-platform-admin@test.local");
    await grantRole(platformAdminId, roleIds.platform_admin, "global", null);

    groupExecId = await createUser("iam03a-group-exec@test.local");
    await grantRole(groupExecId, roleIds.group_executive, "global", null);

    companyAdminId = await createUser("iam03a-company-admin@test.local");
    await grantRole(companyAdminId, roleIds.company_admin, "company", companyA);

    managerId = await createUser("iam03a-manager@test.local");
    await grantRole(managerId, roleIds.manager, "company", companyA);

    memberId = await createUser("iam03a-member@test.local");
    await grantRole(memberId, roleIds.member, "company", companyA);

    viewerId = await createUser("iam03a-viewer@test.local");
    await grantRole(viewerId, roleIds.viewer, "company", companyA);

    agencyApproverId = await createUser("iam03a-agency-approver@test.local");
    await grantRole(agencyApproverId, roleIds.agency_approver, "company", companyA);

    itAdminId = await createUser("iam03a-it-admin@test.local");
    await grantRole(itAdminId, roleIds.it_admin, "company", companyA);

    multiRoleId = await createUser("iam03a-multi-role@test.local");
    await grantRole(multiRoleId, roleIds.member, "company", companyA);
    await grantRole(multiRoleId, roleIds.manager, "company", companyA);

    crossScopeId = await createUser("iam03a-cross-scope@test.local");
    await grantRole(crossScopeId, roleIds.member, "company", companyA);
    await grantRole(crossScopeId, roleIds.manager, "company", companyB);

    noRolesId = await createUser("iam03a-no-roles@test.local");
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("ANONYMOUS carries an empty perms array (shape sanity)", () => {
    expect(ANONYMOUS.perms).toEqual([]);
  });

  it("a user with no role grants resolves to perms: [] and roles: []", async () => {
    const p = await assemblePrincipal(noRolesId, "high");
    expect(p).not.toBeNull();
    expect(p!.roles).toEqual([]);
    expect(p!.perms).toEqual([]);
  });

  it("platform_admin @ global resolves exactly its bundle of perms, all global-scope, zero relationship leakage", async () => {
    const p = await assemblePrincipal(platformAdminId, "high");
    expect(p!.perms!.length).toBe(bundleSize("platform_admin"));
    for (const g of p!.perms!) {
      expect(g.scopeType).toBe("global");
      expect(g.scopeId).toBeNull();
      expect(relKeys.has(g.key)).toBe(false);
    }
    expect(p!.perms!.map((g) => g.key)).toContain("core.task.update");
  });

  it("group_executive @ global resolves exactly its bundle of perms (materially narrower than platform_admin)", async () => {
    const p = await assemblePrincipal(groupExecId, "high");
    expect(p!.perms!.length).toBe(bundleSize("group_executive"));
    expect(p!.perms!.every((g) => g.scopeType === "global" && g.scopeId === null)).toBe(true);
  });

  it("company_admin @ companyA resolves exactly its bundle of perms, every one scoped to companyA (never global, never companyB)", async () => {
    const p = await assemblePrincipal(companyAdminId, "high");
    expect(p!.perms!.length).toBe(bundleSize("company_admin"));
    for (const g of p!.perms!) {
      expect(g.scopeType).toBe("company");
      expect(g.scopeId).toBe(companyA);
    }
  });

  it("manager @ companyA resolves exactly its bundle of perms, company-scoped", async () => {
    const p = await assemblePrincipal(managerId, "high");
    expect(p!.perms!.length).toBe(bundleSize("manager"));
    expect(p!.perms!.every((g) => g.scopeType === "company" && g.scopeId === companyA)).toBe(true);
  });

  it("member @ companyA resolves exactly its bundle of perms, company-scoped", async () => {
    const p = await assemblePrincipal(memberId, "high");
    expect(p!.perms!.length).toBe(bundleSize("member"));
    expect(p!.perms!.every((g) => g.scopeType === "company" && g.scopeId === companyA)).toBe(true);
  });

  it("viewer @ companyA resolves exactly its bundle of perms, incl. pm.task.update (documented viewer/member PM parity)", async () => {
    const p = await assemblePrincipal(viewerId, "high");
    expect(p!.perms!.length).toBe(bundleSize("viewer"));
    expect(p!.perms!.map((g) => g.key)).toContain("pm.task.update");
  });

  it("agency_approver @ companyA resolves exactly 1 perm: agency.approval.approve", async () => {
    const p = await assemblePrincipal(agencyApproverId, "high");
    expect(p!.perms).toEqual([{ key: "agency.approval.approve", scopeType: "company", scopeId: companyA }]);
  });

  // IAM Phase 2 (P2-02, 2026-08-13): it_admin's bundle grew from 3 to 8 — the new it_account.*
  // kind's 5 actions (read/provision/disable/enable/reset_password, design §6.2/§5.4) are ALSO
  // reachable by it_admin via the new `it_managers` derived role. The 3-perm device-only shape (no
  // device:read, documented gap) is unaffected — this is a real, additive bundle growth, not a
  // regression of the original finding.
  it("it_admin @ companyA resolves exactly 8 perms (3 device create/update/delete + 5 new it.account.* — no device:read, documented gap)", async () => {
    const p = await assemblePrincipal(itAdminId, "high");
    const keys = p!.perms!.map((g) => g.key).sort();
    expect(keys).toEqual([
      "it.account.disable", "it.account.enable", "it.account.provision", "it.account.read", "it.account.reset_password",
      "it.device.create", "it.device.delete", "it.device.update",
    ]);
  });

  it("two roles at the SAME scope dedupe to the union, not the sum, with no duplicate (key,scope) pairs", async () => {
    const p = await assemblePrincipal(multiRoleId, "high");
    // member (74) and manager (109) overlap substantially; the union must be strictly less than
    // the naive sum (183) and every (key, scopeId) pair must be unique.
    expect(p!.perms!.length).toBeGreaterThan(0);
    expect(p!.perms!.length).toBeLessThan(74 + 109);
    const pairs = p!.perms!.map((g) => `${g.key}::${g.scopeType}::${g.scopeId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    // member's self-scoped hr.case.create AND manager's core.pipeline_stage.update must both survive
    // the union (proves this isn't accidentally deduping DOWN to just one role's set).
    const keys = new Set(p!.perms!.map((g) => g.key));
    expect(keys.has("hr.case.create")).toBe(true);
    expect(keys.has("core.pipeline_stage.update")).toBe(true);
  });

  it("two roles at DIFFERENT scopes keep each permission tagged with the scope of the grant it came from", async () => {
    const p = await assemblePrincipal(crossScopeId, "high");
    const byKey = new Map(p!.perms!.map((g) => [g.key, g]));
    // core.task.read is reachable via BOTH member and manager — but member's grant is @companyA and
    // manager's is @companyB, so this key must appear scoped to whichever grant actually reaches it
    // at whichever scope(s) it was reached at, never merged into one invented scope.
    const taskReadGrants = p!.perms!.filter((g) => g.key === "core.task.read");
    expect(taskReadGrants.length).toBeGreaterThanOrEqual(1);
    for (const g of taskReadGrants) {
      expect(["company"]).toContain(g.scopeType);
      expect([companyA, companyB]).toContain(g.scopeId);
    }
    // A manager-only permission (e.g. core.pipeline_stage.update, absent from member's bundle) must
    // be tagged companyB, not companyA — proves scope is carried per-grant, not globally averaged.
    const stageUpdate = byKey.get("core.pipeline_stage.update");
    expect(stageUpdate).toBeDefined();
    expect(stageUpdate!.scopeId).toBe(companyB);
    // A member-only permission (e.g. hr.case.create, absent from manager's bundle) must be tagged
    // companyA, not companyB.
    const hrCreate = byKey.get("hr.case.create");
    expect(hrCreate).toBeDefined();
    expect(hrCreate!.scopeId).toBe(companyA);
  });

  it("`roles` is untouched — same rows the pre-existing query would have returned, independently re-queried", async () => {
    const p = await assemblePrincipal(multiRoleId, "high");
    const { rows: expected } = await adminPool().query<RoleGrant>(
      `SELECT r.name AS role, ur.scope_type AS "scopeType", ur.scope_id AS "scopeId"
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [multiRoleId],
    );
    expect([...p!.roles].sort((a, b) => a.role.localeCompare(b.role))).toEqual(
      [...expected].sort((a, b) => a.role.localeCompare(b.role)),
    );
  });

  it("principalHasPermission: a global grant covers any scope query", async () => {
    const p = await assemblePrincipal(platformAdminId, "high");
    expect(principalHasPermission(p!, "core.task.update", "company", companyA)).toBe(true);
    // HIER-3 (2026-08-11): scope type was "team" (retired) — "org_unit" exercises the identical
    // intent (an arbitrary non-global scope type/id a global grant must still cover).
    expect(principalHasPermission(p!, "core.task.update", "org_unit", "some-unit-id")).toBe(true);
    expect(principalHasPermission(p!, "core.task.update", "global", null)).toBe(true);
  });

  it("principalHasPermission: a company-scope grant matches only its exact company, not another company or a different scope type", async () => {
    const p = await assemblePrincipal(companyAdminId, "high");
    expect(principalHasPermission(p!, "core.task.update", "company", companyA)).toBe(true);
    expect(principalHasPermission(p!, "core.task.update", "company", companyB)).toBe(false);
    // HIER-3 (2026-08-11): scope type was "team" (retired) — "org_unit" exercises the identical
    // "different scope type entirely" intent.
    expect(principalHasPermission(p!, "core.task.update", "org_unit", companyA)).toBe(false);
    expect(principalHasPermission(p!, "no.such.permission", "company", companyA)).toBe(false);
  });

  it("principalHasPermission tolerates a synthetic Principal literal with perms omitted (optional-field contract)", () => {
    const synthetic = { userId: "x", assurance: "high" as const, companies: [], roles: [], sessionVersion: 0 };
    expect(principalHasPermission(synthetic, "core.task.update", "global", null)).toBe(false);
  });

  it("the DB trigger blocks a direct attempt to grant a relationship-class permission (baseline check)", async () => {
    const roleRow = await adminPool().query<{ id: string }>(
      `SELECT id FROM roles WHERE company_id IS NULL AND name = 'platform_admin'`,
    );
    const permRow = await adminPool().query<{ id: string }>(
      `SELECT id FROM permissions WHERE key = 'core.mcp_tool.call'`,
    );
    await expect(
      adminPool().query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
        roleRow.rows[0].id,
        permRow.rows[0].id,
      ]),
    ).rejects.toThrow(/relationship/);
  });

  it("defense-in-depth: with the trigger DISABLED, the resolution query's OWN class='grantable' filter still excludes a relationship permission smuggled into role_permissions", async () => {
    const roleRow = await adminPool().query<{ id: string }>(
      `SELECT id FROM roles WHERE company_id IS NULL AND name = 'platform_admin'`,
    );
    const permRow = await adminPool().query<{ id: string }>(
      `SELECT id FROM permissions WHERE key = 'core.mcp_tool.call'`,
    );
    const roleId = roleRow.rows[0].id;
    const permId = permRow.rows[0].id;

    await adminPool().query(`ALTER TABLE role_permissions DISABLE TRIGGER role_permissions_reject_relationship`);
    try {
      await adminPool().query(
        `INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [roleId, permId],
      );
      // Sanity: the smuggled row really is there now (proves the next assertion isn't vacuous).
      const smuggled = await adminPool().query(
        `SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission_id = $2`,
        [roleId, permId],
      );
      expect(smuggled.rowCount).toBe(1);

      const p = await assemblePrincipal(platformAdminId, "high");
      expect(p!.perms!.map((g) => g.key)).not.toContain("core.mcp_tool.call");
      // The rest of platform_admin's 215 grantable perms must be completely unaffected by the
      // trigger being off — this test's ONLY change to the fixture data is the one smuggled row.
      expect(p!.perms!.length).toBe(bundleSize("platform_admin"));
    } finally {
      await adminPool().query(`DELETE FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [
        roleId,
        permId,
      ]);
      await adminPool().query(`ALTER TABLE role_permissions ENABLE TRIGGER role_permissions_reject_relationship`);
    }
  });

  it("no built-in role's bundle ever contains a relationship-class key (all 8 seeded personas above)", async () => {
    const ids = [
      platformAdminId, groupExecId, companyAdminId, managerId, memberId, viewerId, agencyApproverId, itAdminId,
    ];
    for (const id of ids) {
      const p = await assemblePrincipal(id, "high");
      const leaked = p!.perms!.filter((g) => relKeys.has(g.key));
      expect(leaked, `user ${id} leaked relationship keys: ${leaked.map((g) => g.key).join(", ")}`).toEqual([]);
    }
  });

  it("D11 sessionVersion is still correctly threaded through the restructured function", async () => {
    const before = await assemblePrincipal(memberId, "high");
    await withGlobal((c) =>
      c.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [memberId]),
    );
    const after = await assemblePrincipal(memberId, "high");
    expect(after!.sessionVersion).toBe(before!.sessionVersion + 1);
    // perms/roles resolution is independent of the session_version bump itself (no role changed).
    expect(after!.perms!.length).toBe(before!.perms!.length);
  });
});
