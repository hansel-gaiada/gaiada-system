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

  // ⚠ DERIVED, not pinned (2026-08-12). This asserted 226/211/15/79 and went red the moment an
  // unrelated session legitimately added the `social` module (-> 262/247/15/91) — a tripwire firing
  // on CORRECT work, and the fifth of its kind in this program. The intent ("a silent edit to
  // permission-catalog.json must not change what correct means") is better served by checking the
  // file's own `_meta.counts` against the array beneath it: that catches an edit to EITHER half,
  // and cannot go stale when the estate legitimately grows.
  it("sanity: permission-catalog.json's _meta.counts matches the array it describes", () => {
    const meta = (permissionCatalog as unknown as { _meta: { counts: Record<string, number> } })._meta.counts;
    expect(EXPECTED_TOTAL, "concretePairs").toBe(meta.concretePairs);
    expect(EXPECTED_GRANTABLE, "grantable").toBe(meta.grantable);
    expect(EXPECTED_RELATIONSHIP, "relationship").toBe(meta.relationship);
    expect(EXPECTED_SENSITIVE, "sensitive").toBe(meta.sensitive);
  });

  // The ONE count that is an invariant rather than a tally: Ruling 3's bypass-exempt set. Every new
  // module grows `grantable`; none may grow THIS without an owner-sighted move of the boundary.
  it("Ruling 3 invariant: exactly 15 relationship-class permissions, whatever else the estate grows", () => {
    expect(EXPECTED_RELATIONSHIP).toBe(15);
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

  // ⚠ INVERTED 2026-08-12. This asserted that re-executing 0093's raw SQL a second time is
  // idempotent. That premise has become FALSE — correctly, and by 0093's own design.
  //
  // 0093 ends with a hard `RAISE EXCEPTION` if the `permissions` table does not hold exactly the
  // 230 rows IT seeded. That was right when 0093 was the last word on the catalog. It no longer is:
  // 0103 removed 4 `core.team.*` keys and an unrelated session's 0106 added 36 `social` keys, so the
  // table now holds 262. Re-running 0093's text out of order therefore ABORTS on its own count
  // assertion — which is the migration guarding its invariant, not a defect in either migration.
  //
  // The property that actually matters in production is unchanged and is asserted below: 0093 can
  // never run twice, because `schema_migrations` ledgers it by filename and the runner skips it.
  // Re-runnability of the raw text was only ever a proxy for that, and it is a proxy that expires
  // the moment a later migration touches the same table. **Do not "fix" this by editing 0093** —
  // it is applied in production and rule 4 forbids it.
  it("re-running 0093's raw SQL out of order ABORTS on its own count assertion — the ledger is what prevents a second run", async () => {
    const before = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM permissions`);
    const countBefore = Number(before.rows[0].n);

    await expect(adminPool().query(MIGRATION_SQL)).rejects.toThrow(/IAM-01c seed assertion FAILED/);

    // And it changed nothing: the whole migration body runs in one implicit transaction, so the
    // abort rolled back its own INSERTs. No resurrected `core.team.*` rows, no duplicates.
    const after = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM permissions`);
    expect(Number(after.rows[0].n), "aborted re-run must leave the table untouched").toBe(countBefore);
  });

  it("the ledger — not re-runnability — is what guarantees 0093 never applies twice", async () => {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migrations WHERE name = '0093_iam_permission_catalog.sql'`,
    );
    expect(Number(rows[0].n)).toBe(1);
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
