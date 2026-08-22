// The real holding backbone (2026-08-22) — owner-supplied, corroborated against public sources.
//
// WHY THIS SUITE EXISTS RATHER THAN TRUSTING THE SEED. `Sanur Resort` sat in the seed as a
// placeholder and was wrong on two counts at once: the resort is VICEROY BALI and it is in UBUD, not
// Sanur. A wrong name is not cosmetic here — `portal-clients.ts` looks companies up BY NAME, so the
// rename silently broke that seed until it was chased down. This pins the shape so the next rename
// fails loudly in one place instead of quietly in several.
//
// It also pins the thing Phase 3 turns on: an `owner` actually exists, holding D-8's role across the
// holding and everything under it. Before this the estate had exactly ONE elevated principal
// (`platform_admin`), which made D-9's two-person rule — 1 superadmin + 1 owner — arithmetically
// unsatisfiable.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { seedAgency } from "./agency";

const HOLDING = "D & A Syrowatka";
const AGENCY = "Gaia Digital Agency";
const RESORT = "Viceroy Bali";
const VENUES = ["Apéritif", "CasCades Restaurant & Bar", "Pinstripe Bar", "Akoya Spa"];
const CATERING = "Bali Catering and Events";

async function company(name: string) {
  const { rows } = await adminPool().query<{ id: string; parent_company_id: string | null; root_company_id: string | null }>(
    `SELECT id, parent_company_id, root_company_id FROM companies WHERE name = $1 AND deleted_at IS NULL`,
    [name],
  );
  return rows[0];
}

describe.skipIf(!TEST_URL)("the D & A Syrowatka holding backbone", () => {
  beforeAll(async () => {
    await initTestDb();
    await seedAgency();
  }, 300_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("seeds the holding with the agency, the resort and catering beneath it", async () => {
    const holding = await company(HOLDING);
    expect(holding, `${HOLDING} was not seeded`).toBeTruthy();
    expect(holding.parent_company_id, "the holding is the root — it has no parent").toBeNull();

    for (const name of [AGENCY, RESORT, CATERING]) {
      const c = await company(name);
      expect(c, `${name} was not seeded`).toBeTruthy();
      expect(c.parent_company_id, `${name} must hang off the holding`).toBe(holding.id);
    }
  });

  it("🔴 the resort is Viceroy Bali — 'Sanur Resort' must not come back", async () => {
    expect(await company("Sanur Resort"), "the placeholder name is back; portal-clients.ts looks companies up BY NAME").toBeUndefined();
    expect(await company(RESORT)).toBeTruthy();
  });

  it("Viceroy's own venues hang off the RESORT, not the holding", async () => {
    const resort = await company(RESORT);
    for (const v of VENUES) {
      const c = await company(v);
      expect(c, `${v} was not seeded`).toBeTruthy();
      // The tree mirrors the business: Apéritif is a restaurant inside Viceroy, not a sibling of it.
      expect(c.parent_company_id, `${v} must sit under ${RESORT}`).toBe(resort.id);
    }
  });

  it("every company shares the holding's ROOT — MON-00a's anchor spans the whole estate", async () => {
    const holding = await company(HOLDING);
    for (const name of [HOLDING, AGENCY, RESORT, CATERING, ...VENUES]) {
      const c = await company(name);
      // A venue two levels down must still resolve to the holding, or `inRoot` splits the estate and
      // the owner is denied on their own businesses.
      expect(c.root_company_id, `${name}'s root must be the holding`).toBe(holding.id);
    }
  });

  it("🔴 Anthony holds `owner` on the holding AND on every company under it", async () => {
    const { rows } = await adminPool().query<{ name: string }>(
      `SELECT c.name
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
         -- user_roles.scope_id is TEXT, not uuid: migration 0100 altered it (0001's uuid is stale)
         -- because org_unit scopes needed a non-uuid form. Hence the cast; without it Postgres
         -- refuses with 'operator does not exist: uuid = text'.
         JOIN companies c ON c.id = ur.scope_id::uuid
        WHERE u.email = 'anthony@gaiada.com' AND r.name = 'owner' AND ur.scope_type = 'company'
        ORDER BY c.name`,
    );
    const held = rows.map((r) => r.name).sort();
    expect(held).toEqual([HOLDING, AGENCY, RESORT, CATERING, ...VENUES].sort());
  });

  it("owner is granted per COMPANY, never globally — a global owner would be a second platform tier", async () => {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE r.name = 'owner' AND ur.scope_type <> 'company'`,
    );
    // D-8 scopes owner to the companies actually owned. A global grant is exactly what D-7 is
    // deleting `group_executive` for.
    expect(Number(rows[0].n)).toBe(0);
  });

  it("his home company is the HOLDING, so his root resolves across the estate", async () => {
    const holding = await company(HOLDING);
    const { rows } = await adminPool().query<{ home_company_id: string | null }>(
      `SELECT home_company_id FROM users WHERE email = 'anthony@gaiada.com'`,
    );
    expect(rows).toHaveLength(1);
    // Without this, `rootCompanies` is empty and every root-gated rule denies him on his own estate —
    // the failure MON-00c's own comment warns about ("policy first, alone, denies every ...").
    expect(rows[0].home_company_id).toBe(holding.id);
  });

  it("platform_admin is still held by the superadmin, and Anthony does NOT hold it", async () => {
    const { rows } = await adminPool().query<{ email: string }>(
      `SELECT u.email
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
        WHERE r.name = 'platform_admin'
        ORDER BY u.email`,
    );
    const emails = rows.map((r) => r.email);
    expect(emails, "the platform tier must still exist — D-6 removed a duplicate NAME, not the role").toContain(
      "hansel@gaiada.com",
    );
    // The two tiers are different axes: platform/system vs business ownership. An owner who is also
    // platform_admin would collapse the distinction D-9's two-person rule depends on.
    expect(emails).not.toContain("anthony@gaiada.com");
  });
});
