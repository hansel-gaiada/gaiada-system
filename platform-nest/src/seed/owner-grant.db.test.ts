// `seed:owner-grant` — makes D-9's two-person appointment satisfiable on an estate that has a
// platform_admin and no owner.
//
// ⚠ THE TEST THAT MATTERS IS THE ARITHMETIC ONE. IAM-16 closed the legacy admin door, so elevated
// appointment now needs one platform_admin AND one owner. Production had 1 and 0 — meaning no
// supported appointment was possible at all. Asserting "the grants exist" is not enough; the suite
// asserts the PAIR is satisfiable, because that is the property the door-closing depends on.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, createRole, grantRole } from "../testing/fixtures";
import { seedOwnerGrant } from "./owner-grant";

const HOLDING = "D & A Syrowatka";
const OWNER_EMAIL = "anthony@gaiada.com";

let holdingId: string;

async function q<T extends object>(sql: string, p: unknown[] = []): Promise<T[]> {
  const { rows } = await adminPool().query<T>(sql, p);
  return rows;
}

describe.skipIf(!TEST_URL)("seed:owner-grant", () => {
  beforeAll(async () => {
    await initTestDb();
    // Reproduce the production shape: a holding, two children, one platform_admin, no owner.
    holdingId = await createCompany(HOLDING, []);
    await createCompany("Gaia Digital Agency", ["agency"], holdingId);
    await createCompany("Viceroy Bali", [], holdingId);
    const su = await createUser("superadmin@og.test");
    await grantRole(su, await createRole("platform_admin"), "global", null);
    await createRole("owner");
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 makes the D-9 pair satisfiable — 1 platform_admin + 1 owner, which is the whole point", async () => {
    const before = await q<{ n: string }>(
      `SELECT count(DISTINCT ur.user_id)::text AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'owner'`,
    );
    expect(Number(before[0].n), "fixture should start with no owner, like production did").toBe(0);

    await seedOwnerGrant();

    const admins = await q<{ n: string }>(
      `SELECT count(DISTINCT ur.user_id)::text AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'platform_admin'`,
    );
    const owners = await q<{ n: string }>(
      `SELECT count(DISTINCT ur.user_id)::text AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'owner'`,
    );
    expect(Number(admins[0].n)).toBeGreaterThanOrEqual(1);
    expect(Number(owners[0].n)).toBeGreaterThanOrEqual(1);
  });

  it("🔴 grants PER COMPANY, never globally — a global owner would be a second platform tier", async () => {
    const global = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'owner' AND ur.scope_type <> 'company'`,
    );
    expect(Number(global[0].n)).toBe(0);

    const names = await q<{ name: string }>(
      `SELECT c.name FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
         JOIN companies c ON c.id = ur.scope_id::uuid
        WHERE u.email = $1 AND r.name = 'owner' ORDER BY c.name`,
      [OWNER_EMAIL],
    );
    expect(names.map((n) => n.name)).toEqual(["D & A Syrowatka", "Gaia Digital Agency", "Viceroy Bali"]);
  });

  it("anchors home_company_id to the HOLDING — without it every root-gated rule denies him", async () => {
    const rows = await q<{ home_company_id: string | null }>(`SELECT home_company_id FROM users WHERE email = $1`, [
      OWNER_EMAIL,
    ]);
    expect(rows[0].home_company_id).toBe(holdingId);
  });

  it("🔴 creates NO companies — the venues and catering are a separate decision", async () => {
    // Owner decision 2026-08-23: grant on what exists, do not add the five other businesses.
    const n = await q<{ n: string }>(`SELECT count(*)::text AS n FROM companies WHERE deleted_at IS NULL`);
    expect(Number(n[0].n), "seed:owner-grant must not create companies").toBe(3);
  });

  it("does NOT give him platform_admin — the two tiers are different axes", async () => {
    const rows = await q<{ email: string }>(
      `SELECT u.email FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
        WHERE r.name = 'platform_admin'`,
    );
    // An owner who also held platform_admin would collapse the very distinction D-9's pair rule
    // depends on — the appointment would then be satisfiable by one person holding both.
    expect(rows.map((r) => r.email)).not.toContain(OWNER_EMAIL);
  });

  it("is idempotent — a second run grants nothing new", async () => {
    const r = await seedOwnerGrant();
    expect(r.granted).toEqual([]);
    expect(r.alreadyHeld.length).toBe(3);
    expect(r.homeCompanySet).toBe(false);
  });

  it("refuses when the holding is absent rather than guessing which company is the root", async () => {
    await adminPool().query(`UPDATE companies SET name = 'Not The Holding' WHERE id = $1`, [holdingId]);
    await expect(seedOwnerGrant()).rejects.toThrow(/Refusing to guess the holding/);
    await adminPool().query(`UPDATE companies SET name = $1 WHERE id = $2`, [HOLDING, holdingId]);
  });
});
