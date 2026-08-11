// IAM-01c — regression guard for migration 0093 (`0093_iam_permission_catalog.sql`), which seeds
// the pre-existing, previously zero-consumer `permissions` table from
// `src/rbac/permission-catalog.json` (230 entries = 215 grantable + 15 relationship).
//
// Three things this suite proves, matching the ticket's own acceptance bar:
//   (1) the catalog seeds correctly — exact counts, not "at least" (the RLS-backfill trap this
//       repo has been burned by twice is about a silent ZERO-row match; asserting an exact
//       expected total is the strongest version of "assert, don't assume" available here);
//   (2) the seed is idempotent/re-runnable — re-executing the migration file's own SQL text a
//       second time changes nothing (no duplicate-key error, same counts, same row identity);
//   (3) the 15 relationship-class permissions cannot be granted to a role — the
//       `role_permissions_reject_relationship` trigger the migration installs is exercised
//       directly, both the rejection and the (control) success case for an ordinary grantable
//       permission.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { newId } from "../db";
import permissionCatalog from "./permission-catalog.json";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../migrations/0093_iam_permission_catalog.sql"),
  "utf8",
);

const EXPECTED_TOTAL = permissionCatalog.permissions.length;
const EXPECTED_GRANTABLE = permissionCatalog.permissions.filter((p) => p.class === "grantable").length;
const EXPECTED_RELATIONSHIP = permissionCatalog.permissions.filter((p) => p.class === "relationship").length;
const EXPECTED_SENSITIVE = permissionCatalog.permissions.filter((p) => p.sensitive).length;

