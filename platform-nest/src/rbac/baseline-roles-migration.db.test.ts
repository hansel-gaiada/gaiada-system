// IAM-02e — regression guard for the gap IAM-02d flagged but deliberately did not fix:
// `manager`/`member`/`company_admin`/`platform_admin`/`group_executive`/`it_admin` used to be
// provisioned ONLY by the manual `npm run seed:agency` script (`src/seed/agency.ts`'s
// `createRole()` calls), never by any migration. `role-catalog-drift.db.test.ts` (IAM-02d) even
// names this exact set as `SEED_SCRIPT_ONLY_ROLES` and excludes it from its own checks, with a
// comment recording it as "a separate, pre-existing gap ... not this ticket's defect". This is a
// NEW, separate test file rather than an edit to that one, per IAM-02e's own instruction — that
// file belongs to a landed ticket and editing it risks stepping on concurrent IAM work.
//
// This suite proves the opposite invariant IAM-02d's exclusion documented as missing: a database
// that has ONLY ever run migrations (`initTestDb()` — migrate() only, no seed script) must still
// come up with all six baseline roles grantable, so a fresh deployment / disaster-recovery
// restore / new multi-site node is usable without anyone remembering to run demo-data.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createRole } from "../testing/fixtures";

// IAM-15 (2026-08-23) removed `group_executive` from this list. It was migration-seeded as a baseline
// role, and D-7 deletes it — so a later migration drops the row and asserting its presence here would
// pin the exact state the removal exists to prevent. The absence is pinned explicitly below rather
// than just dropped from the list, because a silently shorter list is how a baseline role goes missing
// by accident (which is the failure IAM-02e wrote this file to catch in the first place).
const BASELINE_ROLES = [
  "member",
  "manager",
  "company_admin",
  "platform_admin",
  "it_admin",
] as const;

describe.skipIf(!TEST_URL)("IAM-02e · baseline roles are migration-seeded, not seed-script-only", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("every baseline role exists as a global row immediately after migrate() — no seed script run", async () => {
    const { rows } = await adminPool().query<{ name: string }>(
      `SELECT name FROM roles WHERE company_id IS NULL AND name = ANY($1)`,
      [BASELINE_ROLES],
    );
    const found = new Set(rows.map((r) => r.name));
    const missing = BASELINE_ROLES.filter((n) => !found.has(n));
    expect(
      missing,
      `A migrations-only database (no seed:agency run) is missing these baseline roles — nobody ` +
        `could ever be granted them on a fresh deployment / DR restore / new multi-site node: ` +
        `${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("🔴 IAM-15 — `group_executive` is NOT present after migrate(), despite being seeded by an earlier migration", async () => {
    // It IS still created by its original baseline migration; a later one deletes it. So this asserts
    // migration ORDERING as much as the removal — if the drop ever landed before the seed, or was
    // reverted, the role would quietly exist again on every fresh database and DR restore.
    const { rows } = await adminPool().query<{ name: string }>(
      `SELECT name FROM roles WHERE name = 'group_executive'`,
    );
    expect(
      rows,
      "group_executive exists on a migrations-only database — IAM-15's drop either did not run or an " +
        "earlier migration re-created it after the drop",
    ).toEqual([]);
  });

  it("each baseline role is exactly one global row (0073's partial unique index still holds)", async () => {
    const { rows } = await adminPool().query<{ name: string; n: string }>(
      `SELECT name, count(*)::text AS n FROM roles
       WHERE company_id IS NULL AND name = ANY($1)
       GROUP BY name`,
      [BASELINE_ROLES],
    );
    const dupes = rows.filter((r) => Number(r.n) !== 1).map((r) => `${r.name}(${r.n})`);
    expect(
      dupes,
      `Baseline role(s) exist as more than one global row — the exact 0073 defect ` +
        `(UNIQUE (company_id, name) never constraining NULL company_id) reproduced for the ` +
        `six this migration seeds: ${dupes.join(", ")}`,
    ).toEqual([]);
  });

  it("re-running the seed script's createRole() afterwards adopts the migrated row, no duplicate created", async () => {
    // Mirrors what `seedAgency()` actually does at runtime: call createRole() for each baseline
    // name on a database that 0095 already seeded. If this ever created a second global row per
    // name, `seed:agency` would silently reintroduce the pre-0073 "ten identical manager options
    // in the assign-role picker" defect the moment it runs against a migration-seeded database.
    const idsBefore = await adminPool().query<{ id: string; name: string }>(
      `SELECT id, name FROM roles WHERE company_id IS NULL AND name = ANY($1)`,
      [BASELINE_ROLES],
    );
    const idByName = new Map(idsBefore.rows.map((r) => [r.name, r.id]));

    for (const name of BASELINE_ROLES) {
      const adoptedId = await createRole(name);
      expect(adoptedId, `createRole("${name}") should adopt the migration-seeded row, not mint a new one`)
        .toEqual(idByName.get(name));
    }

    const { rows: after } = await adminPool().query<{ name: string; n: string }>(
      `SELECT name, count(*)::text AS n FROM roles
       WHERE company_id IS NULL AND name = ANY($1)
       GROUP BY name`,
      [BASELINE_ROLES],
    );
    const dupes = after.filter((r) => Number(r.n) !== 1).map((r) => `${r.name}(${r.n})`);
    expect(dupes, `createRole() re-run created a duplicate global row: ${dupes.join(", ")}`).toEqual([]);
  });
});
