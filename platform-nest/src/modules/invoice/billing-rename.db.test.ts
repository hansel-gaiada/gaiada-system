// The `billing` -> `invoice` rename, tested against a database that ACTUALLY HAS THE OLD NAMES.
//
// ★ THIS IS THE WHOLE POINT OF THIS FILE. Every other suite runs against a fresh database built
// from the migration template, where the rename migration finds nothing to rename and its own
// completion check passes trivially. Delete the migration and all of them still go green — the new
// name is simply the name a fresh database was created with.
//
// That is the seed-rename trap in platform-nest/CLAUDE.md, one layer down. It has shipped here
// before (`Sanur Resort` -> `Viceroy Bali`), and the failure mode is silent: rename the module in
// code without moving the stored key and `isModuleEnabled(tenant, 'invoice')` finds nothing, the
// guard denies, and the invoices page goes empty for every company that had it — with no error
// logged anywhere, because "the module is off" is a legitimate state.
//
// So this plants the OLD state and replays the migration over it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withGlobal } from "../../db";
import { initTestDb, teardownTestDb, adminPool } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { newId } from "../../db";

const MIGRATION = join(__dirname, "../../../migrations/202608261030_rename_billing_module_to_invoice.sql");

describe("billing -> invoice rename, replayed over the old state", () => {
  let company = "";
  let roleId = "";
  let permId = "";

  beforeAll(async () => {
    await initTestDb();
    company = await createCompany("Rename Fixture Co", ["agency", "clients"]);

    await withGlobal(async (c) => {
      // Plant the pre-rename world: a company with the module on under its OLD key, an old-style
      // permission row, and a role holding it. The grant is what must survive.
      await c.query(
        `UPDATE companies SET enabled_modules = array_append(enabled_modules, 'billing') WHERE id = $1`,
        [company],
      );
      // ⚠ The template database this suite copies has ALREADY had the rename applied, so
      // `invoice.read` exists and `billing.invoice.read` does not — the mirror image of the live
      // estate. Simply inserting the old key would leave BOTH present, and replaying the migration
      // would then collide on `permissions_key_key` — a failure invented by the fixture, not a
      // defect in the migration. So the renamed row is removed first, which is what makes this
      // database an honest stand-in for one that has never seen the rename.
      await c.query(`DELETE FROM permissions WHERE key = 'invoice.read'`);
      permId = newId();
      await c.query(`INSERT INTO permissions (id, key, description) VALUES ($1,'billing.invoice.read','View invoices')`, [permId]);
      roleId = newId();
      await c.query(`INSERT INTO roles (id, company_id, name) VALUES ($1,$2,'rename_fixture_role')`, [roleId, company]);
      await c.query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1,$2)`, [roleId, permId]);
    });
  });

  afterAll(teardownTestDb);

  it("moves the stored module key, the permission key, and KEEPS the grant", async () => {
    // Replayed through the ADMIN pool, not `withGlobal`. Migrations run as the owner/migrator; the
    // app role is deliberately NOSUPERUSER and cannot DISABLE TRIGGER, so replaying it as the app
    // would fail with "must be owner of table service_assignments" — which is the privilege
    // separation working, not a defect. It does mean the migration REQUIRES ownership of
    // service_assignments to apply; the migrator has it because it created the table.
    await adminPool().query(readFileSync(MIGRATION, "utf8"));

    await withGlobal(async (c) => {
      const co = await c.query<{ mods: string[] }>(
        `SELECT enabled_modules AS mods FROM companies WHERE id = $1`, [company],
      );
      expect(co.rows[0].mods).toContain("invoice");
      expect(co.rows[0].mods).not.toContain("billing");
      // The other modules are untouched — `array_replace` must not have rewritten the whole array.
      expect(co.rows[0].mods).toEqual(expect.arrayContaining(["agency", "clients"]));

      // ★ The grant survives because the row was UPDATEd, not deleted and re-inserted.
      // role_permissions keys off permission_id, and it cascades on delete — a
      // delete-then-insert would have stripped this capability from every role holding it and
      // reported nothing. On the live estate that is 17 rows across the baseline roles.
      const perm = await c.query<{ key: string }>(`SELECT key FROM permissions WHERE id = $1`, [permId]);
      expect(perm.rows[0].key).toBe("invoice.read");

      const grant = await c.query(
        `SELECT 1 FROM role_permissions WHERE role_id = $1 AND permission_id = $2`, [roleId, permId],
      );
      expect(grant.rowCount, "the role must still hold the renamed permission").toBe(1);

      // The permission id is stable too, so anything holding a reference to it still resolves.
      const byKey = await c.query<{ id: string }>(`SELECT id FROM permissions WHERE key = 'invoice.read'`);
      expect(byKey.rows[0].id).toBe(permId);
    });
  });

  it("is idempotent — a second application changes nothing and still passes its own check", async () => {
    // Migrations are applied once by the runner, but this one is a pure rename and a re-run must be
    // harmless: a half-applied state (some rows moved, the connection dropped) has to be
    // recoverable by running it again rather than by hand.
    await expect(adminPool().query(readFileSync(MIGRATION, "utf8"))).resolves.toBeDefined();

    await withGlobal(async (c) => {
      const left = await c.query<{ n: string }>(`SELECT count(*) n FROM permissions WHERE key LIKE 'billing.%'`);
      expect(Number(left.rows[0].n)).toBe(0);
    });
  });

  it("re-enables the service_assignments immutability trigger it had to disable", async () => {
    // The migration disables the USER triggers on service_assignments to move `module_key`, which is
    // immutable by design. If it failed to turn them back on, the guard would be silently gone for
    // every later write — a far worse outcome than the rename it was disabled for.
    await withGlobal(async (c) => {
      const r = await c.query<{ tgname: string; tgenabled: string }>(
        `SELECT tgname, tgenabled FROM pg_trigger
          WHERE tgrelid = 'service_assignments'::regclass AND NOT tgisinternal`,
      );
      expect(r.rows.length, "service_assignments should still have its guard triggers").toBeGreaterThan(0);
      for (const t of r.rows) {
        expect(t.tgenabled, `trigger ${t.tgname} must be enabled`).toBe("O");
      }
    });
  });
});
