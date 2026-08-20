// P2-04 — the choke point's INVARIANTS, one test per invariant, against a real database.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE CHANGING ANY EXPECTATION HERE
//
// The invariant set is a property of the grant's ORIGIN, and the difference is deliberate,
// designed, and pinned in BOTH directions below — because the dangerous mistake in either
// direction is silent:
//
//   * Applying the `ui` invariants to `legacy_admin` would BREAK LIVE FLOWS. Two existing tests
//     in `global-only-role-scope.test.ts` assert that granting `client @ company` SUCCEEDS
//     through `assignRole` AND through `inviteUser` — and `client`'s bundle is 7 `portal.*` keys,
//     every one `ui_grantable = false`, with `client` itself on the elevated fence. A third
//     asserts `platform_admin @ global` succeeds. Design §6.4 says the legacy surface keeps
//     today's semantics this wave; §6.3.6 says the existing global-scope-guarded admin path
//     REMAINS a door to the elevated tier until IAM-16's two-person appointment flow exists.
//     Convergence is Phase 4's ticket, not a tidy-up.
//
//   * Dropping the `ui` invariants because "nothing calls that origin yet" would hand P2-08 an
//     unenforced guard to discover the hard way. They are enforced and proven here so P2-08
//     inherits a tested choke point instead of writing a fifth hand-copy of one rule.
//
// So: the `legacy_admin` boundary tests below are NOT slack. They are the pin that makes the
// boundary VISIBLE — if someone later "fixes the inconsistency" by tightening the legacy origin,
// these go red and force the conversation instead of quietly breaking onboarding.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, newId } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createRole } from "../testing/fixtures";
import { assertGrantAllowed, insertGrantRow, type GrantSpec } from "./grant-write.service";
import type { PermissionGrant } from "../rbac/principal";