describe.skipIf(!TEST_URL)("IAM-01c · permission catalog migration (0093)", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("sanity: the catalog JSON itself is 226/211/15/79 (the numbers this suite asserts against; HIER-3, 2026-08-11: team_lead/team retired, core.team.* (4 grantable, 0 sensitive) dropped from 230/215)", () => {
    // Guards against a future edit to permission-catalog.json silently changing what "correct"
    // means without anyone noticing — these are the ticket's own headline counts.
    expect(EXPECTED_TOTAL).toBe(226);
    expect(EXPECTED_GRANTABLE).toBe(211);
    expect(EXPECTED_RELATIONSHIP).toBe(15);
    expect(EXPECTED_SENSITIVE).toBe(79);
  });

  it("seeds exactly 230 rows (215 grantable + 15 relationship), matching the catalog exactly", async () => {
    const { rows } = await adminPool().query<{ class: string; n: string }>(
      `SELECT class, count(*)::text AS n FROM permissions GROUP BY class ORDER BY class`,
    );
    const byClass = new Map(rows.map((r) => [r.class, Number(r.n)]));
    expect(byClass.get("grantable")).toBe(EXPECTED_GRANTABLE);
    expect(byClass.get("relationship")).toBe(EXPECTED_RELATIONSHIP);
    const { rows: totalRows } = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM permissions`);
    expect(Number(totalRows[0].n)).toBe(EXPECTED_TOTAL);
  });

  it("carries the exact sensitive=true count (79) the catalog assesses", async () => {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM permissions WHERE sensitive = true`,
    );
    expect(Number(rows[0].n)).toBe(EXPECTED_SENSITIVE);
  });

  it("every seeded row's key/module_key/cerbos_kind/cerbos_action/class/sensitive matches the source catalog exactly (spot sample across domains)", async () => {
    const sample = [
      permissionCatalog.permissions.find((p) => p.key === "core.automation_approval.decide"),
      permissionCatalog.permissions.find((p) => p.key === "hr.case.export"),
      permissionCatalog.permissions.find((p) => p.key === "search.property.update"),
      permissionCatalog.permissions.find((p) => p.key === "portal.pay"),
      permissionCatalog.permissions.find((p) => p.key === "core.mcp_tool.call"),
      permissionCatalog.permissions.find((p) => p.key === "assistant.thread.read"),
    ];
    for (const expected of sample) {
      if (!expected) throw new Error("fixture bug: expected key not found in catalog JSON");
      const { rows } = await adminPool().query(
        `SELECT key, module_key, resource, action, cerbos_kind, cerbos_action, class, sensitive
           FROM permissions WHERE key = $1`,
        [expected.key],
      );
      expect(rows, `missing row for ${expected.key}`).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        key: expected.key,
        module_key: expected.domain,
        resource: expected.resource,
        action: expected.action,
        cerbos_kind: expected.cerbosKind,
        cerbos_action: expected.cerbosAction,
        class: expected.class,
        sensitive: expected.sensitive,
      });
    }
  });

  it("the class CHECK constraint rejects anything outside grantable/relationship", async () => {
    await expect(
      adminPool().query(
        `INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive)
         VALUES ($1, 'test.bogus.class', 'test', 'bogus', 'class', 'x', 'bogus', 'class', 'nonsense', false)`,
        [newId()],
      ),
    ).rejects.toThrow(/permissions_class_check/);
  });

  it("re-running the migration's own SQL is idempotent — same row, same counts, no duplicate-key error", async () => {
    // Directly re-executes 0093's SQL text a second time against this test database (bypassing
    // the schema_migrations ledger, which would otherwise just skip it) — this is what proves the
    // FILE ITSELF is safe to run twice, which is the ticket's literal "idempotent and re-runnable"
    // requirement, not merely that the ledger prevents a second run in production.
    const before = await adminPool().query<{ id: string }>(
      `SELECT id FROM permissions WHERE key = 'core.client.read'`,
    );
    expect(before.rows).toHaveLength(1);
    const idBefore = before.rows[0].id;

    await adminPool().query(MIGRATION_SQL);

    // HIER-3 (2026-08-11, migration 0103): 0093 is an already-APPLIED migration and is never
    // edited (rule 4) — its own SQL text still unconditionally `INSERT ... ON CONFLICT (key) DO
    // UPDATE`s all 230 ORIGINAL rows, including the 4 `core.team.*` ones 0103 later DELETEs from
    // this same table (in the same change that deletes `resource_team.yaml`/`teams.controller.ts`
    // /`team_lead`). Re-running 0093's raw text in isolation — which is exactly what this
    // assertion does, bypassing the ledger — therefore RESURRECTS those 4 rows: this is a fact
    // about re-running an old migration's text out of order, not a defect in either migration.
    // `EXPECTED_TOTAL` (226, from the CURRENT catalog.json) is the wrong yardstick for THIS
    // specific re-run; the correct expectation is 0093's own original count, +4 for the
    // resurrection.
    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM permissions`);
    expect(Number(after.rows[0].n)).toBe(EXPECTED_TOTAL + 4);

    // ON CONFLICT (key) DO UPDATE never touches `id` — the second run re-syncs columns onto the
    // SAME row, not a duplicate.
    const afterRow = await adminPool().query<{ id: string }>(
      `SELECT id FROM permissions WHERE key = 'core.client.read'`,
    );
    expect(afterRow.rows).toHaveLength(1);
    expect(afterRow.rows[0].id).toBe(idBefore);

    // Clean up the resurrection so this test doesn't leave the file's DB in a state that
    // contradicts every other test in this suite (which all assume the post-0103 catalog shape).
    await adminPool().query(
      `DELETE FROM permissions WHERE key IN ('core.team.create','core.team.read','core.team.update','core.team.delete')`,
    );
  });

  describe("Ruling 3 enforcement — the 15 relationship permissions can never be granted to a role", () => {
    async function makeGlobalRole(name: string): Promise<string> {
      const id = newId();
      await adminPool().query(`INSERT INTO roles (id, company_id, name) VALUES ($1, NULL, $2)`, [id, name]);
      return id;
    }

    it("INSERT into role_permissions for a class='relationship' permission is rejected by the DB trigger", async () => {
      const roleId = await makeGlobalRole(`iam01c-test-role-rel-${newId()}`);
      const { rows } = await adminPool().query<{ id: string }>(
        `SELECT id FROM permissions WHERE key = 'core.mcp_tool.call' AND class = 'relationship'`,
      );
      expect(rows).toHaveLength(1);
      await expect(
        adminPool().query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
          roleId,
          rows[0].id,
        ]),
      ).rejects.toThrow(/class=relationship/);
    });

    it("every one of the 15 relationship permissions individually rejects a grant attempt", async () => {
      const roleId = await makeGlobalRole(`iam01c-test-role-rel-all-${newId()}`);
      const { rows } = await adminPool().query<{ id: string; key: string }>(
        `SELECT id, key FROM permissions WHERE class = 'relationship'`,
      );
      expect(rows).toHaveLength(15);
      for (const perm of rows) {
        await expect(
          adminPool().query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
            roleId,
            perm.id,
          ]),
          `expected permission "${perm.key}" to be rejected as ungrantable`,
        ).rejects.toThrow(/class=relationship/);
      }
    });

    it("(control) a class='grantable' permission CAN be granted to a role — the trigger only blocks relationship rows", async () => {
      const roleId = await makeGlobalRole(`iam01c-test-role-grantable-${newId()}`);
      const { rows } = await adminPool().query<{ id: string }>(
        `SELECT id FROM permissions WHERE key = 'core.client.read' AND class = 'grantable'`,
      );
      expect(rows).toHaveLength(1);
      await expect(
        adminPool().query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
          roleId,
          rows[0].id,
        ]),
      ).resolves.toBeDefined();
      const granted = await adminPool().query(`SELECT 1 FROM role_permissions WHERE role_id = $1`, [roleId]);
      expect(granted.rows).toHaveLength(1);
    });

    it("UPDATE that repoints an existing grant onto a relationship permission is also rejected (not just INSERT)", async () => {
      const roleId = await makeGlobalRole(`iam01c-test-role-update-${newId()}`);
      const grantable = await adminPool().query<{ id: string }>(
        `SELECT id FROM permissions WHERE key = 'core.client.read'`,
      );
      const relationship = await adminPool().query<{ id: string }>(
        `SELECT id FROM permissions WHERE key = 'core.mcp_tool.call'`,
      );
      await adminPool().query(`INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)`, [
        roleId,
        grantable.rows[0].id,
      ]);
      await expect(
        adminPool().query(
          `UPDATE role_permissions SET permission_id = $1 WHERE role_id = $2 AND permission_id = $3`,
          [relationship.rows[0].id, roleId, grantable.rows[0].id],
        ),
      ).rejects.toThrow(/class=relationship/);
    });
  });
});
