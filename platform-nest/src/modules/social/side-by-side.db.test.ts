// SCP-Sa2 (owner ruling SCP-D9, 2026-10-28: "use simulator with postiz. so we can know if its working or not at the same
// time") — the social simulator BESIDE a real engine, against live Postgres (needs DATABASE_URL_TEST: NOT run on the dev
// laptop, runs on the Linux CI gate; a skip is not a pass). The real engine is the test double (`mock-driver.ts`, under
// the key 'postiz'), registered beside the real simulator with SOCIAL_SIMULATION_ENABLED on, in ONE tenant and ONE client.
//
// Proves "never mixed" end to end:
//   (B1) one post on a simulated account and one on a real account, dispatched through the SAME D14 path: each reaches only
//        its own driver (the simulator mints `simulated:`, the engine is asked about the real variant only); the status
//        sweep then asks each driver only about its own posts;
//   (B2) the reverse fence on the dispatch resolver: a stale chain that says a simulated account is real, or a real chain
//        carrying a `simulated:` integration id, refuses `simulated_account_on_real_publisher` and never reaches the engine;
//   (B3) the reverse fence on the status sweep and the webhook intake: a real account's queued variant holding a
//        simulator-minted id is refused, left queued, and never sent to the engine;
//   (B4) the reverse fence on the metrics sweep: the same for a published variant;
//   (B5) a real connect is allowed with the switch on, but never onto a handle a simulated account holds;
//   (B6) the connector-registry sync runs with the switch on, never converts, re-states or disconnects a simulated account.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { seedAutomationAccounts } from "../../seed/automation";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createSimulatedPublisher } from "./publisher/simulated-driver";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import { SOCIAL_SIMULATION_REFUSAL } from "./publisher/simulation";
import { initiateAccountConnect, resolveDispatchOrgHandle, syncConnectorRegistry } from "./publisher/provisioning";
import type { SocialPublisher } from "./publisher/types";
import { variantPublishArgs, variantArgsSha256 } from "./canonical-args";
import { SOCIAL_PUBLISH_TOOL } from "./publish-precondition";
import { dispatchApprovedPublish } from "./dispatch";
import { reconcileOneProviderPost, reconcileTenantPostStatus } from "./post-status-sync-job";
import { pullTenantMetrics } from "./metrics-job";

