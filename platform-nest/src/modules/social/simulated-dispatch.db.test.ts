// SCP-Sa — the social simulator on the REAL dispatch path, against live Postgres (needs DATABASE_URL_TEST: NOT run on the
// dev laptop, runs on the Linux CI gate; a skip is not a pass). No Nest app, no hub, no Cerbos: the same split
// dispatch.test.ts uses, driving `dispatchApprovedPublish` with a DECIDED, executing approval exactly as the D14 executor
// leaves it, then the status sweep.
//
// Proves:
//   (S1) a simulated account's variant publishes through the simulator: queued, `simulated = true`, the approval stamped,
//        `social.post.dispatched`; and the status sweep moves it to published on https://simulated.invalid/…
//   (S2) `[simulate-fail]` fails through the normal failed-post path (failed, approval consumed, `social.post.failed`).
//   (S3) pictures "upload" to the simulator too (nothing leaves), so an Instagram post with media publishes.
//   (S4) the switch OFF: the same simulated account's variant fails `simulation_disabled` and is NOT marked simulated.
//   (S5) a REAL account under the switch never reaches the simulator: it takes the real path and refuses there.
//   (S6) the simulator's own guard against OUR rows: an account that is not simulated, a variant that is not the handle's
//        account's, an approval that is pending / rejected / names another variant -> refused, nothing minted.
//   (S7) resolveDispatchOrgHandle reads `simulated` itself when a caller's chain omits it (the inbox paths), and refuses
//        what the simulator does not simulate.
//   (S8) boot's DB facts count every tenant through the third wall (equal to the superuser's count: no zero-row trap),
//        a revoked grant is not "live", and the switch ON beside a real account or a live grant aborts wiring.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { seedAutomationAccounts } from "../../seed/automation";
import { setStorageForTest } from "../../core/storage";
import { registerPublisher, resetPublishers, listPublishers } from "./publisher/registry";
import { createSimulatedPublisher, dbSimulatedDispatchGuard } from "./publisher/simulated-driver";
import { SimulatedOrgHandle, SOCIAL_SIMULATION_REFUSAL } from "./publisher/simulation";
import { resolveDispatchOrgHandle } from "./publisher/provisioning";
import { readSocialSimulationDbFacts, wireSocialPublisher, SocialSimulationBootError } from "./publisher/boot";
import { storeOAuthGrant, revokeOAuthGrant } from "./publisher/oauth-tokens";
import { SocialPublisherError } from "./publisher/types";
import { variantPublishArgs, variantArgsSha256 } from "./canonical-args";
import { SOCIAL_PUBLISH_TOOL } from "./publish-precondition";
import { dispatchApprovedPublish, DISPATCH_REFUSAL } from "./dispatch";
import { reconcileTenantPostStatus } from "./post-status-sync-job";

