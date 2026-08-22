// The `Sanur Resort` -> `Viceroy Bali` rename, tested against a database that ALREADY HAS the old
// name — which is the only shape where it matters.
//
// ⚠ WHY THIS SUITE EXISTS: EVERY OTHER TEST MISSED THIS. `testing/setup.ts` gives each test file a
// fresh database, so the seed always created the resort from nothing and the corrected name was
// simply the name. Nine suites were green while the live estate still said `Sanur Resort`, and
// re-running `seed:agency` there would have FORKED the resort rather than renamed it —
// `ensureCompany()` resolves by name, finds no `Viceroy Bali`, and inserts a second company.
//
// It was found by listing the live companies before running the seed, not by a test. So the test is
// written the way the discovery happened: seed the OLD state first, then assert the migration
// converges it. A fresh-DB assertion would pass with the migration deleted.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The migration is executed DIRECTLY rather than through `migrate()`. The harness repoints the app
// pool at `platform_app_test` (NOSUPERUSER NOBYPASSRLS) on purpose, so `migrate()` from a test hits
// "permission denied for schema public" — it is not the app role's job to run DDL. `adminPool()` is
// the superuser connection the harness keeps for exactly this, and running the file's own SQL is a
// closer test anyway: it asserts what ships, not what a runner wraps around it.
const RENAME_SQL = readFileSync(
  join(__dirname, "../../migrations/202608230612_rename_sanur_resort_to_viceroy_bali.sql"),
  "utf8",
);
const applyRename = () => adminPool().query(RENAME_SQL);

const OLD = "Sanur Resort";
const NEW = "Viceroy Bali";

async function names(): Promise<string[]> {
  const { rows } = await adminPool().query<{ name: string }>(
    `SELECT name FROM companies WHERE name IN ($1, $2) AND deleted_at IS NULL ORDER BY name`,
    [OLD, NEW],
  );
  return rows.map((r) => r.name);
}

describe.skipIf(!TEST_URL)("the Sanur Resort -> Viceroy Bali rename, on a database that already has the old name", () => {
  beforeAll(async () => {
    await initTestDb();
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 renames in place — the id, the children and the history survive", async () => {
    // Reconstruct the production shape by hand: a holding with a resort under the OLD name, and a
    // child hanging off it so "in place" means something. Inserted directly rather than via the seed,
    // because the seed can no longer produce this state — that is the whole problem.
    const pool = adminPool();
    const holding = (
      await pool.query<{ id: string }>(
        `INSERT INTO companies (id, name, type, origin_site) VALUES (gen_random_uuid(), 'Rename Holding', 'holding', 'test') RETURNING id`,
      )
    ).rows[0].id;
    const resort = (
      await pool.query<{ id: string }>(
        `INSERT INTO companies (id, name, type, parent_company_id, origin_site)
         VALUES (gen_random_uuid(), $1, 'resort', $2, 'test') RETURNING id`,
        [OLD, holding],
      )
    ).rows[0].id;
    const venue = (
      await pool.query<{ id: string }>(
        `INSERT INTO companies (id, name, type, parent_company_id, origin_site)
         VALUES (gen_random_uuid(), 'A Venue Under It', 'restaurant', $1, 'test') RETURNING id`,
        [resort],
      )
    ).rows[0].id;

    expect(await names()).toEqual([OLD]);

    await applyRename();

    expect(await names(), "the old name must be gone and the new one present — not both").toEqual([NEW]);

    // IN PLACE is the actual claim. A fork would also satisfy "Viceroy Bali exists".
    const after = await pool.query<{ id: string; parent_company_id: string }>(
      `SELECT id, parent_company_id FROM companies WHERE name = $1`,
      [NEW],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].id, "a NEW id means the seed forked the company instead of renaming it").toBe(resort);
    expect(after.rows[0].parent_company_id).toBe(holding);

    const child = await pool.query<{ parent_company_id: string }>(
      `SELECT parent_company_id FROM companies WHERE id = $1`,
      [venue],
    );
    expect(child.rows[0].parent_company_id, "the venue must still hang off the SAME row").toBe(resort);
  });

  it("is idempotent — a second run is a no-op, not an error", async () => {
    await applyRename();
    expect(await names()).toEqual([NEW]);
  });
});