const MODULES = { modules: ["social"] };
const REFUSED = SOCIAL_SIMULATION_REFUSAL.simulatedOnRealPublisher;
let seq = 0;
const uniq = (label: string): string => `scp-sa2-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SCP-Sa2 · the simulator side by side with a real engine, never mixed", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let orgId: string;
  let postizOrgId: string;
  let simIg: string;
  let simIgHandle: string;
  let simFb: string;
  let realLi: string;
  let state: MockPublisherState;
  let engine: SocialPublisher;
  const before = {
    flag: config.socialSimulationEnabled,
    networks: config.social.publisher.enabledNetworks,
    key: config.social.publisher.defaultOrgApiKey,
    tokenKey: config.integrationTokenKey,
    ownBrand: config.social.publisher.ownBrandClientIds,
    redirect: config.social.publisher.connectRedirectUrl,
  };

  async function insertAccount(network: string, simulated: boolean): Promise<{ id: string; handle: string }> {
    const id = newId();
    const handle = uniq(`@brand-${network}`);
    await withTenants([co], (c) => c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, simulated, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'connected','{}',$8,'central')`,
      [id, co, clientId, orgId, network, handle, simulated ? `simulated:${network}` : uniq(`${network}-real`), simulated],
    ), MODULES);
    return { id, handle };
  }

  beforeAll(async () => {
    await initTestDb();
    config.social.publisher.enabledNetworks = [...new Set([...before.networks, "instagram", "facebook", "linkedin"])];
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    config.integrationTokenKey = randomBytes(32).toString("base64");

    co = await createCompany("SCP-Sa2 Side By Side Agency", ["social"]);
    await seedAutomationAccounts(co);
    wfUser = (await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    )).rows[0].user_id;
    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Mock Client Side By Side','central')`, [clientId, co]));
    orgId = newId();
    postizOrgId = uniq("postiz-org");
    await withTenants([co], (c) => c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
      [orgId, co, clientId, postizOrgId]), MODULES);
    const sim = await insertAccount("instagram", true);
    simIg = sim.id;
    simIgHandle = sim.handle;
    // B1 publishes text only, so its simulated post is on FACEBOOK: Instagram requires media (media-rules.ts `mediaRequired`),
    // and a text-only Instagram variant is refused by the precondition before any driver is chosen. The real account is a
    // LinkedIn account served by the engine (one kind per network per client, as the seed keeps it).
    simFb = (await insertAccount("facebook", true)).id;
    realLi = (await insertAccount("linkedin", false)).id;
  });

  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    config.social.publisher.enabledNetworks = before.networks;
    config.social.publisher.defaultOrgApiKey = before.key;
    config.integrationTokenKey = before.tokenKey;
    config.social.publisher.ownBrandClientIds = before.ownBrand;
    config.social.publisher.connectRedirectUrl = before.redirect;
    resetPublishers();
    await teardownTestDb();
  });

  beforeEach(() => {
    config.socialSimulationEnabled = true;
    resetPublishers();
    state = newMockPublisherState();
    engine = createMockPublisher(state); // the real engine, under 'postiz'
    registerPublisher(engine);
    registerPublisher(createSimulatedPublisher());
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function approvedVariantWithDecidedApproval(accountId: string, network: string): Promise<{ variantId: string; approvalId: string }> {
    const body = `Side by side (${network}, mock)`;
    const engagementId = newId();
    await withTenants([co], (c) => c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'SCP-Sa2 engagement','active',$4,10,'central')`,
      [engagementId, co, clientId, JSON.stringify({ networks: { [network]: true } })]), MODULES);
    const postId = newId();
    const variantId = newId();
    const hash = variantArgsSha256({ tenantId: co, id: variantId, accountId, body, firstComment: null, media: [], settings: {}, scheduledAt: null });
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1,$2,$3,'SCP-Sa2 post','approved','central')`,
        [postId, co, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,'[]','{}',$6,'approved','central')`,
        [variantId, co, postId, accountId, body, hash]);
    }, MODULES);
    const approvalId = newId();
    const args = variantPublishArgs({ tenantId: co, id: variantId, accountId, body, firstComment: null, media: [], settings: {}, scheduledAt: null });
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
      `SELECT status, provider_post_id AS "providerPostId", published_url AS "publishedUrl", simulated
         FROM social_post_variants WHERE id = $1`, [variantId]), MODULES);
    return rows[0];
  }
  const askedIds = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.flatMap((c) => c[1] as string[]);

  it("(B1) one simulated and one real post in the same tenant and client: each reaches ONLY its own driver, at dispatch and at the sweep", async () => {
    const schedule = vi.spyOn(engine, "schedulePost");
    const sim = await approvedVariantWithDecidedApproval(simFb, "facebook");
    const real = await approvedVariantWithDecidedApproval(realLi, "linkedin");

    const simVerdict = await dispatchApprovedPublish(co, sim.variantId, wfUser);
    const realVerdict = await dispatchApprovedPublish(co, real.variantId, wfUser);
    // The whole verdict in the message, so a refusal names its stage and reason.
    expect(simVerdict, JSON.stringify(simVerdict)).toMatchObject({ ok: true });
    expect(realVerdict, JSON.stringify(realVerdict)).toMatchObject({ ok: true });

    // The engine was asked to publish exactly once: the real variant.
    expect(schedule).toHaveBeenCalledTimes(1);
    expect((schedule.mock.calls[0][1] as { variantId: string }).variantId).toBe(real.variantId);
    const simRow = await variantRow(sim.variantId);
    const realRow = await variantRow(real.variantId);
    expect(simRow).toMatchObject({ status: "queued", simulated: true });
    expect(simRow.providerPostId).toMatch(/^simulated:facebook:\d+:[0-9a-f-]{36}$/);
    expect(realRow).toMatchObject({ status: "queued", simulated: false });
    expect(realRow.providerPostId).toMatch(/^mock-post-/);

    // The sweep: the engine is asked about the real id only; the simulator makes the simulated one live.
    const status = vi.spyOn(engine, "getPostStatus");
    const sweep = await reconcileTenantPostStatus(co);
    expect(sweep.errors).toBe(0);
    expect(askedIds(status)).toEqual([realRow.providerPostId]);
    expect((await variantRow(sim.variantId))).toMatchObject({ status: "published", simulated: true });
    expect((await variantRow(sim.variantId)).publishedUrl).toMatch(/^https:\/\/simulated\.invalid\/facebook\//);
    expect((await variantRow(real.variantId))).toMatchObject({ status: "publishing", simulated: false });
  });

  it("(B2) the dispatch resolver's reverse fence: a stale 'real' chain for a simulated account, or a simulated id on a real chain, refuses before the engine", async () => {
    const org = { id: orgId, clientId, driver: "postiz", postizOrgId, apiKeyRef: "default", status: "active" };
    await expect(resolveDispatchOrgHandle(co, { org, network: "instagram", accountId: simIg, simulated: false }, "schedule"))
      .rejects.toMatchObject({ code: REFUSED });
    await expect(resolveDispatchOrgHandle(co, { org, network: "linkedin", accountId: realLi, simulated: false, integrationId: "simulated:linkedin" }, "schedule"))
      .rejects.toMatchObject({ code: REFUSED });
    // the plain real chain resolves to the engine, the simulated one to the simulator
    expect((await resolveDispatchOrgHandle(co, { org, network: "linkedin", accountId: realLi }, "schedule")).driver.key).toBe("postiz");
    expect((await resolveDispatchOrgHandle(co, { org, network: "instagram", accountId: simIg }, "schedule")).driver.key).toBe("simulated");
    expect(state.calls).toEqual([]);
  });

  it("(B3) the status sweep's and the webhook intake's reverse fence: a simulator-minted id on a real account is refused, left queued, never sent", async () => {
    const v = await approvedVariantWithDecidedApproval(realLi, "linkedin");
    const minted = `simulated:linkedin:${Date.now() - 1000}:${newId()}`;
    await adminPool().query(
      `UPDATE social_post_variants SET status = 'queued', provider_post_id = $2, approval_id = $3 WHERE id = $1`,
      [v.variantId, minted, v.approvalId]);
    const status = vi.spyOn(engine, "getPostStatus");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sweep = await reconcileTenantPostStatus(co);
    expect(sweep.errors).toBeGreaterThanOrEqual(1);
    expect(askedIds(status)).not.toContain(minted);
    expect(await variantRow(v.variantId)).toMatchObject({ status: "queued", providerPostId: minted, simulated: false });
    await expect(reconcileOneProviderPost(co, minted)).rejects.toMatchObject({ code: REFUSED });
    expect(askedIds(status)).not.toContain(minted);
    await adminPool().query(`UPDATE social_post_variants SET status = 'cancelled' WHERE id = $1`, [v.variantId]);
  });

  it("(B4) the metrics sweep's reverse fence: a simulator-minted id on a real account's published variant is refused and never sent", async () => {
    const v = await approvedVariantWithDecidedApproval(realLi, "linkedin");
    const minted = `simulated:linkedin:${Date.now() - 86_400_000}:${newId()}`;
    await adminPool().query(
      `UPDATE social_post_variants SET status = 'published', provider_post_id = $2, approval_id = $3, published_at = now() - interval '1 day'
        WHERE id = $1`,
      [v.variantId, minted, v.approvalId]);
    const metrics = vi.spyOn(engine, "getPostMetrics");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await pullTenantMetrics(co);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(askedIds(metrics)).not.toContain(minted);
  });

  it("(B5) a real connect is allowed with the switch on (was refused), but never onto a handle a simulated account holds", async () => {
    config.social.publisher.ownBrandClientIds = [clientId];
    config.social.publisher.connectRedirectUrl = "https://erp.example.invalid/social/connected";
    await withGlobal((c) => c.query(
      `INSERT INTO social_platform_apps (network, app_name, review_status, credential_ref) VALUES ('instagram', $1, 'approved', 'ig-app-ref')`,
      [uniq("ig-app")]));
    await expect(initiateAccountConnect(co, { clientId, network: "instagram", handle: simIgHandle, actorId: null }))
      .rejects.toMatchObject({ code: REFUSED });
    const sim = (await adminPool().query(`SELECT simulated, status, postiz_integration_id, deleted_at FROM social_accounts WHERE id = $1`, [simIg])).rows[0];
    expect(sim).toMatchObject({ simulated: true, postiz_integration_id: "simulated:instagram", deleted_at: null });
    const ok = await initiateAccountConnect(co, { clientId, network: "instagram", handle: uniq("@real-ig"), actorId: null });
    expect(ok.status).toBe("pending");
    const row = (await adminPool().query(`SELECT simulated, postiz_integration_id FROM social_accounts WHERE id = $1`, [ok.accountId])).rows[0];
    expect(row).toEqual({ simulated: false, postiz_integration_id: null });
  });

  it("(B6) the connector-registry sync runs with the switch on and never converts, re-states or disconnects a simulated account", async () => {
    state.integrations.set(postizOrgId, [
      { id: uniq("ig-real"), network: "instagram", handle: simIgHandle },     // collides with the simulated account's handle
      { id: "simulated:instagram", network: "instagram", handle: uniq("@weird") }, // an engine never mints this prefix
      { id: uniq("fb-real"), network: "facebook", handle: uniq("@brand-fb-new") },
    ]);
    const simBefore = (await adminPool().query(`SELECT * FROM social_accounts WHERE id = $1`, [simIg])).rows[0];
    const r = await syncConnectorRegistry(co, clientId, null);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["handle_held_by_simulated_account", "simulated_integration_id"]);
    expect(r.accounts).toHaveLength(1);
    expect(r.disconnected).not.toContain(simIg);
    expect((await adminPool().query(`SELECT * FROM social_accounts WHERE id = $1`, [simIg])).rows[0]).toEqual(simBefore);
    const created = (await adminPool().query(`SELECT simulated FROM social_accounts WHERE id = $1`, [r.accounts[0].accountId])).rows[0];
    expect(created).toEqual({ simulated: false });
  });
});