const MODULES = { modules: ["social"] };
let seq = 0;
const uniq = (label: string): string => `scp-sa-${label}-${++seq}`;
const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("SCP-Sa · the social simulator on the real dispatch path", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let orgId: string;
  let simFb: string;
  let simIg: string;
  let realFb: string;
  let igFileId: string;
  const before = {
    flag: config.socialSimulationEnabled,
    networks: config.social.publisher.enabledNetworks,
    key: config.social.publisher.defaultOrgApiKey,
    tokenKey: config.integrationTokenKey,
  };

  async function insertAccount(network: string, simulated: boolean): Promise<string> {
    const id = newId();
    // Test setup writes the mark directly (the static inventory in simulation.test.ts covers src/, not tests); a
    // seeded simulated account carries a self-describing integration id, as `direct`'s accounts do.
    await withTenants([co], (c) => c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, simulated, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'connected','{}',$8,'central')`,
      [id, co, clientId, orgId, network, uniq(`@mock-kopi-senja-${network}`), simulated ? `simulated:${network}` : uniq(network), simulated],
    ), MODULES);
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.social.publisher.enabledNetworks = [...new Set([...before.networks, "instagram", "facebook"])];
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    config.integrationTokenKey = randomBytes(32).toString("base64");
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });

    co = await createCompany("SCP-Sa Mock Agency", ["social"]);
    await seedAutomationAccounts(co);
    wfUser = (await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    )).rows[0].user_id;
    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Mock Client Kopi Senja','central')`, [clientId, co]));
    orgId = newId();
    await withTenants([co], (c) => c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
      [orgId, co, clientId, uniq("org")]), MODULES);
    simFb = await insertAccount("facebook", true);
    simIg = await insertAccount("instagram", true);
    realFb = await insertAccount("facebook", false);

    igFileId = newId();
    const key = `${co}/${igFileId}`;
    mem.set(key, Buffer.from("mock-jpeg-bytes"));
    await withTenants([co], (c) => c.query(
      `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
       VALUES ($1,$2,'client',$3,'mock-photo.jpg','image/jpeg',15,$4,false,'central')`,
      [igFileId, co, clientId, key]));
  });

  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    config.social.publisher.enabledNetworks = before.networks;
    config.social.publisher.defaultOrgApiKey = before.key;
    config.integrationTokenKey = before.tokenKey;
    resetPublishers();
    await teardownTestDb();
  });

  beforeEach(() => {
    config.socialSimulationEnabled = true;
    resetPublishers();
    registerPublisher(createSimulatedPublisher());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function engagement(networks: Record<string, boolean>): Promise<string> {
    const id = newId();
    await withTenants([co], (c) => c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'SCP-Sa engagement','active',$4,10,'central')`,
      [id, co, clientId, JSON.stringify({ networks })]), MODULES);
    return id;
  }

  /** An approved variant on `accountId` plus the D14 row in the state the executor's claim leaves it: DECIDED
   *  (approved, decided_by, decided_at) and `executing`. The hash args match the variant exactly. */
  async function approvedVariantWithDecidedApproval(
    accountId: string, network: string,
    opts: { body?: string; media?: unknown[]; settings?: Record<string, unknown> } = {},
  ): Promise<{ variantId: string; approvalId: string }> {
    const body = opts.body ?? "Kopi Senja opens a second shop (mock)";
    const media = opts.media ?? [];
    const settings = opts.settings ?? {};
    const engagementId = await engagement({ [network]: true });
    const postId = newId();
    const variantId = newId();
    const hash = variantArgsSha256({ tenantId: co, id: variantId, accountId, body, firstComment: null, media, settings, scheduledAt: null });
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1,$2,$3,'SCP-Sa post','approved','central')`,
        [postId, co, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved','central')`,
        [variantId, co, postId, accountId, body, JSON.stringify(media), JSON.stringify(settings), hash]);
    }, MODULES);
    const approvalId = newId();
    const args = variantPublishArgs({ tenantId: co, id: variantId, accountId, body, firstComment: null, media, settings, scheduledAt: null });
    await withTenants([co], (c) => c.query(
      `INSERT INTO automation_approvals
         (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
          origin, origin_site, execution_status)
       VALUES ($1,$2,'wf:delivery',$3,$4,'high','approved',$5,$5,now(),'automation','main','executing')`,
      [approvalId, co, SOCIAL_PUBLISH_TOOL, JSON.stringify(args), wfUser]));
    return { variantId, approvalId };
  }

  async function variantRow(variantId: string) {
    const { rows } = await withTenants([co], (c) => c.query(
      `SELECT status, approval_id AS "approvalId", provider_post_id AS "providerPostId", last_error AS "lastError",
              published_url AS "publishedUrl", published_at AS "publishedAt", simulated
         FROM social_post_variants WHERE id = $1`, [variantId]), MODULES);
    return rows[0];
  }
  const events = async (variantId: string) => (await adminPool().query<{ event_type: string }>(
    `SELECT event_type FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1 ORDER BY created_at`,
    [variantId])).rows.map((r) => r.event_type);

  it("(S1) a simulated account's variant publishes through the simulator, marked, and the sweep makes it live on simulated.invalid", async () => {
    const { variantId, approvalId } = await approvedVariantWithDecidedApproval(simFb, "facebook");
    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.providerPostId).toMatch(/^simulated:facebook:\d+:[0-9a-f-]{36}$/);

    const queued = await variantRow(variantId);
    expect(queued).toMatchObject({ status: "queued", approvalId, providerPostId: verdict.providerPostId, simulated: true });
    expect(await events(variantId)).toContain("social.post.dispatched");

    const sweep = await reconcileTenantPostStatus(co);
    expect(sweep.errors).toBe(0);
    const live = await variantRow(variantId);
    expect(live.status).toBe("published");
    expect(live.publishedUrl).toMatch(/^https:\/\/simulated\.invalid\/facebook\/[0-9a-f-]{36}$/);
    expect(live.publishedAt).not.toBeNull();
    expect(live.simulated).toBe(true);
    expect(await events(variantId)).toContain("social.post.published");
    // Idempotent: a second sweep changes nothing and emits nothing again.
    await reconcileTenantPostStatus(co);
    expect((await events(variantId)).filter((e) => e === "social.post.published")).toHaveLength(1);
  });

  it("(S2) `[simulate-fail]` fails through the normal failed-post path", async () => {
    const { variantId, approvalId } = await approvedVariantWithDecidedApproval(simFb, "facebook", { body: "Grand opening [simulate-fail]" });
    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.publishDispatchFailed });
    const row = await variantRow(variantId);
    expect(row).toMatchObject({ status: "failed", approvalId, providerPostId: null, simulated: true });
    expect(row.lastError).toMatch(/^simulated_publish_failed: /);
    expect(await events(variantId)).toContain("social.post.failed");
  });

  it("(S3) an Instagram post with a picture publishes: the 'upload' goes to the simulator and nothing leaves", async () => {
    const media = [{ fileId: igFileId, kind: "image", alt: "a mock photo", format: "jpeg" }];
    const { variantId } = await approvedVariantWithDecidedApproval(simIg, "instagram", { media, settings: { igType: "feed" } });
    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(verdict.ok).toBe(true);
    const { rows } = await withTenants([co], (c) => c.query(`SELECT uploaded_media FROM social_post_variants WHERE id = $1`, [variantId]), MODULES);
    expect(rows[0].uploaded_media[igFileId].id).toMatch(/^simulated-media:/);
    expect(rows[0].uploaded_media[igFileId].url).toMatch(/^https:\/\/simulated\.invalid\/media\//);
    expect((await variantRow(variantId)).simulated).toBe(true);
  });

  it("(S4) the switch OFF: a simulated account's variant refuses simulation_disabled and is NOT marked simulated", async () => {
    const { variantId } = await approvedVariantWithDecidedApproval(simFb, "facebook");
    config.socialSimulationEnabled = false;
    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(verdict).toMatchObject({ ok: false, stage: "dispatch" });
    const row = await variantRow(variantId);
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain(SOCIAL_SIMULATION_REFUSAL.disabled);
    expect(row.simulated).toBe(false);
  });

  it("(S5) a REAL account under the switch never reaches the simulator: the real path refuses, nothing marked", async () => {
    const { variantId } = await approvedVariantWithDecidedApproval(realFb, "facebook");
    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.publishDispatchFailed });
    const row = await variantRow(variantId);
    expect(row.lastError).toContain("publisher_not_configured");
    expect(row.simulated).toBe(false);
    expect(row.providerPostId).toBeNull();
  });

  it("(S6) the simulator's guard reads OUR rows: wrong account, wrong variant, undecided approval -> refused, nothing minted", async () => {
    const sim = createSimulatedPublisher();
    const code = async (p: Promise<unknown>) => {
      try { await p; } catch (e) { expect(e).toBeInstanceOf(SocialPublisherError); return (e as SocialPublisherError).code; }
      throw new Error("resolved");
    };
    const req = (variantId: string, approvalId: string) => ({
      integrationId: "simulated:facebook", network: "facebook" as const, body: "mock", approvalId, variantId,
    });

    // A variant on a REAL account, even with a decided approval and a simulated handle naming that account.
    const real = await approvedVariantWithDecidedApproval(realFb, "facebook");
    expect(await code(sim.schedulePost(new SimulatedOrgHandle(co, realFb, orgId), req(real.variantId, real.approvalId))))
      .toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);

    // A simulated variant, but the handle names a DIFFERENT (also simulated) account.
    const ok = await approvedVariantWithDecidedApproval(simFb, "facebook");
    expect(await code(sim.schedulePost(new SimulatedOrgHandle(co, simIg, orgId), req(ok.variantId, ok.approvalId))))
      .toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);

    // Another tenant's handle reads nothing (RLS): refused, never a cross-tenant answer.
    const other = await createCompany("SCP-Sa Other Mock Agency", ["social"]);
    expect(await code(sim.schedulePost(new SimulatedOrgHandle(other, simFb, orgId), req(ok.variantId, ok.approvalId))))
      .toBe(SOCIAL_SIMULATION_REFUSAL.accountNotSimulated);

    // The approval: pending, rejected, or deciding a DIFFERENT variant -> not decided for this one.
    for (const status of ["pending", "rejected"]) {
      await adminPool().query(
        `UPDATE automation_approvals SET status = $2, decided_by = CASE WHEN $2 = 'pending' THEN NULL ELSE decided_by END,
                decided_at = CASE WHEN $2 = 'pending' THEN NULL ELSE decided_at END WHERE id = $1`,
        [ok.approvalId, status]);
      expect(await code(sim.schedulePost(new SimulatedOrgHandle(co, simFb, orgId), req(ok.variantId, ok.approvalId))))
        .toBe(SOCIAL_SIMULATION_REFUSAL.approvalNotDecided);
    }
    const second = await approvedVariantWithDecidedApproval(simFb, "facebook");
    expect(await code(sim.schedulePost(new SimulatedOrgHandle(co, simFb, orgId), req(ok.variantId, second.approvalId))))
      .toBe(SOCIAL_SIMULATION_REFUSAL.approvalNotDecided);

    // And the guard passes the decided one, by itself.
    expect(await dbSimulatedDispatchGuard(new SimulatedOrgHandle(co, simFb, orgId), req(second.variantId, second.approvalId))).toBeNull();
    // The simulator never wrote an approval: still exactly the rows this test filed.
    const { rows } = await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1 AND tool_name = $2`, [co, SOCIAL_PUBLISH_TOOL]);
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it("(S7) resolveDispatchOrgHandle reads `simulated` when a caller omits it, and refuses what the simulator does not simulate", async () => {
    const org = { id: orgId, clientId, driver: "postiz", postizOrgId: "x", apiKeyRef: "default", status: "active" };
    const partial = { org, network: "facebook", accountId: simFb };
    const { driver, handle } = await resolveDispatchOrgHandle(co, partial, "cancel");
    expect(driver.key).toBe("simulated");
    expect(handle).toBeInstanceOf(SimulatedOrgHandle);
    await expect(resolveDispatchOrgHandle(co, partial, "inbox_read")).rejects.toMatchObject({ code: "capability_unsupported" });
    // A real account omitting `simulated` takes the real path (and, with no engine registered, refuses honestly).
    await expect(resolveDispatchOrgHandle(co, { ...partial, accountId: realFb }, "schedule"))
      .rejects.toMatchObject({ code: "publisher_not_configured" });
  });

  it("(S8) boot's DB facts see every tenant through the wall, 'live' means active, and the switch ON beside real rows aborts wiring", async () => {
    // A real LinkedIn account with a LIVE grant.
    const li = await insertAccount("linkedin", false);
    await withTenants([co], (c) => storeOAuthGrant(c, {
      tenantId: co, accountId: li, network: "linkedin", accessToken: "mock-access-token", expiresAt: new Date(Date.now() + 3600_000),
    }), MODULES);

    const superuser = async () => (await adminPool().query<{ grants: number; accounts: number }>(
      `SELECT (SELECT count(*) FROM social_oauth_tokens WHERE status = 'active')::int AS grants,
              (SELECT count(*) FROM social_accounts WHERE simulated = false)::int AS accounts`)).rows[0];
    const facts = await readSocialSimulationDbFacts();
    const truth = await superuser();
    expect(facts).toEqual({ liveOAuthGrants: truth.grants, realAccounts: truth.accounts });
    expect(facts.liveOAuthGrants).toBeGreaterThanOrEqual(1);
    expect(facts.realAccounts).toBeGreaterThanOrEqual(2);

    // A revoked grant is not live.
    await withTenants([co], (c) => revokeOAuthGrant(c, li, "SCP-Sa test"), MODULES);
    expect((await readSocialSimulationDbFacts()).liveOAuthGrants).toBe(facts.liveOAuthGrants - 1);

    // A soft-deleted real account still counts (it is one upsert away from live again).
    await adminPool().query(`UPDATE social_accounts SET deleted_at = now() WHERE id = $1`, [li]);
    expect((await readSocialSimulationDbFacts()).realAccounts).toBe(facts.realAccounts);

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetPublishers();
    await expect(wireSocialPublisher()).rejects.toThrowError(SocialSimulationBootError);
    expect(listPublishers().some((p) => p.key === "simulated")).toBe(false);
  });
});
