// SMM-10 — `dispatch.ts` against a live Postgres + a mock publisher driver. No Nest app, no hub, no
// Cerbos: this file proves the DOMAIN function's own contract (the transactional stamp, the
// module-GUC regression, replay/double-post safety, failure attribution), exactly the split
// `d14-smm-09-social-publish-registry.test.ts` established for the precondition/registry layer.
// The HTTP wrapper (`social.controller.ts#dispatchPublish`) is a thin authz+shape wrapper over this
// function and is not re-tested here.
//
// ── ⚠ THE MODULE-GUC REGRESSION, PROVEN BY CONSTRUCTION ─────────────────────────────────────────────
// `dispatch.ts` never opens a `withTenants(..., {modules:['social']})` transaction — every one of its
// transactions relies on `declareSocialModuleScope` being called explicitly (mirroring the D14
// executor's own module-less transaction). So EVERY test below that reaches a real row through
// `dispatchApprovedPublish` is already the regression test: remove that one call from `dispatch.ts`
// and (T1) fails with `variant_not_found` instead of dispatching, because 0105's third RLS wall
// would make the query return zero rows, silently. Nothing here needs a second, artificial "GUC
// removed" test — the happy path IS the guard.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { seedAutomationAccounts } from "../../seed/automation";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import { SocialPublisherError } from "./publisher/types";
import { variantPublishArgs, variantArgsSha256 } from "./canonical-args";
import { SOCIAL_PUBLISH_TOOL, resetCreatorInfoVerifier } from "./publish-precondition";
import { installCreatorInfoVerifier } from "./creator-info-verifier";
import { dispatchApprovedPublish, DISPATCH_REFUSAL } from "./dispatch";

const MODULES: { modules: string[] } = { modules: ["social"] };
const IG_MEDIA = [{ fileId: "file-1", kind: "image", alt: "a photo", format: "jpeg" }];

