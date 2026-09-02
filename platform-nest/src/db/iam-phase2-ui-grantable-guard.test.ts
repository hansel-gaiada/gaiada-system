// IAM Phase 2 (P2-03) — the ui_grantable allow-list's DB-layer proofs (migration 0110):
//   (1) permissions.ui_grantable exists, NOT NULL, and matches the catalog's own values exactly
//       (portal.*/relationship-class false; everything else true).
//   (2) `position_roles_guard()`'s DEFERRED clause (b) — a position may not confer a bundle
//       containing a non-ui_grantable permission — with a real attempted-violation, a positive
//       control, and a TEETH proof (drop the trigger, watch the SAME insert succeed, restore it).
//   (3) `assertRoleUiGrantable()` (src/rbac/ui-grantable.ts) — the application-layer helper P2-04's
//       GrantWriteService will call — proven against the SAME two roles clause (2) uses, so the
//       DB trigger and the app-layer helper are shown to agree on the identical case.
//
// This file is DELIBERATELY SEPARATE from src/db/iam-phase2-positions.test.ts (P2-01's own ticket,
// clauses (a)/(c) only) rather than an edit to it — this ticket's remit is clause (b) + the helper,
// and a fresh file avoids any collision with a concurrent P2-01 follow-up in the same checkout.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, withGlobal, newId } from "./index";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createRole } from "../testing/fixtures";
import { assertRoleUiGrantable, nonUiGrantableKeysForRole } from "../rbac/ui-grantable";
import permissionCatalog from "../rbac/permission-catalog.json";

