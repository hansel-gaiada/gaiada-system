// SCP-Sb — the prepare script against REAL Postgres (needs DATABASE_URL_TEST: NOT run on the dev laptop, runs on the Linux CI gate; a
// skip is not a pass). The rule itself is `social-simulation-prepare.test.ts`.
//
// Proves, on rows the CP-21 seed's shape and on rows it is not:
//   (P1) the DRY RUN lists every non-simulated account (soft-deleted included) and every active grant, with ids and client names,
//        classifies them, and WRITES NOTHING (every row is byte-for-byte what it was);
//   (P2) `--apply` marks exactly the MOCK SEED rows (live and soft-deleted) and nothing else: the unclassified rows and the grants
//        stay as they were, nothing is deleted, no status/handle/org changes; it records an activity row;
//   (P3) it is idempotent (a second apply marks nothing), and a company holding only seed rows comes out clean: the boot's own
//        per-company count (`simulated = false`) reads 0 after;
//   (P4) the company's read goes through the third wall: a company's rows are never read as zero (the RLS zero-row trap).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient } from "../testing/fixtures";
import { storeOAuthGrant, revokeOAuthGrant } from "../modules/social/publisher/oauth-tokens";
import { CP21_API_KEY_REF, cp21PostizOrgId, prepare, renderReport } from "./social-simulation-prepare";

const MODULES = { modules: ["social"] };

