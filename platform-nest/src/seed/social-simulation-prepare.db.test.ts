// SCP-Sb / SCP-Sa2 — the prepare script against REAL Postgres (needs DATABASE_URL_TEST: NOT run on the dev laptop, runs on the
// Linux CI gate; a skip is not a pass). The rules themselves are `social-simulation-prepare.test.ts`.
//
// SCP-Sa2 (owner ruling SCP-D9): the simulator runs beside real accounts, so real accounts and real grants no longer block.
// What blocks is a row breaking the account-kind rule or a grant on a simulated account. Migration 202610280100 makes both
// impossible to write, so this file plays a database the migration has not reached: it drops social_accounts_kind_ck and
// the grant trigger IN ITS OWN per-file database (initTestDb gives every file its own) to plant those rows.
//
// Proves, on rows the CP-21 seed's shape and on rows it is not:
//   (P1) the DRY RUN finds the markable CP-21 rows (soft-deleted included), counts the real accounts without listing them as
//        blocking, lists the rows breaking the kind rule and the grants on simulated accounts, and WRITES NOTHING;
//   (P2) `--apply` marks exactly the MOCK SEED rows (live and soft-deleted), writing `simulated:<network>` with the mark in
//        the same statement, and nothing else: real rows and grants stay as they were, nothing is deleted; an activity row;
//   (P3) it is idempotent (a second apply marks nothing); a company holding only seed rows and real rows is clean (nothing
//        blocks), and the planted rows are exactly what still blocks;
//   (P4) the company's reads go through the third wall: the counts equal what the superuser sees (the RLS zero-row trap).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";
import { storeOAuthGrant, revokeOAuthGrant } from "../modules/social/publisher/oauth-tokens";
import { CP21_API_KEY_REF, cp21PostizOrgId, prepare, renderReport } from "./social-simulation-prepare";

const MODULES = { modules: ["social"] };

