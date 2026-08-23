// The seed first light depends on. What is worth testing here is NOT "does an INSERT insert" but the
// three properties that would silently break a real estate: the module-scope requirement on
// `social_engagements`, true idempotency (re-running must not duplicate OR overwrite), and tenant
// isolation (this seed must never reach across tenants).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import {
  seedOwnBrandSocial, ensureOwnBrandClient, ensureOwnBrandEngagement,
  OWN_BRAND_CLIENT_NAME, OWN_BRAND_ENGAGEMENT_NAME,
} from "./own-brand-social";

const SOCIAL_MODULE = { modules: ["social"] };

describe.skipIf(!TEST_URL)("seed:own-brand-social — the two rows first light needs", () => {
  let A: string;
  let B: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("Own-brand A");
    B = await createCompany("Own-brand B");
  });
  afterAll(async () => { await teardownTestDb(); });

  it("creates exactly one client and one engagement, both findable", async () => {
    const { clientId, engagementId } = await seedOwnBrandSocial(A);
    expect(clientId).toBeTruthy();
    expect(engagementId).toBeTruthy();

    const cl = await withTenants([A], (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM clients WHERE name = $1 AND deleted_at IS NULL`, [OWN_BRAND_CLIENT_NAME]));
    expect(cl.rows[0].n).toBe("1");

    // Read back through the MODULE SCOPE — the same wall the seed had to declare to write it.
    const eng = await withTenants([A], (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM social_engagements WHERE name = $1 AND deleted_at IS NULL`,
      [OWN_BRAND_ENGAGEMENT_NAME]), SOCIAL_MODULE);
    expect(eng.rows[0].n).toBe("1");
  });

  it("IDEMPOTENT: a second run returns the SAME ids and creates no duplicates", async () => {
    const first = await seedOwnBrandSocial(A);
    const second = await seedOwnBrandSocial(A);
    expect(second.clientId).toBe(first.clientId);
    expect(second.engagementId).toBe(first.engagementId);

    const counts = await withTenants([A], (c) => c.query<{ clients: string }>(
      `SELECT count(*)::text AS clients FROM clients WHERE name = $1 AND deleted_at IS NULL`,
      [OWN_BRAND_CLIENT_NAME]));
    expect(counts.rows[0].clients).toBe("1");
  });

  it("NON-DESTRUCTIVE: re-running does not overwrite operator changes to the existing rows", async () => {
    // The property that matters on a real estate. A seed that "ensured" its own field values would
    // silently revert a budget or status someone had deliberately set.
    const { clientId, engagementId } = await seedOwnBrandSocial(A);
    await withTenants([A], (c) => c.query(
      `UPDATE social_engagements SET usage_budget_usd = 999 WHERE id = $1`, [engagementId]), SOCIAL_MODULE);
    await withTenants([A], (c) => c.query(
      `UPDATE clients SET status = 'archived' WHERE id = $1`, [clientId]));

    await seedOwnBrandSocial(A);

    const eng = await withTenants([A], (c) => c.query<{ usage_budget_usd: string }>(
      `SELECT usage_budget_usd FROM social_engagements WHERE id = $1`, [engagementId]), SOCIAL_MODULE);
    expect(Number(eng.rows[0].usage_budget_usd)).toBe(999);
    const cl = await withTenants([A], (c) => c.query<{ status: string }>(
      `SELECT status FROM clients WHERE id = $1`, [clientId]));
    expect(cl.rows[0].status).toBe("archived");
  });

  it("TENANT ISOLATION: seeding tenant B never reuses or touches tenant A's rows", async () => {
    const a = await seedOwnBrandSocial(A);
    const b = await seedOwnBrandSocial(B);
    expect(b.clientId).not.toBe(a.clientId);
    expect(b.engagementId).not.toBe(a.engagementId);

    // Same NAME in both tenants is correct and must not collide — the rows are tenant-scoped.
    const inB = await withTenants([B], (c) => c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM clients WHERE name = $1 AND deleted_at IS NULL`, [OWN_BRAND_CLIENT_NAME]));
    expect(inB.rows[0].n).toBe("1");
  });

  it("the engagement write REQUIRES the social module scope — the third wall is real here", async () => {
    // Not a hypothetical: `social_engagements` carries 0105's `app_module_allowed('social')`, so a
    // caller that forgets the scope reads and writes ZERO rows while RAISING NOTHING. This asserts the
    // wall is actually on the table, so the seed's `SOCIAL_MODULE` argument is load-bearing rather
    // than decorative.
    const { engagementId } = await seedOwnBrandSocial(A);
    const scoped = await withTenants([A], (c) => c.query(
      `SELECT id FROM social_engagements WHERE id = $1`, [engagementId]), SOCIAL_MODULE);
    expect(scoped.rowCount).toBe(1);

    const unscoped = await withTenants([A], (c) => c.query(
      `SELECT id FROM social_engagements WHERE id = $1`, [engagementId])); // no module scope
    expect(unscoped.rowCount).toBe(0); // silently empty, exactly as the wall intends
  });
});