describe.skipIf(!TEST_URL)("IAM Phase 2 (P2-03) — permissions.ui_grantable + position_roles_guard() clause (b)", () => {
  let A: string; // tenant A
  let posId: string;
  let cleanRoleId: string; // holds ONLY grantable, ui_grantable=true permissions
  let dirtyRoleId: string; // holds a ui_grantable=false permission (portal.read)

  async function permId(key: string): Promise<string> {
    const { rows } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM permissions WHERE key = $1`, [key]));
    expect(rows, `permission "${key}" not found`).toHaveLength(1);
    return rows[0].id;
  }

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("P2-03 Tenant A");

    posId = newId();
    await withTenants([A], (c) =>
      c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,'d-web','Test Seat')`, [
        posId,
        A,
      ]),
    );

    // "org_unit_lead" is a real, seeded, machine-checked-scope role — safe against clause (c) at
    // scope_kind='own_unit', and its bundle (post-0110) is entirely ui_grantable=true, so it is the
    // POSITIVE control: attaching it must succeed.
    cleanRoleId = await createRole("org_unit_lead", null);

    // A synthetic, test-only global role — not in the denied-role registry (clause a), not in the
    // scope-shape map (clause c: falls into the ELSE-NULL "unconstrained" branch, so scope_kind=
    // 'company' is always reachable for it) — isolates clause (b) as the ONLY thing that can block
    // attaching it. Its bundle carries exactly one permission: portal.read (grantable,
    // ui_grantable=false post-0110) — the design's own headline hazard case (design §7: "a staff
    // role carrying portal.* would put staff inside the client portal").
    dirtyRoleId = await createRole(`p203-dirty-role-${newId()}`, null);
    const portalReadId = await permId("portal.read");
    await withGlobal((c) =>
      c.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
        dirtyRoleId,
        portalReadId,
      ]),
    );
  });
  afterAll(teardownTestDb);

  // ── (1) permissions.ui_grantable — column shape + exact catalog parity ─────────────────────────
  describe("permissions.ui_grantable column", () => {
    it("exists and is NOT NULL", async () => {
      const { rows } = await withGlobal((c) =>
        c.query<{ is_nullable: string }>(
          `SELECT is_nullable FROM information_schema.columns WHERE table_name='permissions' AND column_name='ui_grantable'`,
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_nullable).toBe("NO");
    });

    it("matches the catalog's own uiGrantable value for EVERY one of the 282 entries (full parity, not a spot sample)", async () => {
      const { rows } = await withGlobal((c) =>
        c.query<{ key: string; ui_grantable: boolean }>(`SELECT key, ui_grantable FROM permissions`),
      );
      const dbByKey = new Map(rows.map((r) => [r.key, r.ui_grantable]));
      const mismatches: string[] = [];
      for (const p of (permissionCatalog as { permissions: { key: string; uiGrantable: boolean }[] }).permissions) {
        const dbVal = dbByKey.get(p.key);
        if (dbVal === undefined) {
          mismatches.push(`${p.key}: missing from DB`);
        } else if (dbVal !== p.uiGrantable) {
          mismatches.push(`${p.key}: catalog=${p.uiGrantable} db=${dbVal}`);
        }
      }
      expect(mismatches, mismatches.join("\n")).toEqual([]);
    });

    // The 22 baseline (15 relationship + 7 portal.*) grew by THREE since this test was written, none
    // of them relationship-class and none portal.*: `webdev.zoneb_event.record` (WSK-12, 2026-08-27
    // — "the only legitimate caller is the wd-zoneb-intake automation identity; granting this to a
    // human would let them inject facts that look like they came from Zone B") and
    // `webdev.provisioned_site.operate`/`.promote` (WSK-31, 2026-08-27 — the §07 WebDesk
    // control-plane MCP tool set's Zone A authz, routed to an honest 501 stub pending WSK-23's Zone B
    // egress client). All three are `class:"grantable"` but deliberately `uiGrantable:false` for a
    // reason narrower than "relationship" or "portal" — a real human role (company_admin/manager/
    // module_manager) DOES hold them via the role arm, they are simply not individually assignable
    // through the role-editor UI yet. 22 -> 25.
    it("exactly 25 rows are ui_grantable=false (15 relationship + 7 portal.* + 3 role-tier-only writes)", async () => {
      const { rows } = await withGlobal((c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM permissions WHERE ui_grantable = false`));
      expect(Number(rows[0].n)).toBe(25);
    });
  });

  // ── (2) position_roles_guard() clause (b) ──────────────────────────────────────────────────────
  describe("position_roles_guard() clause (b) — non-ui_grantable bundle rejection", () => {
    it("POSITIVE CONTROL: attaching a role whose bundle is entirely ui_grantable=true succeeds", async () => {
      const rowId = newId();
      await withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'own_unit')`,
          [rowId, A, posId, cleanRoleId],
        ),
      );
      const { rows } = await withTenants([A], (c) => c.query(`SELECT id FROM position_roles WHERE id=$1`, [rowId]));
      expect(rows).toHaveLength(1);
    });

    it("VIOLATION: attaching a role whose bundle contains portal.read (ui_grantable=false) is rejected", async () => {
      await expect(
        withTenants([A], (c) =>
          c.query(
            `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
            [newId(), A, posId, dirtyRoleId],
          ),
        ),
      ).rejects.toThrow(/non-ui_grantable permission/);
    });

    it("the SAME violation is also rejected on UPDATE (re-pointing an existing row's role_id onto the dirty role)", async () => {
      // A SEPARATE position — the POSITIVE CONTROL test above already inserted
      // (posId, cleanRoleId, 'own_unit'), and ux_position_roles is UNIQUE(position_id, role_id,
      // scope_kind), so reusing posId here would collide on the benign insert, not on this test's
      // own UPDATE. A fresh position isolates the UPDATE-specific behavior being proven.
      const posId2 = newId();
      await withTenants([A], (c) =>
        c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title) VALUES ($1,$2,'d-web','Test Seat 2')`, [
          posId2,
          A,
        ]),
      );
      const rowId = newId();
      await withTenants([A], (c) =>
        c.query(
          `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'own_unit')`,
          [rowId, A, posId2, cleanRoleId],
        ),
      );
      await expect(
        withTenants([A], (c) =>
          c.query(`UPDATE position_roles SET role_id = $1, scope_kind = 'company' WHERE id = $2`, [dirtyRoleId, rowId]),
        ),
      ).rejects.toThrow(/non-ui_grantable permission/);
    });

    it("TEETH: dropping trg_position_roles_guard lets the dirty role through (proves clause (b) — not something else — blocks it)", async () => {
      await adminPool().query(`DROP TRIGGER trg_position_roles_guard ON position_roles`);
      try {
        const rowId = newId();
        const res = await withTenants([A], (c) =>
          c.query(
            `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
            [rowId, A, posId, dirtyRoleId],
          ),
        );
        expect(res.rowCount).toBe(1); // succeeds with the guard gone -> proves the trigger, not RLS/a FK, was blocking it
      } finally {
        await adminPool().query(
          `CREATE TRIGGER trg_position_roles_guard BEFORE INSERT OR UPDATE ON position_roles
           FOR EACH ROW EXECUTE FUNCTION position_roles_guard()`,
        );
      }
    });

    it("RESTORED: re-attempting the identical dirty-role insert after the trigger is restored is rejected again", async () => {
      await expect(
        withTenants([A], (c) =>
          c.query(
            `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
            [newId(), A, posId, dirtyRoleId],
          ),
        ),
      ).rejects.toThrow(/non-ui_grantable permission/);
    });

    it("clauses (a) and (c) are UNCHANGED by this migration's CREATE OR REPLACE (regression: platform_admin still denied by (a))", async () => {
      const platformAdminRoleId = await createRole("platform_admin", null);
      await expect(
        withTenants([A], (c) =>
          c.query(
            `INSERT INTO position_roles (id, tenant_id, position_id, role_id, scope_kind) VALUES ($1,$2,$3,$4,'company')`,
            [newId(), A, posId, platformAdminRoleId],
          ),
        ),
      ).rejects.toThrow(/denied-role registry/);
    });
  });

  // ── (3) assertRoleUiGrantable() — the application-layer helper ────────────────────────────────
  describe("assertRoleUiGrantable() (src/rbac/ui-grantable.ts)", () => {
    it("resolves (no throw) for a role whose bundle is entirely ui_grantable=true", async () => {
      await withGlobal(async (c) => {
        await expect(assertRoleUiGrantable(c, cleanRoleId, "org_unit_lead")).resolves.toBeUndefined();
      });
    });

    it("throws a clean, named error for a role carrying a non-ui_grantable key", async () => {
      await withGlobal(async (c) => {
        await expect(assertRoleUiGrantable(c, dirtyRoleId, "p203-dirty-role")).rejects.toThrow(
          /not_ui_grantable.*portal\.read/,
        );
      });
    });

    it("nonUiGrantableKeysForRole returns [] for the clean role and the exact blocked key for the dirty role", async () => {
      await withGlobal(async (c) => {
        expect(await nonUiGrantableKeysForRole(c, cleanRoleId)).toEqual([]);
        const blocked = await nonUiGrantableKeysForRole(c, dirtyRoleId);
        expect(blocked.map((b) => b.key)).toEqual(["portal.read"]);
      });
    });

    it("a role with NO bundle rows at all is vacuously clean (empty array, not a throw)", async () => {
      const emptyRoleId = await createRole(`p203-empty-role-${newId()}`, null);
      await withGlobal(async (c) => {
        expect(await nonUiGrantableKeysForRole(c, emptyRoleId)).toEqual([]);
        await expect(assertRoleUiGrantable(c, emptyRoleId)).resolves.toBeUndefined();
      });
    });
  });
});