describe.skipIf(!TEST_URL)("SCP-Sb · social-simulation-prepare on real rows", () => {
  let dirty: string; // seed rows AND rows it must refuse
  let clean: string; // only seed rows
  const ids: Record<string, string> = {};
  const before = { key: config.integrationTokenKey };

  async function addAccount(tenant: string, label: string, o: {
    clientName: string; orgKeyRef?: string; orgIdOf?: (clientId: string) => string; integration?: string | null; deleted?: boolean; network?: string; simulated?: boolean;
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
  const bootCount = async (tenant: string): Promise<number> =>
    Number((await withTenants([tenant], (c) => c.query<{ n: string }>(`SELECT count(*)::text AS n FROM social_accounts WHERE simulated = false`), MODULES)).rows[0].n);

  beforeAll(async () => {
    await initTestDb();
    config.integrationTokenKey = randomBytes(32).toString("base64");
    dirty = await createCompany("SCPSb Prep Dirty", ["social"]);
    clean = await createCompany("SCPSb Prep Clean", ["social"]);

    // CP-21 shaped: markable.
    await addAccount(dirty, "seed-live", { clientName: "Seed Live Co" });
    await addAccount(dirty, "seed-deleted", { clientName: "Seed Deleted Co", deleted: true, network: "facebook" });
    // Refused: a real-looking org, an engine integration id, a trace of a grant, publishing history.
    await addAccount(dirty, "real-org", { clientName: "Real Org Co", orgKeyRef: "default", orgIdOf: (c) => `org-${c}` });
    await addAccount(dirty, "integrated", { clientName: "Integrated Co", integration: "ig_1234" });
    const revoked = await addAccount(dirty, "was-granted", { clientName: "Granted Co", network: "linkedin" });
    await withTenants([dirty], async (c) => {
      await storeOAuthGrant(c, { tenantId: dirty, accountId: revoked.accountId, network: "linkedin", accessToken: "mock-access", expiresAt: new Date(Date.now() + 3600_000) });
      await revokeOAuthGrant(c, revoked.accountId, "SCP-Sb test");
    }, MODULES);
    const published = await addAccount(dirty, "published", { clientName: "Published Co" });
    // Publishing history: a native import (a post recorded as published by hand) names this account.
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
    // A live grant on a real LinkedIn account: it blocks, and is only ever listed.
    const live = await addAccount(dirty, "live-grant", { clientName: "Live Grant Co", network: "linkedin", orgKeyRef: "default", orgIdOf: (c) => `org-${c}` });
    await withTenants([dirty], (c) => storeOAuthGrant(c, { tenantId: dirty, accountId: live.accountId, network: "linkedin", accessToken: "mock-access", expiresAt: new Date(Date.now() + 3600_000) }), MODULES);
    // Already simulated: not listed at all.
    await addAccount(dirty, "already-sim", { clientName: "Already Sim Co", simulated: true, integration: "simulated:instagram" });

    // The clean company: only seed rows.
    await addAccount(clean, "clean-live", { clientName: "Clean Live Co" });
    await addAccount(clean, "clean-deleted", { clientName: "Clean Deleted Co", deleted: true });
  });
  afterAll(async () => {
    config.integrationTokenKey = before.key;
    await teardownTestDb();
  });

  it("(P1) the dry run classifies every non-simulated row, lists grants with ids and client names, and writes nothing", async () => {
    const before = await snapshot();
    const r = await prepare({ apply: false, onlyTenantIds: [dirty, clean] });
    expect(await snapshot()).toEqual(before);
    const d = r.tenants.find((t) => t.tenantId === dirty)!;
    expect(d.markable.map((a) => a.id).sort()).toEqual([ids["seed-live"], ids["seed-deleted"]].sort());
    const unclassified = d.unclassified.map((u) => u.account.id).sort();
    expect(unclassified).toEqual([ids["real-org"], ids.integrated, ids["was-granted"], ids.published, ids["live-grant"]].sort());
    expect(d.unclassified.find((u) => u.account.id === ids["was-granted"])!.reasons.join(" ")).toMatch(/OAuth grant/);
    expect(d.unclassified.find((u) => u.account.id === ids["real-org"])!.account.clientName).toBe("Real Org Co");
    expect(d.unclassified.some((u) => u.account.id === ids["already-sim"])).toBe(false);
    expect(d.markable.find((a) => a.id === ids["seed-deleted"])!.deleted).toBe(true); // soft-deleted rows are listed, and flagged
    // grants: only the ACTIVE one, with the client's name
    expect(d.grants).toHaveLength(1);
    expect(d.grants[0]).toMatchObject({ accountId: ids["live-grant"], clientName: "Live Grant Co", network: "linkedin" });
    const text = renderReport(r).join("\n");
    expect(text).toContain(ids["seed-live"]);
    expect(text).toContain("Real Org Co");
    expect(text).toMatch(/BOOT WOULD STILL REFUSE/);
    expect(r.totalMarked).toBe(0);
  });

  it("(P2) --apply marks exactly the mock seed rows; everything it cannot classify, and every grant, is untouched; nothing is deleted", async () => {
    const beforeRows = await snapshot() as Array<{ id: string; simulated: boolean }>;
    const grantsBefore = (await adminPool().query(`SELECT id, status FROM social_oauth_tokens WHERE tenant_id = $1 ORDER BY id`, [dirty])).rows;
    const r = await prepare({ apply: true, onlyTenantIds: [dirty, clean] });
    expect(r.totalMarked).toBe(4); // two in each company
    const after = await snapshot() as Array<{ id: string; simulated: boolean; status: string; handle: string; deleted_at: unknown }>;
    expect(after).toHaveLength(beforeRows.length); // nothing deleted, nothing added
    const marked = new Set([ids["seed-live"], ids["seed-deleted"], ids["clean-live"], ids["clean-deleted"]]);
    for (const row of after) {
      const was = beforeRows.find((b) => b.id === row.id)!;
      if (marked.has(row.id)) expect(row.simulated, row.id).toBe(true);
      else expect(row.simulated, row.id).toBe(was.simulated); // unclassified rows keep their mark, whichever it was
    }
    // soft-deleted stays soft-deleted; statuses and handles are as seeded
    expect(after.find((x) => x.id === ids["seed-deleted"])!.deleted_at).not.toBeNull();
    expect(after.find((x) => x.id === ids["seed-live"])!).toMatchObject({ status: "connected", handle: "@seed-live" });
    expect((await adminPool().query(`SELECT id, status FROM social_oauth_tokens WHERE tenant_id = $1 ORDER BY id`, [dirty])).rows).toEqual(grantsBefore);
    const act = await withTenants([dirty], (c) => c.query(`SELECT metadata FROM activities WHERE verb = 'marked_simulated'`));
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0].metadata).toMatchObject({ script: "social-simulation-prepare", rule: "cp21_seed_fingerprint" });
  });

  it("(P3) it is idempotent, and a company with only seed rows is clean by the boot's own count", async () => {
    const again = await prepare({ apply: true, onlyTenantIds: [dirty, clean] });
    expect(again.totalMarkable).toBe(0);
    expect(again.totalMarked).toBe(0);
    expect(await bootCount(clean)).toBe(0);
    expect(again.tenants.find((t) => t.tenantId === clean)).toMatchObject({ markable: [], unclassified: [], grants: [] });
    // the dirty company still blocks: five unclassified accounts and one live grant, named
    expect(await bootCount(dirty)).toBe(5);
    expect(again.blockingAccounts).toBe(5);
    expect(again.blockingGrants).toBe(1);
  });

  it("(P4) a company is read through its own wall: the read finds the rows the superuser sees", async () => {
    const seen = (await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM social_accounts WHERE tenant_id = $1 AND simulated = false`, [dirty])).rows[0].n;
    expect(await bootCount(dirty)).toBe(Number(seen));
    expect(Number(seen)).toBeGreaterThan(0);
  });
});