let seq = 0;
const uniq = (label: string): string => `smm10-dispatch-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-10 · dispatchApprovedPublish — the transactional stamp", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let publisherOrgId: string;
  let igAccount: string;
  let state: MockPublisherState;
  let enabledNetworksBefore: string[];

  beforeAll(async () => {
    await initTestDb();
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    config.social.publisher.enabledNetworks = [...new Set([...enabledNetworksBefore, "instagram"])];
    // `openOrg` resolves the org's API key by alias at call time (custody split (b)) — the mock
    // driver never reads it, but `resolveOrgApiKey` still refuses `org_key_unresolved` if no alias
    // resolves, so the 'default' alias needs a value even for a fake key.
    config.social.publisher.defaultOrgApiKey = "test-org-key";

    co = await createCompany("SMM-10 Dispatch Co", ["social"]);
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;

    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, co]));
    publisherOrgId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [publisherOrgId, co, clientId, uniq("org")]), MODULES);
    igAccount = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram',$5,$6,'connected','{}','central')`,
        [igAccount, co, clientId, publisherOrgId, uniq("@brand"), uniq("ig")]), MODULES);
  });

  afterAll(async () => {
    config.social.publisher.enabledNetworks = enabledNetworksBefore;
    await teardownTestDb();
  });

  beforeEach(() => {
    state = newMockPublisherState();
    resetPublishers();
    registerPublisher(createMockPublisher(state));
  });

  async function makeEngagement(opts: { status?: string; networks?: Record<string, boolean> } = {}): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'SMM-10 engagement',$4,$5,10,'central')`,
        [id, co, clientId, opts.status ?? "active", JSON.stringify({ networks: opts.networks ?? { instagram: true } })],
      ), MODULES);
    return id;
  }

  async function makeApprovedVariant(opts: { engagementId?: string } = {}): Promise<{ variantId: string; engagementId: string }> {
    const engagementId = opts.engagementId ?? (await makeEngagement());
    const postId = newId();
    const variantId = newId();
    const body = "Hello from SMM-10's dispatch flow";
    const hash = variantArgsSha256({
      tenantId: co, id: variantId, accountId: igAccount, body, firstComment: null, media: IG_MEDIA,
      settings: { igType: "feed" }, scheduledAt: null,
    });
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1,$2,$3,'SMM-10 post','approved','central')`, [postId, co, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved','central')`,
        [variantId, co, postId, igAccount, body, JSON.stringify(IG_MEDIA), JSON.stringify({ igType: "feed" }), hash],
      );
    }, MODULES);
    return { variantId, engagementId };
  }

  /** File the `automation_approvals` row in the state `checkPreconditionAndResolveApproval` looks
   *  for: `execution_status='executing'` — the state the D14 executor's claim holds for the duration
   *  of exactly one hub round trip, which is what this file's `dispatchApprovedPublish` call stands
   *  in for. */
  async function fileExecutingApproval(variantId: string): Promise<string> {
    const id = newId();
    const args = variantPublishArgs({
      tenantId: co, id: variantId, accountId: igAccount, body: "Hello from SMM-10's dispatch flow",
      firstComment: null, media: IG_MEDIA, settings: { igType: "feed" }, scheduledAt: null,
    });
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery',$3,$4,'high','approved',$5,$5,now(),'automation','main','executing')`,
        [id, co, SOCIAL_PUBLISH_TOOL, JSON.stringify(args), wfUser],
      ),
    );
    return id;
  }

  async function variantRow(variantId: string) {
    const { rows } = await withTenants([co], (c) =>
      c.query(
        `SELECT status, approval_id AS "approvalId", provider_post_id AS "providerPostId", last_error AS "lastError"
           FROM social_post_variants WHERE id = $1`,
        [variantId],
      ), MODULES);
    return rows[0];
  }

  async function outboxEvents(variantId: string): Promise<Array<{ event_type: string }>> {
    const { rows } = await adminPool().query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1 ORDER BY created_at`,
      [variantId],
    );
    return rows;
  }

  // ══ (T1) THE TRANSACTIONAL STAMP ══════════════════════════════════════════════════════════════

  it("(T1) ⭐ stamps approval_id + provider_post_id TOGETHER, only after schedulePost succeeds, and this IS the module-GUC regression test", async () => {
    const { variantId } = await makeApprovedVariant();
    const approvalId = await fileExecutingApproval(variantId);

    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.network).toBe("instagram");

    const row = await variantRow(variantId);
    expect(row.status).toBe("queued");
    expect(row.approvalId).toBe(approvalId);
    expect(row.providerPostId).toBe(verdict.providerPostId);

    // The mock's own D-6 assertion: schedulePost was called WITH an approvalId, exactly once.
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);

    const events = await outboxEvents(variantId);
    expect(events.map((e) => e.event_type)).toContain("social.post.dispatched");
  });

  // ══ (T2) precondition refuses -> NOTHING is spent, NOTHING is called ═══════════════════════════

  it("(T2) a precondition failure never resolves an approval and never calls the publisher", async () => {
    const engagementId = await makeEngagement({ status: "closed" });
    const { variantId } = await makeApprovedVariant({ engagementId });
    await fileExecutingApproval(variantId);

    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

    expect(verdict).toMatchObject({ ok: false, stage: "scope", reason: "engagement_inactive" });
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(0);
    const row = await variantRow(variantId);
    expect(row.approvalId).toBeNull();
    expect(row.status).toBe("approved"); // untouched
  });

  // ══ (T3) approval resolution ambiguity fails closed ═════════════════════════════════════════════

  it("(T3) no `executing` approval names this variant ⇒ approval_not_resolvable, nothing spent", async () => {
    const { variantId } = await makeApprovedVariant();
    // Deliberately no fileExecutingApproval() call — the precondition alone would pass, but there is
    // nothing recorded as consuming it.
    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.approvalNotResolvable });
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(0);
  });

  // ══ (T4) ON FAILURE THE APPROVAL IS STILL CONSUMED ══════════════════════════════════════════════

  it("(T4) ⭐ schedulePost throwing still stamps approval_id (0105's state law) with a NULL provider id, status=failed, and emits social.post.failed", async () => {
    const { variantId } = await makeApprovedVariant();
    const approvalId = await fileExecutingApproval(variantId);
    state.failWith = new SocialPublisherError("publisher_unreachable", "simulated tunnel outage");

    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.publishDispatchFailed });
    const row = await variantRow(variantId);
    expect(row.status).toBe("failed");
    expect(row.approvalId).toBe(approvalId); // consumed even though nothing published
    expect(row.providerPostId).toBeNull();
    expect(row.lastError).toContain("publisher_unreachable");

    const events = await outboxEvents(variantId);
    expect(events.map((e) => e.event_type)).toContain("social.post.failed");
  });

  // ══ (T5) DOUBLE-POST SAFETY — the double-post path is TESTED, not a comment ════════════════════

  it("(T5) ⭐ a second dispatch attempt for an already-consumed variant refuses approval_already_consumed — never a second schedulePost call", async () => {
    const { variantId } = await makeApprovedVariant();
    await fileExecutingApproval(variantId);
    const first = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(first.ok).toBe(true);
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);

    // A retry / redelivered event / a second automation_approvals row filed for the SAME variant —
    // the precondition's own `unconsumed` stage (reused verbatim, not re-implemented here) is what
    // refuses this. `already_dispatched` — not `approval_already_consumed` — because the variant's
    // own `status` is already `queued`, and `already_dispatched` OUTRANKS the approval check in the
    // precondition's own documented order (mirrors `d14-smm-09-social-publish-registry.test.ts`'s
    // (C4b): "this post is already out" is the fact that matters to a human, "a grant was spent" is
    // only how we know).
    await fileExecutingApproval(variantId);
    const second = await dispatchApprovedPublish(co, variantId, wfUser);

    expect(second).toMatchObject({ ok: false, stage: "unconsumed", reason: "already_dispatched" });
    // THE assertion this test exists for: still exactly one call, not two.
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);
  });

  it("(T6) a variant with no such id at all ⇒ variant_not_found, nothing touched", async () => {
    const verdict = await dispatchApprovedPublish(co, newId(), wfUser);
    expect(verdict).toMatchObject({ ok: false, stage: "scope", reason: "variant_not_found" });
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(0);
  });

  // ══ (T7)–(T9) D-22 END TO END: the live fetch happens BEFORE the verifier reads it ═══════════
  //
  // Unlike creator-info-verifier.test.ts (which drives `verifyCreatorInfo`/`refreshCreatorInfoSnapshot`
  // directly), this block drives the FULL sequence `dispatchApprovedPublish` actually performs for a
  // TikTok variant: live fetch (outside any transaction) -> precondition re-run (the verifier reads
  // what the fetch just wrote, inside the transaction) -> dispatch. Proves the two halves of the seam
  // are wired together correctly, not just individually correct.
  describe("D-22 · TikTok, end to end through dispatchApprovedPublish", () => {
    let tiktokAccount: string;
    let tiktokIntegrationId: string;
    let networksBefore: string[];

    beforeAll(async () => {
      resetCreatorInfoVerifier();
      installCreatorInfoVerifier();
      networksBefore = config.social.publisher.enabledNetworks;
      config.social.publisher.enabledNetworks = [...networksBefore, "tiktok"];
      tiktokIntegrationId = uniq("tt-integration");
      tiktokAccount = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO social_accounts
             (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
           VALUES ($1,$2,$3,$4,'tiktok',$5,$6,'connected','{}','central')`,
          [tiktokAccount, co, clientId, publisherOrgId, uniq("@brand"), tiktokIntegrationId]), MODULES);
    });
    afterAll(async () => {
      config.social.publisher.enabledNetworks = networksBefore;
      resetCreatorInfoVerifier();
    });
    beforeEach(() => {
      state = newMockPublisherState();
      resetPublishers();
      registerPublisher(createMockPublisher(state, { withCreatorInfoProbe: true }));
    });

    async function makeTiktokVariant(): Promise<string> {
      const engagementId = await makeEngagement({ networks: { tiktok: true } });
      const postId = newId();
      const variantId = newId();
      const settings = { tiktokMode: "direct", privacyLevel: "PUBLIC_TO_EVERYONE" };
      const hash = variantArgsSha256({
        tenantId: co, id: variantId, accountId: tiktokAccount, body: "tiktok body", firstComment: null,
        media: [{ fileId: "v-1", kind: "video", format: "mp4" }], settings, scheduledAt: null,
      });
      await withTenants([co], async (c) => {
        await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
                       VALUES ($1,$2,$3,'tiktok post','approved','central')`, [postId, co, engagementId]);
        await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,'tiktok body',$5,$6,$7,'approved','central')`,
          [variantId, co, postId, tiktokAccount, JSON.stringify([{ fileId: "v-1", kind: "video", format: "mp4" }]), JSON.stringify(settings), hash],
        );
      }, MODULES);
      return variantId;
    }

    it("(T7) ⭐ live fetch + verifier wired together: creator_info still permits it ⇒ dispatch succeeds", async () => {
      const variantId = await makeTiktokVariant();
      await fileExecutingApproval(variantId);
      state.creatorInfo.set(tiktokIntegrationId, {
        privacyLevelOptions: ["PUBLIC_TO_EVERYONE"], commentDisabled: false, duetDisabled: false, stitchDisabled: false,
      });

      const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

      expect(verdict).toMatchObject({ ok: true, network: "tiktok" });
      expect(state.calls.filter((c) => c.op === "getCreatorInfo")).toHaveLength(1);
      expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);
    });

    it("(T8) no probe result available ⇒ creator_info_unverified, and schedulePost is NEVER reached", async () => {
      const variantId = await makeTiktokVariant();
      await fileExecutingApproval(variantId);
      // Deliberately no state.creatorInfo entry — the mock's probe reports nothing.

      const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

      expect(verdict).toMatchObject({ ok: false, stage: "creator_info", reason: "creator_info_unverified" });
      expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(0);
    });

    it("(T9) ⭐ the creator's live settings no longer permit the approved privacy level ⇒ refused, nothing spent", async () => {
      const variantId = await makeTiktokVariant();
      await fileExecutingApproval(variantId);
      state.creatorInfo.set(tiktokIntegrationId, {
        privacyLevelOptions: ["SELF_ONLY"], commentDisabled: false, duetDisabled: false, stitchDisabled: false,
      });

      const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

      expect(verdict).toMatchObject({ ok: false, stage: "creator_info", reason: "creator_selection_no_longer_permitted" });
      expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(0);
    });
  });
});
