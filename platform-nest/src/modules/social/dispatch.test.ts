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
import { randomBytes } from "node:crypto";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { seedAutomationAccounts } from "../../seed/automation";
import { setStorageForTest } from "../../core/storage";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import { SocialPublisherError } from "./publisher/types";
import { storeOAuthGrant, revokeOAuthGrant } from "./publisher/oauth-tokens";
import { variantPublishArgs, variantArgsSha256 } from "./canonical-args";
import { SOCIAL_PUBLISH_TOOL, resetCreatorInfoVerifier } from "./publish-precondition";
import { installCreatorInfoVerifier } from "./creator-info-verifier";
import { dispatchApprovedPublish, DISPATCH_REFUSAL } from "./dispatch";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm10-dispatch-${label}-${++seq}`;

// SMM-39 — in-memory storage backend so `resolveEngineMedia`'s `storage().get(...)` reads real bytes
// without touching disk, mirroring `core/files.test.ts`'s own pattern exactly.
const mem = new Map<string, Buffer>();

describe.skipIf(!TEST_URL)("SMM-10 · dispatchApprovedPublish — the transactional stamp", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let publisherOrgId: string;
  let igAccount: string;
  let fbAccount: string;
  let state: MockPublisherState;
  let enabledNetworksBefore: string[];
  let igFileId: string;
  let IG_MEDIA: Array<{ fileId: string; kind: string; alt: string; format: string }>;

  /** SMM-39 — a real `files` row with real bytes in the in-memory storage backend, so
   *  `resolveEngineMedia` has something genuine to read. Plain core tenant wall (no module scope) —
   *  `files` is not a `social_*` table, mirroring `core/files.controller.ts`'s own reads exactly. */
  async function createFile(filename: string, contentType: string, bytes: Buffer): Promise<string> {
    const id = newId();
    const storageKey = `${co}/${id}`;
    mem.set(storageKey, bytes);
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
         VALUES ($1,$2,'client',$3,$4,$5,$6,$7,false,'central')`,
        [id, co, clientId, filename, contentType, bytes.byteLength, storageKey],
      ));
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    config.social.publisher.enabledNetworks = [...new Set([...enabledNetworksBefore, "instagram"])];
    // `openOrg` resolves the org's API key by alias at call time (custody split (b)) — the mock
    // driver never reads it, but `resolveOrgApiKey` still refuses `org_key_unresolved` if no alias
    // resolves, so the 'default' alias needs a value even for a fake key.
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });

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
    // A Facebook account too: unlike Instagram, `media-rules.ts`'s SPECS.facebook has
    // `mediaRequired: false`, so the text-only-path tests (T4, T12) below can dispatch WITHOUT
    // media without the precondition's own `media_required` rule refusing them first.
    fbAccount = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'facebook',$5,$6,'connected','{}','central')`,
        [fbAccount, co, clientId, publisherOrgId, uniq("@brand-fb"), uniq("fb")]), MODULES);

    // SMM-39 — a REAL `files` row backing the default IG media descriptor. Before this ticket,
    // `IG_MEDIA` named a fileId ("file-1") with no `files` row behind it at all — the placeholder
    // `toDispatchMedia` never checked, which is exactly the defect this ticket closes. Any variant
    // in this file that attaches media must now resolve to a real file or `resolveEngineMedia`
    // refuses `media_upload_failed`, so the fixture is the real thing throughout.
    igFileId = await createFile("brand-photo.jpg", "image/jpeg", Buffer.from("fake-jpeg-bytes"));
    IG_MEDIA = [{ fileId: igFileId, kind: "image", alt: "a photo", format: "jpeg" }];
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

  async function makeApprovedVariant(
    opts: { engagementId?: string; media?: unknown; accountId?: string; settings?: Record<string, unknown> } = {},
  ): Promise<{ variantId: string; engagementId: string }> {
    const engagementId = opts.engagementId ?? (await makeEngagement());
    const postId = newId();
    const variantId = newId();
    const accountId = opts.accountId ?? igAccount;
    const body = "Hello from SMM-10's dispatch flow";
    const media = opts.media ?? IG_MEDIA;
    const settings = opts.settings ?? { igType: "feed" };
    const hash = variantArgsSha256({
      tenantId: co, id: variantId, accountId, body, firstComment: null, media, settings, scheduledAt: null,
    });
    await withTenants([co], async (c) => {
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1,$2,$3,'SMM-10 post','approved','central')`, [postId, co, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'approved','central')`,
        [variantId, co, postId, accountId, body, JSON.stringify(media), JSON.stringify(settings), hash],
      );
    }, MODULES);
    return { variantId, engagementId };
  }

  /** File the `automation_approvals` row in the state `checkPreconditionAndResolveApproval` looks
   *  for: `execution_status='executing'` — the state the D14 executor's claim holds for the duration
   *  of exactly one hub round trip, which is what this file's `dispatchApprovedPublish` call stands
   *  in for. `media`/`accountId`/`settings` MUST match the variant's own stored values exactly — they
   *  feed the SAME hash the hub binds the grant to (canonical-args.ts), so a mismatch here would fail
   *  `args_hash_mismatch`, not exercise the case the test wants. */
  async function fileExecutingApproval(
    variantId: string,
    media: unknown = IG_MEDIA,
    opts: { accountId?: string; settings?: Record<string, unknown> } = {},
  ): Promise<string> {
    const id = newId();
    const args = variantPublishArgs({
      tenantId: co, id: variantId, accountId: opts.accountId ?? igAccount, body: "Hello from SMM-10's dispatch flow",
      firstComment: null, media, settings: opts.settings ?? { igType: "feed" }, scheduledAt: null,
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

  /** SMM-39 — read the persisted idempotency map (migration 0116) directly, to assert what
   *  `resolveEngineMedia` actually wrote rather than inferring it from the dispatch verdict alone. */
  async function uploadedMediaOf(variantId: string): Promise<Record<string, { id: string; url?: string }>> {
    const { rows } = await withTenants([co], (c) =>
      c.query(`SELECT uploaded_media FROM social_post_variants WHERE id = $1`, [variantId]), MODULES);
    return rows[0]?.uploaded_media ?? {};
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
    // SMM-39 — the upload actually happened (one real uploadMedia call for the one attachment)...
    expect(state.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(1);
    // ...the ENGINE ref (not the composer's raw fileId) is what actually reached schedulePost...
    expect(state.lastScheduleRequest?.media).toEqual([{ id: "mock-media-brand-photo.jpg", url: "https://mock.invalid/media/brand-photo.jpg" }]);
    // ...and the persisted idempotency map (migration 0116) carries the SAME engine ref, keyed by
    // the composer's fileId — proving this is a real resolved reference, not the old passthrough.
    const uploaded = await uploadedMediaOf(variantId);
    expect(uploaded[igFileId]).toMatchObject({ id: "mock-media-brand-photo.jpg" });
    expect(uploaded[igFileId].id).not.toBe(igFileId);

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
    // Text-only, on the Facebook account (`mediaRequired: false` — Instagram's own
    // `mediaRequired: true` would refuse this at the precondition before dispatch is ever reached):
    // isolates "schedulePost itself throws" from SMM-39's own upload-failure path (T10 below) —
    // `state.failWith` throws on ANY driver call, and a media-bearing variant would hit `uploadMedia`
    // first, which is a DIFFERENT failure this file's own token vocabulary now distinguishes
    // (`media_upload_failed` vs this test's `dispatch_error`).
    const engagementId = await makeEngagement({ networks: { facebook: true } });
    const { variantId } = await makeApprovedVariant({ engagementId, media: [], accountId: fbAccount, settings: {} });
    const approvalId = await fileExecutingApproval(variantId, [], { accountId: fbAccount, settings: {} });
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

  // ══ (T10)–(T12) SMM-39: uploadMedia actually wired into the dispatch path ══════════════════════

  it("(T10) ⭐ three attachments, the second upload fails ⇒ refuses media_upload_failed BEFORE schedulePost is ever called, and the approval is still consumed", async () => {
    const fileA = await createFile("a.jpg", "image/jpeg", Buffer.from("aaa"));
    const fileB = await createFile("b.jpg", "image/jpeg", Buffer.from("bbb"));
    const fileC = await createFile("c.jpg", "image/jpeg", Buffer.from("ccc"));
    const media = [
      { fileId: fileA, kind: "image", alt: "a", format: "jpeg" },
      { fileId: fileB, kind: "image", alt: "b", format: "jpeg" },
      { fileId: fileC, kind: "image", alt: "c", format: "jpeg" },
    ];
    state.failUploadFilenames = new Set(["b.jpg"]);
    const { variantId } = await makeApprovedVariant({ media });
    const approvalId = await fileExecutingApproval(variantId, media);

    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: DISPATCH_REFUSAL.mediaUploadFailed });
    // THE assertion this ticket's AC exists for: a three-image approval must never publish a
    // one/two-image post. schedulePost is NEVER reached.
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(0);
    // a was attempted and succeeded; b was attempted and failed; c was NEVER reached (the loop
    // stops at the first failure rather than continuing past it).
    expect(state.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(2);

    const row = await variantRow(variantId);
    expect(row.status).toBe("failed");
    expect(row.approvalId).toBe(approvalId); // still consumed — SMM-09's neverAutoRetry doctrine
    expect(row.providerPostId).toBeNull();
    expect(row.lastError).toContain("b.jpg");

    // The idempotency backstop (migration 0116): a's ref IS durably persisted even though the
    // overall dispatch refused; b and c carry no ref (b failed before persisting, c never ran).
    const uploaded = await uploadedMediaOf(variantId);
    expect(Object.keys(uploaded)).toEqual([fileA]);

    const events = await outboxEvents(variantId);
    expect(events.map((e) => e.event_type)).toContain("social.post.failed");
  });

  it("(T11) ⭐ a redispatch after a failed attempt does not re-upload the attachment that already succeeded", async () => {
    const fileA = await createFile("retry-a.jpg", "image/jpeg", Buffer.from("aaa"));
    const fileB = await createFile("retry-b.jpg", "image/jpeg", Buffer.from("bbb"));
    const media = [
      { fileId: fileA, kind: "image", alt: "a", format: "jpeg" },
      { fileId: fileB, kind: "image", alt: "b", format: "jpeg" },
    ];
    state.failUploadFilenames = new Set(["retry-b.jpg"]);
    const { variantId } = await makeApprovedVariant({ media });
    await fileExecutingApproval(variantId, media);

    const first = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(first).toMatchObject({ ok: false, reason: DISPATCH_REFUSAL.mediaUploadFailed });
    expect(state.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(2); // a (ok), b (failed)
    expect(Object.keys(await uploadedMediaOf(variantId))).toEqual([fileA]);

    // A human fixes whatever made the upload fail and files a FRESH approval (SMM-09's
    // neverAutoRetry doctrine — no unattended retry on the same grant). The variant's CONTENT is
    // unchanged, so its hash is still valid; only the consumed grant needs replacing. This test
    // resets that state directly via SQL rather than through the composer's edit endpoint — it is
    // exercising dispatch.ts's own idempotency contract, not the edit flow. The FIRST approval also
    // needs its `execution_status` moved off 'executing' (mirroring what the real D14 executor does
    // once a hub round trip completes, `core/approval-execute.ts`'s own terminal UPDATE) — otherwise
    // `resolveExecutingApprovalId`'s ambiguity guard would see TWO 'executing' rows naming this
    // variant and refuse `approval_not_resolvable` instead of exercising the redispatch this test is
    // about.
    await withTenants([co], (c) =>
      c.query(
        `UPDATE automation_approvals SET execution_status = 'failed'
          WHERE tenant_id = $1 AND tool_name = $2 AND tool_args @> $3::jsonb AND execution_status = 'executing'`,
        [co, SOCIAL_PUBLISH_TOOL, JSON.stringify({ variantId })],
      ),
    );
    await withTenants([co], (c) =>
      c.query(`UPDATE social_post_variants SET approval_id = NULL, status = 'approved' WHERE id = $1`, [variantId]),
      MODULES,
    );
    state.failUploadFilenames = new Set(); // "fixed" — b now succeeds too
    await fileExecutingApproval(variantId, media);

    const second = await dispatchApprovedPublish(co, variantId, wfUser);
    expect(second.ok).toBe(true);
    // THE assertion this test exists for: a is NOT re-uploaded on the retry — only 1 more call
    // happens (b's retry), for a cumulative total of 3 (a-once, b-twice: once failed, once ok).
    expect(state.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(3);
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1); // only the 2nd attempt ever reaches it

    const uploaded = await uploadedMediaOf(variantId);
    expect(Object.keys(uploaded).sort()).toEqual([fileA, fileB].sort());
  });

  it("(T12) a text-only variant never touches files, storage, or uploadMedia — it must not acquire an upload round trip it never needed", async () => {
    const engagementId = await makeEngagement({ networks: { facebook: true } });
    const { variantId } = await makeApprovedVariant({ engagementId, media: [], accountId: fbAccount, settings: {} });
    await fileExecutingApproval(variantId, [], { accountId: fbAccount, settings: {} });

    const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

    expect(verdict.ok).toBe(true);
    expect(state.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(0);
    expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);
    expect(await uploadedMediaOf(variantId)).toEqual({});
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
    let tiktokFileId: string;

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
      // SMM-39 — a real `files` row backing the TikTok fixture's video attachment (was the literal
      // "v-1" with no `files` row at all — precisely the gap this ticket closes; T7 below now
      // exercises a real upload, not a no-op passthrough).
      tiktokFileId = await createFile("clip.mp4", "video/mp4", Buffer.from("fake-mp4-bytes"));
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
      const media = [{ fileId: tiktokFileId, kind: "video", format: "mp4" }];
      const hash = variantArgsSha256({
        tenantId: co, id: variantId, accountId: tiktokAccount, body: "tiktok body", firstComment: null,
        media, settings, scheduledAt: null,
      });
      await withTenants([co], async (c) => {
        await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
                       VALUES ($1,$2,$3,'tiktok post','approved','central')`, [postId, co, engagementId]);
        await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,'tiktok body',$5,$6,$7,'approved','central')`,
          [variantId, co, postId, tiktokAccount, JSON.stringify(media), JSON.stringify(settings), hash],
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
      // SMM-39 — the video attachment was actually uploaded before schedulePost, and the ref (not
      // the raw fileId) is what schedulePost received.
      expect(state.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(1);
      expect(state.lastScheduleRequest?.media).toEqual([{ id: "mock-media-clip.mp4", url: "https://mock.invalid/media/clip.mp4" }]);
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

  // ══ SMM-38 phase 38e — GAP 1, PROVEN ON THE LIVE DISPATCH PATH ═════════════════════════════════
  //
  // 38c/38d proved `direct`'s LinkedIn/YouTube methods correct against a resolved token
  // (`direct.test.ts`'s stub-`fetchImpl` cases) but named — three times over — that NOTHING on a
  // live dispatch path ever built that token or that handle. This block is the proof that changed:
  // a REAL `social_oauth_tokens` row, a REAL `resolveActiveAccessToken` call (through
  // `provisioning.ts#resolveDispatchOrgHandle`), and a SECOND registered driver (under key
  // `"direct"`) actually receiving the resolved bearer token — never asserted against a mock of the
  // resolution itself.
  describe("SMM-38e · resolveDispatchOrgHandle — the (network, capability) switch reaches `direct` for real", () => {
    let linkedinAccount: string;
    let directState: MockPublisherState;
    let capabilityDriversBefore: Record<string, string>;
    let organizationUrnBefore: string;
    let integrationTokenKeyBefore: string;
    let linkedinFileId: string;
    const ACCESS_TOKEN = "lg-real-bearer-token-never-logged";
    const ORG_URN = "urn:li:organization:99900";

    beforeAll(async () => {
      capabilityDriversBefore = config.social.publisher.capabilityDrivers;
      organizationUrnBefore = config.social.direct.linkedin.organizationUrn;
      config.social.direct.linkedin.organizationUrn = ORG_URN;
      // `storeOAuthGrant`/`resolveActiveAccessToken` seal through secret-box.ts, which fails closed
      // without a real key — set one for real, the same seam `oauth-tokens.test.ts` uses.
      integrationTokenKeyBefore = config.integrationTokenKey;
      config.integrationTokenKey = randomBytes(32).toString("base64");

      linkedinAccount = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO social_accounts
             (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
           VALUES ($1,$2,$3,$4,'linkedin',$5,$6,'connected','{}','central')`,
          [linkedinAccount, co, clientId, publisherOrgId, uniq("@brand-li"), uniq("direct:linkedin")]), MODULES);
      linkedinFileId = await createFile("li-photo.jpg", "image/jpeg", Buffer.from("fake-li-jpeg-bytes"));

      // The REAL grant, sealed through secret-box.ts and read back through resolveActiveAccessToken
      // — never a mock of the resolver itself.
      await withTenants([co], (c) =>
        storeOAuthGrant(c, {
          tenantId: co, accountId: linkedinAccount, network: "linkedin", accessToken: ACCESS_TOKEN,
          expiresAt: new Date(Date.now() + 3600_000),
        }), MODULES);
    });
    afterAll(async () => {
      config.social.publisher.capabilityDrivers = capabilityDriversBefore;
      config.social.direct.linkedin.organizationUrn = organizationUrnBefore;
      config.integrationTokenKey = integrationTokenKeyBefore;
    });
    beforeEach(() => {
      config.social.publisher.capabilityDrivers = {};
      state = newMockPublisherState();
      directState = newMockPublisherState();
      resetPublishers();
      registerPublisher(createMockPublisher(state));
      registerPublisher(createMockPublisher(directState, { key: "direct" }));
    });

    // `fileExecutingApproval`'s own body literal ("Hello from SMM-10's dispatch flow") is hardcoded
    // and re-used verbatim here — the approval-args hash must match the variant's own stored args
    // exactly, or the precondition refuses `args_hash_mismatch` before ever reaching this ticket's
    // own wiring.
    const BODY = "Hello from SMM-10's dispatch flow";

    async function makeLinkedinVariant(opts: { media?: unknown } = {}): Promise<{ variantId: string; media: unknown }> {
      const engagementId = await makeEngagement({ networks: { linkedin: true } });
      const postId = newId();
      const variantId = newId();
      const media = opts.media ?? [];
      const hash = variantArgsSha256({
        tenantId: co, id: variantId, accountId: linkedinAccount, body: BODY,
        firstComment: null, media, settings: {}, scheduledAt: null,
      });
      await withTenants([co], async (c) => {
        await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
                       VALUES ($1,$2,$3,'38e post','approved','central')`, [postId, co, engagementId]);
        await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,'approved','central')`,
          [variantId, co, postId, linkedinAccount, BODY, JSON.stringify(media), hash],
        );
      }, MODULES);
      return { variantId, media };
    }

    it("(D1) NO CONFIG OVERRIDE ⇒ the default stays inert: a linkedin-connected account still dispatches through the SAME driver as every other network, never `direct`", async () => {
      // capabilityDrivers is {} (beforeEach) — the ticket's own required property, proven, not assumed.
      const { variantId } = await makeLinkedinVariant();
      await fileExecutingApproval(variantId, [], { accountId: linkedinAccount, settings: {} });

      const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

      expect(verdict).toMatchObject({ ok: true, network: "linkedin" });
      expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);
      expect(directState.calls).toHaveLength(0);
    });

    it("(D2) `linkedin:schedule` + `linkedin:media_upload` overridden to `direct` ⇒ BOTH calls land " +
       "on the direct driver, with the REAL resolved token and the configured org URN — never the " +
       "postiz mock", async () => {
      config.social.publisher.capabilityDrivers = { "linkedin:schedule": "direct", "linkedin:media_upload": "direct" };
      const media = [{ fileId: linkedinFileId, kind: "image", format: "jpeg" }];
      const { variantId } = await makeLinkedinVariant({ media });
      await fileExecutingApproval(variantId, media, { accountId: linkedinAccount, settings: {} });

      const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

      expect(verdict).toMatchObject({ ok: true, network: "linkedin" });
      // Nothing reached the postiz mock at all — full per-network routing, not a partial one.
      expect(state.calls).toHaveLength(0);
      expect(directState.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(1);
      expect(directState.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);
      // The org id every call carried is the ORG URN config's own value, never the Postiz org row's
      // postiz_org_id — proving `resolveDispatchOrgHandle` built the direct-shaped handle, not the
      // Postiz-shaped one.
      expect(directState.calls.every((c) => c.orgId === ORG_URN)).toBe(true);
    });

    it("(D3) PER-CAPABILITY, NOT PER-NETWORK: only `linkedin:media_upload` overridden ⇒ the upload " +
       "reaches `direct`, the schedule call still reaches the SAME driver every other capability uses " +
       "— proving the switch really is keyed on (network, capability), not network alone", async () => {
      config.social.publisher.capabilityDrivers = { "linkedin:media_upload": "direct" };
      const media = [{ fileId: linkedinFileId, kind: "image", format: "jpeg" }];
      const { variantId } = await makeLinkedinVariant({ media });
      await fileExecutingApproval(variantId, media, { accountId: linkedinAccount, settings: {} });

      const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

      expect(verdict).toMatchObject({ ok: true, network: "linkedin" });
      expect(directState.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(1);
      expect(directState.calls.filter((c) => c.op === "schedulePost")).toHaveLength(0);
      expect(state.calls.filter((c) => c.op === "schedulePost")).toHaveLength(1);
      expect(state.calls.filter((c) => c.op === "uploadMedia")).toHaveLength(0);
    });

    it("(D4) a REVOKED grant fails closed through the real path — never a crash, never a stray " +
       "publish, the approval still consumed (design's own neverAutoRetry doctrine)", async () => {
      config.social.publisher.capabilityDrivers = { "linkedin:schedule": "direct" };
      const revoked = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO social_accounts
             (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
           VALUES ($1,$2,$3,$4,'linkedin',$5,$6,'connected','{}','central')`,
          [revoked, co, clientId, publisherOrgId, uniq("@brand-li-revoked"), uniq("direct:linkedin")]), MODULES);
      await withTenants([co], (c) =>
        storeOAuthGrant(c, {
          tenantId: co, accountId: revoked, network: "linkedin", accessToken: "will-be-revoked",
          expiresAt: new Date(Date.now() + 3600_000),
        }), MODULES);
      await withTenants([co], (c) => revokeOAuthGrant(c, revoked, "38e test — deliberately revoked"), MODULES);

      const engagementId = await makeEngagement({ networks: { linkedin: true } });
      const postId = newId();
      const variantId = newId();
      const hash = variantArgsSha256({
        tenantId: co, id: variantId, accountId: revoked, body: BODY, firstComment: null,
        media: [], settings: {}, scheduledAt: null,
      });
      await withTenants([co], async (c) => {
        await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
                       VALUES ($1,$2,$3,'38e revoked post','approved','central')`, [postId, co, engagementId]);
        await c.query(
          `INSERT INTO social_post_variants
             (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
           VALUES ($1,$2,$3,$4,$5,'[]','{}',$6,'approved','central')`,
          [variantId, co, postId, revoked, BODY, hash],
        );
      }, MODULES);
      await fileExecutingApproval(variantId, [], { accountId: revoked, settings: {} });

      const verdict = await dispatchApprovedPublish(co, variantId, wfUser);

      expect(verdict.ok).toBe(false);
      if (verdict.ok) throw new Error("unreachable");
      expect(verdict.reason).toBe("dispatch_error");
      expect(directState.calls).toHaveLength(0);
      expect(state.calls).toHaveLength(0);
      // The approval is STILL consumed — the same neverAutoRetry property every other dispatch
      // failure in this file already proves, now for a token-resolution failure too.
      const row = await variantRow(variantId);
      expect(row.status).toBe("failed");
      expect(row.approvalId).not.toBeNull();
      expect(row.lastError).toContain("oauth_token_revoked");
    });
  });
});