describe.skipIf(!TEST_URL)("P2-04 — GrantWriteService invariants (design §6.3)", () => {
  let tenant: string;
  let otherTenant: string;
  let grantor: string;
  let target: string;
  let managerRole: string;
  let platformAdminRole: string;
  let groupExecRole: string;
  let clientRole: string;
  let portalCarryingRole: string; // synthetic: bundle = { portal.read } — non-ui_grantable
  let twoKeyRole: string; // synthetic: bundle = { core.task.read, core.task.update }

  // ⚠ These two keys MUST NOT be in the global `member` bundle. P2-08 taught the ceiling to subtract
  // the baseline role's bundle from the required set (a bundle records self-service keys that no
  // admin holds, which made `company_admin` unable to grant `member` — see PERMISSION-CONTRACT §12.1).
  // The original fixture used `core.task.read`/`core.task.update`, BOTH of which `member` carries, so
  // after that change the required set was empty and four of the assertions below passed vacuously —
  // they went red, which is exactly how a decorative guard should announce itself. Swapped for two
  // above-baseline keys so this suite still tests the ceiling rather than agreeing with it.
  const KEY_A = "agency.campaign.create";
  const KEY_B = "agency.campaign.delete";

  async function permId(key: string): Promise<string> {
    const { rows } = await withGlobal((c) =>
      c.query<{ id: string }>(`SELECT id FROM permissions WHERE key = $1`, [key]),
    );
    expect(rows, `permission "${key}" not found in the catalog`).toHaveLength(1);
    return rows[0].id;
  }

  async function attach(roleId: string, key: string): Promise<void> {
    const pid = await permId(key);
    await withGlobal((c) =>
      c.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        roleId,
        pid,
      ]),
    );
  }

  /** A grantor who holds `keys` at `scopeType`/`scopeId` — the ceiling's only input. */
  const perms = (keys: string[], scopeType: PermissionGrant["scopeType"], scopeId: string | null): PermissionGrant[] =>
    keys.map((key) => ({ key, scopeType, scopeId }));

  const spec = (over: Partial<GrantSpec>): GrantSpec => ({
    origin: "ui",
    targetUserId: target,
    roleId: managerRole,
    scopeType: "company",
    scopeId: tenant,
    actorUserId: grantor,
    actorPerms: [],
    tenantId: tenant,
    onConflict: "untargeted",
    ...over,
  });

  const check = (over: Partial<GrantSpec>) => withGlobal((c) => assertGrantAllowed(c, spec(over)));

  beforeAll(async () => {
    await initTestDb();
    tenant = await createCompany("P2-04 Invariants Co");
    otherTenant = await createCompany("P2-04 Other Co");
    grantor = await createUser("p204inv-grantor@a.test");
    target = await createUser("p204inv-target@a.test");

    managerRole = await createRole("manager");
    platformAdminRole = await createRole("platform_admin");
    groupExecRole = await createRole("group_executive");
    clientRole = await createRole("client");

    portalCarryingRole = await createRole(`p204-portal-carrier-${newId()}`);
    await attach(portalCarryingRole, "portal.read");

    twoKeyRole = await createRole(`p204-two-key-${newId()}`);
    await attach(twoKeyRole, KEY_A);
    await attach(twoKeyRole, KEY_B);
  });

  afterAll(teardownTestDb);

  // ── INVARIANT 1 — scope validity (existing, §6.3.4) ─────────────────────────────────────────
  describe("scope validity — assertRoleScopeAllowed, the IAM-SEC-02/04/05 guard, unmoved", () => {
    it("refuses platform_admin at company scope", async () => {
      await expect(check({ roleId: platformAdminRole })).rejects.toThrow(/global scope/);
    });

    it("refuses client at global scope (the other direction, IAM-SEC-04)", async () => {
      await expect(
        check({ roleId: clientRole, scopeType: "global", scopeId: null, origin: "legacy_admin" }),
      ).rejects.toThrow(/company scope/);
    });

    it("applies to the legacy origin too — it is the ONE check both origins share", async () => {
      await expect(check({ roleId: platformAdminRole, origin: "legacy_admin" })).rejects.toThrow(/global scope/);
    });

    it("an unknown roleId is a clean 'unknown role' 400, not a crash", async () => {
      await expect(check({ roleId: "11111111-1111-1111-1111-111111111111" })).rejects.toThrow(/unknown role/);
    });
  });

  // ── INVARIANT 2 — self-target (§6.3.5) ──────────────────────────────────────────────────────
  describe("self-target refusal — the mirror of P2-02's structural Cerbos DENY", () => {
    it("refuses when target == actor, on the ui origin", async () => {
      await expect(check({ targetUserId: grantor })).rejects.toThrow(/self_grant_forbidden/);
    });

    it("refuses when target == actor on the LEGACY origin too (design §6.4's one tightening)", async () => {
      await expect(check({ targetUserId: grantor, origin: "legacy_admin" })).rejects.toThrow(
        /self_grant_forbidden/,
      );
    });

    it("does NOT refuse a different target (no over-refusal)", async () => {
      await expect(check({ origin: "legacy_admin" })).resolves.toBeTruthy();
    });
  });

  // ── INVARIANT 3 — the ui_grantable allow-list (§6.3.3 / §7) ─────────────────────────────────
  describe("allow-list — a role carrying a non-ui_grantable key is not attachable from a UI surface", () => {
    it("refuses a role whose bundle carries portal.read", async () => {
      await expect(
        check({ roleId: portalCarryingRole, actorPerms: perms(["portal.read"], "global", null) }),
      ).rejects.toThrow(/not_ui_grantable/);
    });

    it("names the offending key, so the refusal is actionable rather than mysterious", async () => {
      // The grantor is given `portal.read` DELIBERATELY, so the ceiling would pass — otherwise
      // this test passes for the wrong reason (the ceiling's own message also names the missing
      // key, so with the allow-list neutered it stayed green; caught by this ticket's own
      // per-invariant teeth run and tightened here). Now ONLY the allow-list can refuse it.
      await expect(
        check({ roleId: portalCarryingRole, actorPerms: perms(["portal.read"], "global", null) }),
      ).rejects.toThrow(/not_ui_grantable.*portal\.read/s);
    });

    it("BOUNDARY (deliberate): the legacy origin does NOT apply the allow-list — `client` still grants", async () => {
      // This is the pin described in this file's header. `client`'s bundle is entirely
      // non-ui_grantable, and `global-only-role-scope.test.ts` asserts this exact grant succeeds
      // through the live endpoint. If a future change applies the allow-list to `legacy_admin`,
      // this goes red FIRST, with this comment attached, instead of onboarding breaking in prod.
      await expect(check({ roleId: clientRole, origin: "legacy_admin" })).resolves.toBeTruthy();
    });
  });

  // ── INVARIANT 4 — the elevated fence (§6.3.6) ───────────────────────────────────────────────
  describe("elevated fence — no Phase-2 surface mints tier", () => {
    const godPerms = (keys: string[]) => perms(keys, "global", null);

    it("refuses group_executive even at its own valid scope, and even for an all-holding grantor", async () => {
      // group_executive's bundle is entirely ui_grantable, so it clears the allow-list and the
      // ceiling — the fence is provably the thing refusing it, not an earlier check.
      const { rows } = await withGlobal((c) =>
        c.query<{ key: string }>(
          `SELECT p.key FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
          [groupExecRole],
        ),
      );
      await expect(
        check({
          roleId: groupExecRole,
          scopeType: "global",
          scopeId: null,
          actorPerms: godPerms(rows.map((r) => r.key)),
        }),
      ).rejects.toThrow(/elevated_role_forbidden/);
    });

    it("platform_admin is caught by the allow-list BEFORE the fence — two independent layers (design §7)", async () => {
      // Asserted precisely rather than as an OR: platform_admin's wildcard bundle includes the 7
      // `portal.*` keys, so the allow-list refuses it first. That is the design's own claim that
      // each enforcement layer is INDEPENDENTLY sufficient — worth pinning as the specific code,
      // because an OR-assertion here would stay green with either layer deleted.
      await expect(
        check({ roleId: platformAdminRole, scopeType: "global", scopeId: null }),
      ).rejects.toThrow(/not_ui_grantable/);
    });

    it("BOUNDARY (deliberate): the legacy origin is still a door to the elevated tier (§6.3.6)", async () => {
      // Design §6.3.6, verbatim: "the only doors to the elevated tier remain the existing
      // global-scope-guarded admin path and seeds". `global-only-role-scope.test.ts` pins the
      // live endpoint's side of this. Closing it here is IAM-16's ticket, not this one's.
      await expect(
        check({ roleId: platformAdminRole, scopeType: "global", scopeId: null, origin: "legacy_admin" }),
      ).resolves.toBeTruthy();
    });
  });

  // ── INVARIANT 5 — the ceiling (§6.3.2) ──────────────────────────────────────────────────────
  describe("ceiling — nobody grants what they do not hold", () => {
    it("refuses when the grantor holds only PART of the granted role's bundle", async () => {
      await expect(
        check({ roleId: twoKeyRole, actorPerms: perms([KEY_A], "company", tenant) }),
      ).rejects.toThrow(/ceiling_exceeded/);
    });

    it("names the missing key", async () => {
      await expect(
        check({ roleId: twoKeyRole, actorPerms: perms([KEY_A], "company", tenant) }),
      ).rejects.toThrow(new RegExp(KEY_B.replace(/\./g, "\\.")));
    });

    it("allows when the grantor holds the WHOLE bundle at the same company scope", async () => {
      await expect(
        check({ roleId: twoKeyRole, actorPerms: perms([KEY_A, KEY_B], "company", tenant) }),
      ).resolves.toBeTruthy();
    });

    it("a GLOBAL-scope holding reaches a company-scope grant (a platform_admin grantor passes trivially)", async () => {
      await expect(
        check({ roleId: twoKeyRole, actorPerms: perms([KEY_A, KEY_B], "global", null) }),
      ).resolves.toBeTruthy();
    });

    it("a holding at ANOTHER company does NOT reach this tenant's grant", async () => {
      await expect(
        check({ roleId: twoKeyRole, actorPerms: perms([KEY_A, KEY_B], "company", otherTenant) }),
      ).rejects.toThrow(/ceiling_exceeded/);
    });

    it("FAIL-CLOSED: a grantor with no resolved perms at all holds NOTHING, and is refused", async () => {
      await expect(check({ roleId: twoKeyRole, actorPerms: undefined })).rejects.toThrow(/ceiling_exceeded/);
    });

    it("BASELINE ON THE HELD SIDE: a bundle that is baseline-only needs nothing held", async () => {
      // Renamed 2026-08-19: this used to pin P2-08's interim "subtract bundle(member) from the
      // REQUIRED set". The owner ruled for a per-(role, key) self-scoped MARKER instead (0114), and
      // the baseline moved to the HELD side — a grantor is themselves staff, so passing on baseline
      // reach confers nothing new. The observable behaviour this case asserts is unchanged, which is
      // the point: the mechanism was replaced without moving the boundary.
      //
      // The original defect it encodes: `member`'s bundle carries self-service keys no admin holds, so
      // a plain subset test refused `company_admin` granting `member` — the commonest grant in the
      // system. Everything ABOVE baseline still fails closed, which the five cases above assert with
      // above-baseline keys.
      const baselineOnlyRole = await createRole(`p208-baseline-only-${newId()}`);
      await attach(baselineOnlyRole, "core.task.read"); // in the global `member` bundle
      await expect(check({ roleId: baselineOnlyRole, actorPerms: undefined })).resolves.toBeTruthy();
    });

    it("BOUNDARY (deliberate): the legacy origin does NOT apply the ceiling (design §6.4)", async () => {
      await expect(
        check({ roleId: twoKeyRole, actorPerms: [], origin: "legacy_admin" }),
      ).resolves.toBeTruthy();
    });
  });

  // ── the trusted-internal origin ─────────────────────────────────────────────────────────────
  describe("trusted_internal — no caller-choice validation, by design", () => {
    it("skips every invariant (this is what lets the client-portal path grant `client`)", async () => {
      await expect(
        check({ roleId: clientRole, origin: "trusted_internal", actorUserId: null, actorPerms: undefined }),
      ).resolves.toBeNull();
    });
  });

  // ── the write itself ────────────────────────────────────────────────────────────────────────
  describe("insertGrantRow — the guard runs on the WRITE, not only on the caller's early check", () => {
    it("a refused spec writes no row even when assertGrantAllowed was never called separately", async () => {
      const before = await withGlobal((c) =>
        c.query<{ n: string }>(`SELECT count(*)::text AS n FROM user_roles WHERE user_id = $1`, [grantor]),
      );
      await expect(
        withGlobal((c) => insertGrantRow(c, spec({ targetUserId: grantor }))),
      ).rejects.toThrow(/self_grant_forbidden/);
      const after = await withGlobal((c) =>
        c.query<{ n: string }>(`SELECT count(*)::text AS n FROM user_roles WHERE user_id = $1`, [grantor]),
      );
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("an allowed spec writes exactly one row and returns its id", async () => {
      const id = await withGlobal((c) =>
        insertGrantRow(c, spec({ roleId: twoKeyRole, actorPerms: perms([KEY_A, KEY_B], "global", null) })),
      );
      expect(id).toBeTruthy();
      const { rows } = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [
          target,
          twoKeyRole,
        ]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(id);
    });

    it("re-inserting the same (user, role, scope) is a no-op, not a 23505 (both conflict clauses)", async () => {
      const again = await withGlobal((c) =>
        insertGrantRow(c, spec({ roleId: twoKeyRole, actorPerms: perms([KEY_A, KEY_B], "global", null) })),
      );
      expect(again).toBeNull(); // ON CONFLICT DO NOTHING → no RETURNING row
      const targeted = await withGlobal((c) =>
        insertGrantRow(
          c,
          spec({
            roleId: twoKeyRole,
            actorPerms: perms([KEY_A, KEY_B], "global", null),
            onConflict: "unique_columns",
          }),
        ),
      );
      expect(targeted).toBeNull();
    });

    it("managed_by is NULL unless the caller is the reconciler (A1 discipline preserved)", async () => {
      const { rows } = await withGlobal((c) =>
        c.query<{ managed_by: string | null }>(
          `SELECT managed_by FROM user_roles WHERE user_id = $1 AND role_id = $2`,
          [target, twoKeyRole],
        ),
      );
      expect(rows[0].managed_by).toBeNull();
    });
  });
});