describe.skipIf(!TEST_URL)("SCP-Sb / SCP-Sa2 · social-simulation-prepare on real rows", () => {
  let dirty: string; // seed rows, real rows AND the rows that break the kind rule
  let clean: string; // only seed rows and real rows
  const ids: Record<string, string> = {};
  const before = { key: config.integrationTokenKey };

  async function addAccount(tenant: string, label: string, o: {
    clientName: string; orgKeyRef?: string; orgIdOf?: (clientId: string) => string; integration?: string | null; deleted?: boolean;
    network?: string; simulated?: boolean;
  }): Promise<{ accountId: string; clientId: string }> {
    const clientId = await createClient(tenant, o.clientName);
    const orgId = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1, $2, $3, 'postiz', $4, $5, 'active', 'central')`,
      [orgId, tenant, clientId, (o.orgIdOf ?? cp21PostizOrgId)(clientId), o.orgKeyRef ?? CP21_API_KEY_REF],
    ), MODULES);
    const accountId = newId();
    await withTenants([tenant], (c) => c.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, display_name, postiz_integration_id, status, connected_at, origin_site, simulated, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'connected', now(), 'central', $8, $9)`,
      [accountId, tenant, clientId, orgId, o.network ?? "instagram", `@${label}`, o.integration ?? null, o.simulated ?? false, o.deleted ? new Date() : null],
    ), MODULES);
    ids[label] = accountId;
    return { accountId, clientId };
  }

  const snapshot = async (): Promise<unknown[]> =>
    (await adminPool().query(
      `SELECT id, simulated, status, handle, publisher_org_id, postiz_integration_id, deleted_at, updated_at FROM social_accounts WHERE tenant_id = ANY($1::uuid[]) ORDER BY id`,
      [[dirty, clean]],
    )).rows;

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    dirty = await createCompany("SCPSb Prep Dirty", ["social"]);
    clean = await createCompany("SCPSb Prep Clean", ["social"]);

    // CP-21 shaped: markable.
    await addAccount(dirty, "seed-live", { clientName: "Seed Live Co" });
    await addAccount(dirty, "seed-deleted", { clientName: "Seed Deleted Co", deleted: true, network: "facebook" });
    // REAL (stay real; allowed beside the simulator since SCP-D9): a real-looking org, an engine integration id, a trace of a
    // grant, publishing history, a live grant.
    await addAccount(dirty, "real-org", { clientName: "Real Org Co", orgKeyRef: "default", orgIdOf: (c) => `org-${c}` });
    await addAccount(dirty, "integrated", { clientName: "Integrated Co", integration: "ig_1234" });
    const revoked = await addAccount(dirty, "was-granted", { clientName: "Granted Co", network: "linkedin" });
    await withTenants([dirty], async (c) => {
      await storeOAuthGrant(c, { tenantId: dirty, accountId: revoked.accountId, network: "linkedin", accessToken: "mock-access", expiresAt: new Date(Date.now() + 3600_000) });
      await revokeOAuthGrant(c, revoked.accountId, "SCP-Sb test");
    }, MODULES);
    const published = await addAccount(dirty, "published", { clientName: "Published Co" });
    await withTenants([dirty], async (c) => {
      const engagementId = newId();
      const postId = newId();
      await c.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1, $2, $3, 'Published Co engagement', 'active')`, [engagementId, dirty, published.clientId]);
      await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title) VALUES ($1, $2, $3, 'Recorded by hand')`, [postId, dirty, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, native_import, status, published_at) VALUES ($1, $2, $3, $4, 'x', true, 'published', now())`,
        [newId(), dirty, postId, published.accountId],
      );
    }, MODULES);
    const live = await addAccount(dirty, "live-grant", { clientName: "Live Grant Co", network: "linkedin", orgKeyRef: "default", orgIdOf: (c) => `org-${c}` });
    await withTenants([dirty], (c) => storeOAuthGrant(c, { tenantId: dirty, accountId: live.accountId, network: "linkedin", accessToken: "mock-access", expiresAt: new Date(Date.now() + 3600_000) }), MODULES);
    // Already simulated (valid): not markable, not real, not blocking.
    await addAccount(dirty, "already-sim", { clientName: "Already Sim Co", simulated: true, integration: "simulated:instagram" });

    // A database the migration has not reached: plant a simulated row with no integration id, a real row with a simulated
    // id, and a grant on a simulated account. Only this file's database is touched.
    await adminPool().query(`ALTER TABLE social_accounts DROP CONSTRAINT social_accounts_kind_ck`);
    await adminPool().query(`ALTER TABLE social_oauth_tokens DISABLE TRIGGER trg_social_oauth_tokens_real_account_only`);
    await addAccount(dirty, "sim-no-id", { clientName: "Legacy Sim Co", simulated: true, integration: null, deleted: true });
    await addAccount(dirty, "real-sim-id", { clientName: "Mixed Real Co", integration: "simulated:facebook", network: "facebook" });
    const granted = await addAccount(dirty, "sim-granted", { clientName: "Sim Granted Co", simulated: true, integration: "simulated:linkedin", network: "linkedin" });
    await withTenants([dirty], (c) => storeOAuthGrant(c, { tenantId: dirty, accountId: granted.accountId, network: "linkedin", accessToken: "mock-access", expiresAt: new Date(Date.now() + 3600_000) }), MODULES);

    // The clean company: seed rows and a real row.
    await addAccount(clean, "clean-live", { clientName: "Clean Live Co" });
    await addAccount(clean, "clean-deleted", { clientName: "Clean Deleted Co", deleted: true });
    await addAccount(clean, "clean-real", { clientName: "Clean Real Co", integration: "ig_9", orgKeyRef: "default", orgIdOf: (c) => `org-${c}` });
  });
  afterAll(async () => {
    config.integrationTokenKey = before.key;
    await teardownTestDb();
  });

  it("(P1) the dry run finds the markable rows, COUNTS the real ones, lists only kind-rule breaks and grants on simulated accounts, and writes nothing", async () => {
    const before = await snapshot();
    const r = await prepare({ apply: false, onlyTenantIds: [dirty, clean] });
    expect(await snapshot()).toEqual(before);
    const d = r.tenants.find((t) => t.tenantId === dirty)!;
    expect(d.markable.map((a) => a.id).sort()).toEqual([ids["seed-live"], ids["seed-deleted"]].sort());
    expect(d.markable.find((a) => a.id === ids["seed-deleted"])!.deleted).toBe(true); // soft-deleted rows are found, and flagged
    // real-org, integrated, was-granted, published, live-grant and the planted real-sim-id: real accounts, counted.
    expect(d.realAccounts).toBe(6);
    expect(d.kindViolations.map((v) => v.id).sort()).toEqual([ids["sim-no-id"], ids["real-sim-id"]].sort());
    expect(d.simulatedGrants).toHaveLength(1);
    expect(d.simulatedGrants[0]).toMatchObject({ accountId: ids["sim-granted"], clientName: "Sim Granted Co", network: "linkedin", status: "active" });
    // SCP-Sa2: the live grant on the REAL LinkedIn account is not listed at all.
    expect(d.simulatedGrants.some((g) => g.accountId === ids["live-grant"])).toBe(false);
    expect(r.blockingAccounts).toBe(2);
    expect(r.blockingGrants).toBe(1);
    const text = renderReport(r).join("\n");
    expect(text).toContain(ids["seed-live"]);
    expect(text).toMatch(/KIND RULE BROKEN/);
    expect(text).not.toContain("Real Org Co");
    expect(text).toMatch(/BOOT WOULD STILL REFUSE/);
    expect(r.totalMarked).toBe(0);
  });

  it("(P2) --apply marks exactly the mock seed rows with their simulated:<network> id; real rows, planted rows and grants are untouched", async () => {
    const beforeRows = await snapshot() as Array<{ id: string; simulated: boolean; postiz_integration_id: string | null }>;
    const grantsBefore = (await adminPool().query(`SELECT id, status FROM social_oauth_tokens WHERE tenant_id = $1 ORDER BY id`, [dirty])).rows;
    const r = await prepare({ apply: true, onlyTenantIds: [dirty, clean] });
    expect(r.totalMarked).toBe(4); // two in each company
    const after = await snapshot() as Array<{ id: string; simulated: boolean; status: string; handle: string; deleted_at: unknown; postiz_integration_id: string | null }>;
    expect(after).toHaveLength(beforeRows.length); // nothing deleted, nothing added
    const marked = new Set([ids["seed-live"], ids["seed-deleted"], ids["clean-live"], ids["clean-deleted"]]);
    for (const row of after) {
      const was = beforeRows.find((b) => b.id === row.id)!;
      if (marked.has(row.id)) {
        expect(row.simulated, row.id).toBe(true);
        expect(row.postiz_integration_id, row.id).toMatch(/^simulated:(instagram|facebook)$/);
      } else {
        expect(row.simulated, row.id).toBe(was.simulated);
        expect(row.postiz_integration_id, row.id).toBe(was.postiz_integration_id);
      }
    }
    expect(after.find((x) => x.id === ids["seed-deleted"])!).toMatchObject({ postiz_integration_id: "simulated:facebook" });
    expect(after.find((x) => x.id === ids["seed-deleted"])!.deleted_at).not.toBeNull();
    expect(after.find((x) => x.id === ids["seed-live"])!).toMatchObject({ status: "connected", handle: "@seed-live" });
    expect((await adminPool().query(`SELECT id, status FROM social_oauth_tokens WHERE tenant_id = $1 ORDER BY id`, [dirty])).rows).toEqual(grantsBefore);
    const act = await withTenants([dirty], (c) => c.query(`SELECT metadata FROM activities WHERE verb = 'marked_simulated'`));
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0].metadata).toMatchObject({ script: "social-simulation-prepare", rule: "cp21_seed_fingerprint" });
  });

  it("(P3) it is idempotent; the clean company blocks nothing though it holds a real account; the planted rows are what still blocks", async () => {
    const again = await prepare({ apply: true, onlyTenantIds: [dirty, clean] });
    expect(again.totalMarkable).toBe(0);
    expect(again.totalMarked).toBe(0);
    const c = again.tenants.find((t) => t.tenantId === clean)!;
    expect(c).toMatchObject({ markable: [], realAccounts: 1, kindViolations: [], simulatedGrants: [] });
    expect(again.blockingAccounts).toBe(2);
    expect(again.blockingGrants).toBe(1);
  });

  it("(P4) a company is read through its own wall: the script's counts equal the superuser's", async () => {
    const su = (await adminPool().query<{ v: number; g: number; sim: number }>(
      `SELECT (SELECT count(*)::int FROM social_accounts a WHERE a.tenant_id = $1
                 AND ((a.simulated AND (a.postiz_integration_id IS NULL OR a.postiz_integration_id NOT LIKE 'simulated:%' OR a.connected_by IS NOT NULL))
                   OR (NOT a.simulated AND a.postiz_integration_id LIKE 'simulated:%'))) AS v,
              (SELECT count(*)::int FROM social_oauth_tokens t JOIN social_accounts a ON a.id = t.account_id WHERE t.tenant_id = $1 AND a.simulated) AS g,
              (SELECT count(*)::int FROM social_accounts WHERE tenant_id = $1 AND simulated = false) AS sim`,
      [dirty],
    )).rows[0];
    const r = await prepare({ apply: false, onlyTenantIds: [dirty] });
    expect(r.tenants[0].kindViolations).toHaveLength(su.v);
    expect(r.tenants[0].simulatedGrants).toHaveLength(su.g);
    expect(r.tenants[0].realAccounts + r.tenants[0].markable.length).toBe(su.sim);
    expect(su.v).toBeGreaterThan(0);
  });
});
