// SMM-22 — `social.publishPostMetered`: the config-gated bar-lift, and the D-9 stop-loss chain's
// tenant/global tiers proven DIRECTLY against `evaluatePublishPrecondition` (independent of
// `dispatch.ts` — that file's own SMM-22 block in `dispatch.test.ts` proves the SECOND checkpoint,
// the reservation; this file proves the FIRST, the precondition itself, and the registry mechanics
// around lifting the bar. "A test that proves only one of them is not proof" — this is the "one"
// half of that pair.
//
// No Nest app, no hub, no Cerbos: shape mirrors `d14-smm-09-social-publish-registry.test.ts` and
// `d14-smm-17-social-reply-registry.test.ts` deliberately.
//
// What this file proves:
//   (A) doctrine        — the twin is BARRED by default, provably, and cannot be sneaked around.
//   (B) the unbar gate   — refuses AT BOOT when enabled with no price; lifts cleanly when priced;
//                          the default (disabled) posture is unaffected by re-running the bootstrap.
//   (C) the precondition — the tenant AND global tiers each independently refuse, the price-
//                          unconfigured refusal fires, and the symmetric metered<->free checks hold.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import {
  resetExecutableApprovals,
  registerCoreExecutableApprovals,
  registerPmExecutableApprovals,
  registerWebdevExecutableApprovals,
  registerJmlExecutableApprovals,
  registerIamExecutableApprovals,
  registerSocialExecutableApprovals,
  registerSocialReplyExecutableApprovals,
  registerSocialMeteredExecutableApprovalIfEnabled,
  registerExecutableApproval,
  getExecutable,
  isBarredExecutable,
  getBarredExecutable,
} from "./approval-executables";
import { variantPublishArgs, variantArgsSha256 } from "../modules/social/canonical-args";
import {
  PUBLISH_REFUSAL,
  SOCIAL_PUBLISH_TOOL,
  SOCIAL_PUBLISH_METERED_TOOL,
  evaluatePublishPrecondition,
} from "../modules/social/publish-precondition";
import { insertUsageLedgerRow, resetGlobalUsageMonthToDateCache } from "../modules/social/usage-ledger";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm22-registry-${label}-${++seq}`;

/** Restores the ENTIRE D14 registry to its normal boot-time shape — needed because
 *  `resetExecutableApprovals()` clears EVERYTHING (deploy, pm, webdev, jml, iam, social), and this
 *  file's own (B) block deliberately calls it mid-file to exercise the unbar gate in isolation. */
function restoreFullRegistry(): void {
  resetExecutableApprovals();
  registerCoreExecutableApprovals();
  registerPmExecutableApprovals();
  registerWebdevExecutableApprovals();
  registerJmlExecutableApprovals();
  registerIamExecutableApprovals();
  registerSocialExecutableApprovals();
  registerSocialReplyExecutableApprovals();
  registerSocialMeteredExecutableApprovalIfEnabled();
}

describe.skipIf(!TEST_URL)("SMM-22 registry: social.publishPostMetered — the bar lift + the D-9 tiers", () => {
  let co: string;
  let otherCo: string;
  let clientId: string;
  let publisherOrgId: string;
  let xAccount: string;
  let enabledNetworksBefore: string[];
  let meteredEnabledBefore: boolean;
  let xPriceBefore: number | null;
  let xLinkPriceBefore: number | null;
  let tenantCapBefore: number | null;
  let globalCapBefore: number;

  beforeAll(async () => {
    await initTestDb();
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    config.social.publisher.enabledNetworks = [...new Set([...enabledNetworksBefore, "x"])];
    meteredEnabledBefore = config.social.usage.meteredPublishEnabled;
    xPriceBefore = config.social.usage.xPerPostCostUsd;
    xLinkPriceBefore = config.social.usage.xPerPostWithLinkCostUsd;
    tenantCapBefore = config.social.usage.tenantMonthlyCapUsd;
    globalCapBefore = config.social.usage.globalMonthlyCapUsd;
    // Known-clean baseline regardless of what an earlier file in this worker left behind. A valid
    // price is the DEFAULT for this file (most tests are about the tiers/registry, not the price
    // itself) — (C3) is the one test that deliberately unsets it, in its own try/finally.
    config.social.usage.meteredPublishEnabled = false;
    config.social.usage.xPerPostCostUsd = 0.02;
    config.social.usage.xPerPostWithLinkCostUsd = 0.2;
    restoreFullRegistry();

    co = await createCompany("SMM-22 Registry Co", ["social"]);
    otherCo = await createCompany("SMM-22 Registry Co (other tenant)", ["social"]);
    await seedAutomationAccounts(co);

    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, co]));
    publisherOrgId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [publisherOrgId, co, clientId, uniq("org")]), MODULES);
    xAccount = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'x',$5,$6,'connected','{}','central')`,
        [xAccount, co, clientId, publisherOrgId, uniq("@brand-x"), uniq("x")]), MODULES);
  });

  afterAll(async () => {
    config.social.publisher.enabledNetworks = enabledNetworksBefore;
    config.social.usage.meteredPublishEnabled = meteredEnabledBefore;
    config.social.usage.xPerPostCostUsd = xPriceBefore;
    config.social.usage.xPerPostWithLinkCostUsd = xLinkPriceBefore;
    config.social.usage.tenantMonthlyCapUsd = tenantCapBefore;
    config.social.usage.globalMonthlyCapUsd = globalCapBefore;
    resetGlobalUsageMonthToDateCache();
    restoreFullRegistry();
    await teardownTestDb();
  });

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────

  async function makeEngagement(opts: { tenant?: string; client?: string; budgetUsd?: number; networks?: Record<string, boolean> } = {}): Promise<string> {
    const id = newId();
    const tenant = opts.tenant ?? co;
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'SMM-22 registry engagement','active',$4,$5,'central')`,
        [id, tenant, opts.client ?? clientId, JSON.stringify({ networks: opts.networks ?? { x: true } }), opts.budgetUsd ?? 10],
      ), MODULES);
    return id;
  }

  interface MeteredPublishable { variantId: string; args: Record<string, unknown>; engagementId: string }

  /** A metered (X) variant that passes every stage up to budget, unless the test seeds a breach. */
  async function makeMeteredPublishable(opts: {
    engagementId?: string; body?: string; account?: string; tenant?: string;
  } = {}): Promise<MeteredPublishable> {
    const engagementId = opts.engagementId ?? (await makeEngagement({ tenant: opts.tenant }));
    const account = opts.account ?? xAccount;
    const tenant = opts.tenant ?? co;
    const postId = newId();
    const variantId = newId();
    const body = opts.body ?? "Hello from SMM-22's metered gate";
    const args = variantPublishArgs({
      tenantId: tenant, id: variantId, accountId: account, body, firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    const hash = variantArgsSha256({
      tenantId: tenant, id: variantId, accountId: account, body, firstComment: null, media: [], settings: {}, scheduledAt: null,
    });
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1,$2,$3,'SMM-22 post','approved','central')`, [postId, tenant, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,'[]','{}',$6,'approved','central')`,
        [variantId, tenant, postId, account, body, hash],
      );
    }, MODULES);
    return { variantId, args: args as unknown as Record<string, unknown>, engagementId };
  }

  function runPrecondition(args: Record<string, unknown>, toolName: string) {
    // Deliberately WITHOUT `{modules:['social']}` — mirrors the executor's own module-less
    // transaction; see d14-smm-09's own identical comment for why this is the default, not a
    // special case.
    return withTenants([co], (c) => evaluatePublishPrecondition(c, args, toolName));
  }
  // ══ (A) DEFAULT POSTURE — BARRED, PROVABLY, UNCHANGED BY THIS TICKET ═══════════════════════════

  it("(A1) social.publishPostMetered is NOT in the executable registry by default", () => {
    expect(getExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBeUndefined();
  });

  it("(A2) social.publishPostMetered is barred by default, with the documented reason token", () => {
    expect(isBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBe(true);
    expect(getBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL)?.reason).toBe("metered_tool_barred");
  });

  it("(A3) the bar cannot be sneaked around by a plain registerExecutableApproval call", () => {
    expect(() => registerExecutableApproval({ toolName: SOCIAL_PUBLISH_METERED_TOOL })).toThrow(/BARRED/);
  });

  // ══ (B) THE UNBAR GATE — explicit, configured, refuses loudly when the price is absent ════════

  describe("the config-gated unbar", () => {
    afterEach(() => {
      config.social.usage.meteredPublishEnabled = false;
      // Restore to THIS FILE's own baseline (set in the outer beforeAll) — NOT null. (B1)/(B2)
      // deliberately null the price to prove the boot-refusal; nulling it here in the shared
      // teardown would leak into the (C) tests below, which need a real price configured.
      config.social.usage.xPerPostCostUsd = 0.02;
      config.social.usage.xPerPostWithLinkCostUsd = 0.2;
      restoreFullRegistry();
    });

    it("(B1) enabled + BOTH prices unset ⇒ THROWS at registration (boot failure), never silently barred or silently lifted", () => {
      resetExecutableApprovals();
      config.social.usage.meteredPublishEnabled = true;
      config.social.usage.xPerPostCostUsd = null;
      config.social.usage.xPerPostWithLinkCostUsd = null;
      registerSocialExecutableApprovals(); // re-establish the bar this test's own reset just cleared
      expect(() => registerSocialMeteredExecutableApprovalIfEnabled()).toThrow(/per-post price is not configured/);
    });

    it("(B2) enabled + only ONE of the two prices set ⇒ still THROWS — both are required together", () => {
      resetExecutableApprovals();
      config.social.usage.meteredPublishEnabled = true;
      config.social.usage.xPerPostCostUsd = 0.02;
      config.social.usage.xPerPostWithLinkCostUsd = null;
      registerSocialExecutableApprovals();
      expect(() => registerSocialMeteredExecutableApprovalIfEnabled()).toThrow(/per-post price is not configured/);
    });

    it("(B3) enabled + BOTH prices set ⇒ lifts the bar and registers a REAL entry (own lockKey, own precondition, neverAutoRetry)", () => {
      resetExecutableApprovals();
      config.social.usage.meteredPublishEnabled = true;
      config.social.usage.xPerPostCostUsd = 0.02;
      config.social.usage.xPerPostWithLinkCostUsd = 0.2;
      registerSocialExecutableApprovals();
      expect(isBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBe(true); // still barred BEFORE the gate runs

      registerSocialMeteredExecutableApprovalIfEnabled();

      expect(isBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBe(false);
      const entry = getExecutable(SOCIAL_PUBLISH_METERED_TOOL);
      expect(entry).toBeDefined();
      expect(entry!.neverAutoRetry).toBe(true);
      // A REAL lockKey, not the name-only fallback (`executable-approval:<name>`).
      expect(entry!.lockKey({})).not.toBe(`executable-approval:${SOCIAL_PUBLISH_METERED_TOOL}`);
      // The free tool is COMPLETELY UNAFFECTED by lifting the metered twin's bar.
      expect(getExecutable(SOCIAL_PUBLISH_TOOL)).toBeDefined();
      expect(isBarredExecutable(SOCIAL_PUBLISH_TOOL)).toBe(false);
    });

    it("(B4) disabled (the default) ⇒ re-running the bootstrap is a no-op; the twin stays barred", () => {
      resetExecutableApprovals();
      config.social.usage.meteredPublishEnabled = false;
      registerSocialExecutableApprovals();
      registerSocialMeteredExecutableApprovalIfEnabled();
      expect(isBarredExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBe(true);
      expect(getExecutable(SOCIAL_PUBLISH_METERED_TOOL)).toBeUndefined();
    });
  });

  // ══ (C) THE PRECONDITION ITSELF — the FIRST of the "two checkpoints" ═══════════════════════════
  //
  // Called DIRECTLY, with no dispatch.ts involved at all — proves publish-precondition.ts's own
  // budget-stage code (this ticket's edit) enforces the tenant and global tiers on its own.

  it("(C1) tenant tier: a DIFFERENT engagement's spend in the SAME tenant already exceeds the tenant cap ⇒ budget_exceeded, at the precondition alone", async () => {
    config.social.usage.tenantMonthlyCapUsd = 1;
    try {
      const spenderEngagement = await makeEngagement({ budgetUsd: 10 });
      await withTenants([co], (c) => insertUsageLedgerRow(c, {
        tenantId: co, engagementId: spenderEngagement, kind: "x_post", refId: newId(),
        costUsd: 0.99, status: "posted", requestedBy: null,
      }), MODULES);

      // The fresh engagement's own price estimate is $0.02 (no link) — 0.99 + 0.02 > 1, the tenant
      // cap set above, even though this engagement's OWN cap (10) has room to spare.
      const { args } = await makeMeteredPublishable(); // a FRESH engagement, its OWN cap (10) is fine
      const verdict = await runPrecondition(args, SOCIAL_PUBLISH_METERED_TOOL);
      expect(verdict).toMatchObject({ ok: false, stage: "budget", reason: PUBLISH_REFUSAL.budgetExceeded });
    } finally {
      config.social.usage.tenantMonthlyCapUsd = tenantCapBefore;
    }
  });

  it("(C2) global tier: a DIFFERENT tenant's spend already exceeds the global cap ⇒ budget_exceeded, at the precondition alone", async () => {
    const baseline = await (await import("../modules/social/usage-ledger")).sumGlobalUsageMonthToDate();
    config.social.usage.globalMonthlyCapUsd = baseline + 0.5;
    resetGlobalUsageMonthToDateCache();
    try {
      const otherClientId = newId();
      await withTenants([otherCo], (c) =>
        c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand Other','central')`, [otherClientId, otherCo]));
      const otherEngagement = await makeEngagement({ tenant: otherCo, client: otherClientId, budgetUsd: 10 });
      await withTenants([otherCo], (c) => insertUsageLedgerRow(c, {
        tenantId: otherCo, engagementId: otherEngagement, kind: "x_post", refId: newId(),
        costUsd: 0.9, status: "posted", requestedBy: null,
      }), MODULES);
      resetGlobalUsageMonthToDateCache();

      const { args } = await makeMeteredPublishable(); // co's own engagement/tenant tiers are fine
      const verdict = await runPrecondition(args, SOCIAL_PUBLISH_METERED_TOOL);
      expect(verdict).toMatchObject({ ok: false, stage: "budget", reason: PUBLISH_REFUSAL.budgetExceeded });
    } finally {
      config.social.usage.globalMonthlyCapUsd = globalCapBefore;
      resetGlobalUsageMonthToDateCache();
    }
  });

  it("(C3) X pricing unconfigured ⇒ metered_price_unconfigured, at the precondition alone — never a $0 pass-through", async () => {
    const before = { a: config.social.usage.xPerPostCostUsd, b: config.social.usage.xPerPostWithLinkCostUsd };
    config.social.usage.xPerPostCostUsd = null;
    config.social.usage.xPerPostWithLinkCostUsd = null;
    try {
      const { args } = await makeMeteredPublishable();
      const verdict = await runPrecondition(args, SOCIAL_PUBLISH_METERED_TOOL);
      expect(verdict).toMatchObject({ ok: false, stage: "budget", reason: PUBLISH_REFUSAL.meteredPriceUnconfigured });
    } finally {
      config.social.usage.xPerPostCostUsd = before.a;
      config.social.usage.xPerPostWithLinkCostUsd = before.b;
    }
  });

  it("(C4a) a metered-network (x) variant on the FREE tool refuses metered_network_requires_metered_tool", async () => {
    const { args } = await makeMeteredPublishable();
    const verdict = await runPrecondition(args, SOCIAL_PUBLISH_TOOL);
    expect(verdict).toMatchObject({ ok: false, stage: "scope", reason: PUBLISH_REFUSAL.meteredNetworkRequiresMeteredTool });
  });

  it("(C4b) SMM-22's own symmetric check: a NON-metered-network variant on the METERED tool refuses metered_tool_requires_metered_network", async () => {
    // Reuse the SAME engagement/account shape but on the co's instagram surface would need a new
    // account; simplest correct fixture is an engagement whose tool_scope never enabled `x` at all
    // combined with a non-x account — but the cleanest, most direct proof is calling the precondition
    // with args that name an x-capable engagement while resolving to null network is not expressible
    // here without a real account, so this uses a fresh instagram account explicitly.
    const igAccount = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram',$5,$6,'connected','{}','central')`,
        [igAccount, co, clientId, publisherOrgId, uniq("@brand-ig"), uniq("ig")]), MODULES);
    const engagementId = await makeEngagement({ networks: { instagram: true } });
    const { args } = await makeMeteredPublishable({ engagementId, account: igAccount, body: "an ordinary IG caption" });
    const verdict = await runPrecondition(args, SOCIAL_PUBLISH_METERED_TOOL);
    expect(verdict).toMatchObject({ ok: false, stage: "scope", reason: PUBLISH_REFUSAL.meteredToolRequiresMeteredNetwork });
  });
});
