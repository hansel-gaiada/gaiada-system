// SCP-Sc — the simulated publisher on the real dispatch path, end to end, against live Postgres and Cerbos (needs DATABASE_URL_TEST:
// NOT run on the dev laptop, runs on the Linux CI gate; a skip is not a pass). Every case drives the REAL routes as real personas with the
// real policies, then the REAL D14 executor (`executeApprovedAutomationWrite`) whose hub call is a stub that does what mcp-hub does:
// re-drive `dispatchApprovedPublish` (the dispatch endpoint's body) as the filing principal. Nothing here sets a variant's status by hand
// except the cases that say so.
//
// Proves (BFF §63.10 "The publisher's result", plan §5, §8 rows Sc and 3b):
//   (1) `schedule_publisher` is offered on simulated accounts while the switch is on (`publisherAvailable`), and refused
//       409 `publisher_unavailable` with it off, with the account set unchanged;
//   (2) schedule_publisher -> a SECOND approver decides -> the executor dispatches -> the post's time comes (the every-minute due job)
//       -> the post is `live` with a https://simulated.invalid/ link and `simulated = true`; the activity row (no person) and the
//       officer's notification exist ONCE, and replaying the reconcile, the settle and the due job changes nothing;
//   (3) "Publish now (simulated)": the same result before the time; refused to the officer, to a non-approver and to an automation
//       (403), and with 409 `simulation_disabled` / `simulated_approval_not_decided` / `simulated_not_dispatched` /
//       `not_scheduled_by_publisher`; it never mints or decides an approval (the approval rows are the same before and after);
//   (4) the failure keyword: `[simulate-fail]` -> the variant `failed`, `social.post.failed` emitted, the post STAYS `scheduled` with
//       engine status `failed`, the activity row written once, the page's read says so, and an approver may unschedule it;
//       the failed variant's mark goes with the dispatch it records, so the post then posted by hand (after the unschedule, or
//       marked live straight from the failed schedule) is not `simulated`; a variant the simulator PUBLISHED keeps its mark;
//   (5) the switch OFF: the due job does nothing, a dispatch refuses `simulation_disabled` (the variant is not marked simulated),
//       a queued simulated variant stays queued and nothing goes live;
//   (6) a Composer post and a post scheduled by hand are untouched by all of it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId, withGlobal } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, linkIdentity } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { setStorageForTest } from "../../../core/storage";
import { executeApprovedAutomationWrite } from "../../../core/approval-execute";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { registerPublisher, resetPublishers } from "../publisher/registry";
import { createSimulatedPublisher } from "../publisher/simulated-driver";
import { dispatchApprovedPublish, type DispatchVerdict } from "../dispatch";
import { reconcileTenantPostStatus } from "../post-status-sync-job";
import { runSimulatedDueSweep } from "../simulated-due-job";
import { settlePublisherResults } from "./publisher-result";
import { variantArgsSha256 } from "../canonical-args";
import { MUST_HAVE_KEYS } from "./handoff-checks";

const FUTURE = "2027-03-10T10:00:00.000Z";
const SOCIAL = { modules: ["social"] };
const HUB = "http://hub.scpsc.test";

type Who = string;
const SVC = { authorization: "Bearer svc-token" };
const headersFor = (who: Who) => ({ ...SVC, "x-user-id": who });

interface Eng { clientId: string; engagementId: string; cycleId: string; officer: string }

describe.skipIf(!TEST_URL)("SCP-Sc · the simulated publisher on the real dispatch path (BFF §63.10)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  let assetId: string;
  let n = 0;
  const before = { flag: config.socialSimulationEnabled, secret: config.approvalGrantSecret, hub: config.services.hub };
  const memStore = new Map<string, Buffer>();
  const realFetch = globalThis.fetch;
  /** The simulator's clock: null = real time; a number pins "now" (the due job needs the approved time to have come). */
  const clock: { at: number | null } = { at: null };
  let hubHandler: (() => Promise<void>) | null = null;
  const verdicts: DispatchVerdict[] = [];
  const base = () => `/api/${A}/modules/social`;

  // ── fixtures (the shapes pipeline-routes.test.ts uses) ───────────────────────────────────────────────────────────────
  async function freshEngagement(): Promise<Eng> {
    n += 1;
    const clientId = await createClient(A, `Mock Sim Client ${n}`);
    const engagementId = newId();
    const cycleId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'creatives', $7, 'central')`,
        [engagementId, A, clientId, `Mock sim engagement ${n}`, U.officer, JSON.stringify({ networks: { instagram: true } }), ["instagram"]],
      );
      const orgId = newId();
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, A, clientId, `mock-sim-org-${n}-${newId().slice(0, 8)}`],
      );
      // The seeded mock account: simulated = true (SCP-Sb will seed these; a suite writes the mark directly, as simulated-dispatch.db.test.ts does).
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, simulated, origin_site)
         VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $6, true, 'central')`,
        [newId(), A, clientId, orgId, `@mock-sim-${n}`, `simulated:instagram:${n}`],
      );
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         VALUES ($1, $2, $3, '2027-03-01', '2027-02-26', '2027-02-24', 'central')`,
        [cycleId, A, engagementId],
      );
    }, SOCIAL);
    return { clientId, engagementId, cycleId, officer: U.officer };
  }

  async function row(postId: string) {
    const r = await adminPool().query(
      `SELECT pipeline_status, schedule_via, status, live_url, went_live_at, simulated FROM social_posts WHERE id = $1`, [postId]);
    return r.rows[0] as { pipeline_status: string | null; schedule_via: string | null; status: string; live_url: string | null; went_live_at: Date | null; simulated: boolean };
  }
  async function act(who: Who, postId: string, action: string, body: Record<string, unknown> = {}) {
    const expectedStatus = body.expectedStatus ?? (await row(postId)).pipeline_status ?? "planned";
    return app.inject({ method: "POST", url: `${base()}/posts/${postId}/actions`, headers: headersFor(who), payload: { action, expectedStatus, ...body } });
  }
  async function ok(res: Awaited<ReturnType<typeof act>>, label: string) {
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${label}: ${res.statusCode} ${res.body}`);
    return res.json() as { post: Record<string, any> };
  }
  async function newPost(eng: Eng) {
    const res = await app.inject({
      method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: headersFor(eng.officer),
      payload: { title: "Mock bakery: morning pastries", format: "feed", scheduledAt: FUTURE, placement: ["instagram"] },
    });
    return (await ok(res, "create")).post.id as string;
  }

  /** Drive a post through the real routes to `approved` (the client's approval recorded by the officer). */
  async function driveToApproved(eng: Eng, postId: string, caption = "Fresh pastries every morning.") {
    await ok(await act(eng.officer, postId, "start_draft"), "start_draft");
    await ok(await app.inject({
      method: "PATCH", url: `${base()}/posts/${postId}/pipeline`, headers: headersFor(eng.officer),
      payload: {
        expectedStatus: "drafting",
        fields: { caption, onAssetText: "Open daily", cta: "Visit us", hashtags: ["mockbakery"], mustHaves: [...MUST_HAVE_KEYS],
          rawAssets: [{ url: "https://example.invalid/ref.jpg", label: "Reference", source: "own" }] },
      },
    }), "fill");
    await ok(await act(eng.officer, postId, "send_to_proofread"), "send_to_proofread");
    await ok(await act(U.copywriter, postId, "approve_copy"), "approve_copy");
    await ok(await act(U.hod, postId, "approve_for_design"), "approve_for_design");
    await adminPool().query(
      `UPDATE pm_tasks SET assignee = jsonb_set(COALESCE(assignee, '{}'::jsonb), '{responsibleId}', to_jsonb($2::text))
        WHERE id = (SELECT pm_task_id FROM work_requests WHERE id = (SELECT creative_request_id FROM social_posts WHERE id = $1))`,
      [postId, U.designer],
    );
    await ok(await act(U.designer, postId, "start_design"), "start_design");
    await ok(await app.inject({ method: "POST", url: `${base()}/posts/${postId}/designs`, headers: headersFor(U.designer), payload: { expectedStatus: "design", assetGroupId: assetId } }), "add_design");
    await ok(await act(U.designer, postId, "submit_design"), "submit_design");
    await ok(await act(U.hod, postId, "final_approve"), "final_approve");
    await ok(await act(eng.officer, postId, "record_client_approve", { channel: "whatsapp", note: "Approved on a call." }), "record_client_approve");
  }

  const variantsOf = async (postId: string) => (await adminPool().query(
    `SELECT id::text AS id, status, provider_post_id, published_url, simulated, last_error, approval_id
       FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL ORDER BY id`, [postId])).rows as Array<{
    id: string; status: string; provider_post_id: string | null; published_url: string | null; simulated: boolean; last_error: string | null; approval_id: string | null }>;
  const approvalsOf = async (postId: string) => (await adminPool().query(
    `SELECT id::text AS id, tool_args->>'variantId' AS variant_id, status, execution_status, decided_by::text AS decided_by
       FROM automation_approvals WHERE tool_name = 'social.publishPost'
        AND tool_args->>'variantId' IN (SELECT id::text FROM social_post_variants WHERE post_id = $1) ORDER BY id`, [postId])).rows as Array<{
    id: string; variant_id: string; status: string; execution_status: string; decided_by: string | null }>;
  const count = async (sql: string, params: unknown[]) => Number((await adminPool().query(sql, params)).rows[0].n);
  const activityCount = (postId: string, verb: string) => count(
    `SELECT count(*)::int AS n FROM activities WHERE target_entity_type = 'social_post' AND target_entity_id = $1 AND verb = $2`, [postId, verb]);
  const wentLiveNotices = (postId: string) => count(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'social.post.went_live' AND payload->>'entityId' = $1`, [postId]);

  /** The second person decides one publish approval through the real route, then the real executor runs it; the hub stub re-drives dispatch. */
  async function decideAndExecute(approvalId: string, variantId: string, decider = U.gm) {
    const d = await app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: headersFor(decider), payload: { decision: "approved" } });
    expect(d.statusCode, d.body).toBe(200);
    hubHandler = async () => { verdicts.push(await dispatchApprovedPublish(A, variantId, U.hod)); };
    try {
      return await executeApprovedAutomationWrite(A, approvalId);
    } finally {
      hubHandler = null;
    }
  }
  async function decideOnly(approvalId: string) {
    const d = await app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: headersFor(U.gm), payload: { decision: "approved" } });
    expect(d.statusCode, d.body).toBe(200);
  }

  /** A post at `scheduled` through the publisher, its publish approvals decided by the GM and executed (the variants queued). */
  async function scheduledAndDispatched(caption?: string) {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveToApproved(eng, postId, caption);
    await ok(await act(U.hod, postId, "schedule_publisher"), "schedule_publisher");
    for (const a of await approvalsOf(postId)) {
      const out = await decideAndExecute(a.id, a.variant_id);
      expect(out.status, JSON.stringify(out)).toBe("executed");
    }
    return { eng, postId };
  }
  const publishNow = (who: Who, postId: string) => app.inject({ method: "POST", url: `${base()}/posts/${postId}/simulated-publish-now`, headers: headersFor(who) });
  const read = (who: Who, postId: string) => app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: headersFor(who) });

  // ── setup ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = "scp-sc-test-secret-not-a-real-one";
    config.services.hub = { url: HUB, token: "hub-token", assuranceToken: "" };
    setStorageForTest({
      put: async (k, d) => { memStore.set(k, d); },
      get: async (k) => { const b = memStore.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { memStore.delete(k); },
    });
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Sim Agency", ["social", "pm"]);
    const units = await seedSocialOrgTree(A);
    for (const p of ["officer", "copywriter", "hod", "gm", "designer", "companyAdmin", "bot"]) {
      U[p] = await createUser(`scpsc-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
      await grantSocialRole(A, U[p], "member");
    }
    await withGlobal((c) => c.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [U.bot]));
    for (const p of ["officer", "copywriter", "hod", "gm"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.companyAdmin, "company_admin");
    await grantSocialSeat(A, units.socialMedia, U.hod);
    await grantSocialSeat(A, units.gm, U.gm);
    // The filing principal of the executor's hub call needs a verified identity link (approval-execute.ts, invariant 1).
    for (const p of ["officer", "hod", "gm"]) await linkIdentity(U[p], "whatsapp", `wa-scpsc-${p}`, true);

    assetId = newId();
    const gradedKey = `mock/${assetId}.jpg`;
    memStore.set(gradedKey, Buffer.from("mock-jpeg-bytes"));
    await adminPool().query(
      `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
       VALUES ($1, $2, $3, 'Mock design', 'image/jpeg', '{}'::jsonb, $4, 15, 'central')`,
      [assetId, A, U.designer, gradedKey],
    );
    app = await buildApp();
  });
  afterAll(async () => {
    config.socialSimulationEnabled = before.flag;
    config.approvalGrantSecret = before.secret;
    config.services.hub = before.hub;
    resetPublishers();
    await app?.close();
    await teardownTestDb();
  });
  beforeEach(() => {
    config.socialSimulationEnabled = true;
    clock.at = null;
    verdicts.length = 0;
    resetPublishers();
    registerPublisher(createSimulatedPublisher({ now: () => clock.at ?? Date.now() }));
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: unknown) => {
      if (!String(url).startsWith(HUB)) return realFetch(url as never, init as never);
      if (hubHandler) await hubHandler();
      return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n\n" };
    }) as unknown as typeof fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    config.socialSimulationEnabled = true;
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) publisherAvailable
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("schedule_publisher is offered on simulated accounts while the switch is on, and is 409 publisher_unavailable with it off", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveToApproved(eng, postId);
    const offered = await read(U.hod, postId);
    expect(offered.json().actions.find((a: { action: string }) => a.action === "schedule_publisher")).toMatchObject({ allowed: true });

    config.socialSimulationEnabled = false;
    const refused = await act(U.hod, postId, "schedule_publisher");
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe("publisher_unavailable");
    expect((await row(postId)).pipeline_status).toBe("approved");
    config.socialSimulationEnabled = true;

    const done = await ok(await act(U.hod, postId, "schedule_publisher"), "schedule_publisher");
    expect(done.post.scheduleVia).toBe("publisher");
    expect(await approvalsOf(postId)).toHaveLength(1);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) schedule_publisher -> decided -> dispatched -> the due job -> live
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the due job makes a decided, dispatched simulated post live at its time: a simulated.invalid link, simulated = true, one activity row and one notice, replay-safe", async () => {
    const { postId } = await scheduledAndDispatched();
    const approvals = await approvalsOf(postId);
    expect(approvals.map((a) => [a.status, a.execution_status, a.decided_by])).toEqual([["approved", "executed", U.gm]]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ ok: true });
    let vs = await variantsOf(postId);
    expect(vs[0]).toMatchObject({ status: "queued", simulated: true });
    expect(vs[0].provider_post_id).toMatch(/^simulated:instagram:\d+:[0-9a-f-]{36}$/);
    expect(vs[0].provider_post_id!.split(":")[2]).toBe(String(Date.parse(FUTURE)));

    // Before its time the due job finds the variant queued and the post stays scheduled.
    const early = await runSimulatedDueSweep(new Date(), [A]);
    expect(early).toMatchObject({ skipped: false, tenants: 1, reconciled: 1, applied: 0, errors: 0 });
    expect((await row(postId)).pipeline_status).toBe("scheduled");
    expect((await variantsOf(postId))[0].status).toBe("queued");

    // The approved time comes.
    clock.at = Date.parse(FUTURE) + 1000;
    const due = await runSimulatedDueSweep(new Date(), [A]);
    expect(due).toMatchObject({ skipped: false, reconciled: 1, applied: 1, errors: 0 });
    vs = await variantsOf(postId);
    expect(vs[0].status).toBe("published");
    expect(vs[0].published_url).toMatch(/^https:\/\/simulated\.invalid\/instagram\/[0-9a-f-]{36}$/);
    const p = await row(postId);
    expect(p).toMatchObject({ pipeline_status: "live", status: "published", simulated: true, schedule_via: "publisher" });
    expect(p.live_url).toBe(vs[0].published_url);
    expect(new Date(p.went_live_at!).toISOString()).toBe(FUTURE);
    expect(await activityCount(postId, "mark_live")).toBe(1);
    const a = await adminPool().query(`SELECT actor_id, metadata FROM activities WHERE target_entity_id = $1 AND verb = 'mark_live'`, [postId]);
    expect(a.rows[0].actor_id).toBeNull(); // the publisher is a system actor: no person
    expect(a.rows[0].metadata).toMatchObject({ from: "scheduled", to: "live", simulated: true, viaPublisher: true });
    expect(await wentLiveNotices(postId)).toBe(1);
    const notice = await adminPool().query(`SELECT user_id::text AS u FROM notifications WHERE type = 'social.post.went_live' AND payload->>'entityId' = $1`, [postId]);
    expect(notice.rows[0].u).toBe(U.officer);

    // Replays change nothing: the sweep, the tenant reconcile, the settle, and the due job again.
    expect(await runSimulatedDueSweep(new Date(), [A])).toMatchObject({ reconciled: 0, applied: 0 });
    await reconcileTenantPostStatus(A);
    expect(await settlePublisherResults(A, { variantIds: [vs[0].id] })).toEqual({ live: [], failed: [], errors: 0 });
    expect(await activityCount(postId, "mark_live")).toBe(1);
    expect(await wentLiveNotices(postId)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM activities WHERE target_entity_id = $1 AND verb = 'published'`, [vs[0].id])).toBe(1);

    // The page says so.
    const page = (await read(U.officer, postId)).json();
    expect(page).toMatchObject({ pipelineStatus: "live", engineStatus: "published", simulated: true, liveUrl: p.live_url });
    expect(page.simulatedPublishNow).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) Publish now (simulated)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("Publish now makes it live before its time, through the same path, and never mints or decides an approval", async () => {
    const { postId } = await scheduledAndDispatched();
    const approvalsBefore = await approvalsOf(postId);

    // The page offers it to one of the four (the GM), shows it disabled with its reason to the officer, and not at all to a non-approver.
    expect((await read(U.gm, postId)).json().simulatedPublishNow).toEqual({ allowed: true });
    expect((await read(U.officer, postId)).json().simulatedPublishNow).toEqual({ allowed: false, reason: "not_an_approver" });

    const res = await publishNow(U.gm, postId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ advanced: 1, live: true });
    expect(res.json().post).toMatchObject({ pipelineStatus: "live", simulated: true });
    const vs = await variantsOf(postId);
    expect(vs[0]).toMatchObject({ status: "published", simulated: true });
    expect(vs[0].published_url).toMatch(/^https:\/\/simulated\.invalid\//);
    const p = await row(postId);
    expect(p).toMatchObject({ pipeline_status: "live", simulated: true, live_url: vs[0].published_url });
    expect(await activityCount(postId, "mark_live")).toBe(1);
    expect(await activityCount(postId, "simulated_publish_now")).toBe(1);
    expect(await wentLiveNotices(postId)).toBe(1);
    // Approvals: the same rows in the same state.
    expect(await approvalsOf(postId)).toEqual(approvalsBefore);
    expect(await count(`SELECT count(*)::int AS n FROM automation_approvals WHERE tool_args->>'variantId' = $1`, [vs[0].id])).toBe(1);

    // A second press: the post is live now, so it is no longer one scheduled through the publisher.
    const again = await publishNow(U.gm, postId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("not_scheduled_by_publisher");
    expect(await activityCount(postId, "mark_live")).toBe(1);
    expect(await wentLiveNotices(postId)).toBe(1);
  });

  it("Publish now is refused to the officer, a non-approver and an automation (403, before anything is judged), and an unknown post is 404", async () => {
    const { postId } = await scheduledAndDispatched();
    for (const who of [U.officer, U.copywriter, U.companyAdmin]) {
      const r = await publishNow(who, postId);
      expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
    }
    const bot = await publishNow(U.bot, postId);
    expect(bot.statusCode).toBe(403);
    expect((await publishNow(U.gm, newId())).statusCode).toBe(404);
    // Nothing moved.
    expect((await row(postId)).pipeline_status).toBe("scheduled");
    expect((await variantsOf(postId))[0].status).toBe("queued");
    // The refusals are audited as denials by `authorize()`, never as a publish.
    expect(await activityCount(postId, "simulated_publish_now")).toBe(0);
  });

  it("Publish now refuses 409 simulated_approval_not_decided until every variant's approval is decided, and simulated_not_dispatched until the executor queued it", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveToApproved(eng, postId);
    await ok(await act(U.hod, postId, "schedule_publisher"), "schedule_publisher");
    const [approval] = await approvalsOf(postId);

    const undecided = await publishNow(U.gm, postId);
    expect(undecided.statusCode, undecided.body).toBe(409);
    expect(undecided.json().error).toBe("simulated_approval_not_decided");
    expect((await read(U.gm, postId)).json().simulatedPublishNow).toEqual({ allowed: false, reason: "simulated_approval_not_decided" });

    // A withdrawn approval is not a decided one either (a post with no live filing).
    await adminPool().query(`UPDATE automation_approvals SET status = 'cancelled' WHERE id = $1`, [approval.id]);
    expect((await publishNow(U.gm, postId)).json().error).toBe("simulated_approval_not_decided");
    await adminPool().query(`UPDATE automation_approvals SET status = 'pending' WHERE id = $1`, [approval.id]);

    // Decided, but the executor has not run: the variant is still `approved`, and this route never dispatches.
    await decideOnly(approval.id);
    const notDispatched = await publishNow(U.gm, postId);
    expect(notDispatched.statusCode, notDispatched.body).toBe(409);
    expect(notDispatched.json().error).toBe("simulated_not_dispatched");
    expect((await variantsOf(postId))[0]).toMatchObject({ status: "approved", provider_post_id: null });
    expect((await approvalsOf(postId))[0]).toMatchObject({ status: "approved", execution_status: "pending" });
  });

  it("Publish now is 409 not_scheduled_by_publisher for a post scheduled by hand, and its read offers nothing", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveToApproved(eng, postId);
    await ok(await act(eng.officer, postId, "schedule"), "schedule");
    const r = await publishNow(U.gm, postId);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("not_scheduled_by_publisher");
    expect((await read(U.gm, postId)).json().simulatedPublishNow).toBeNull();
    // The results path does not touch a hand schedule either, even if its variant says published.
    // A hand schedule's variant holds no publish approval, so the only way it can say `published` is as 0105's
    // native-import bookkeeping row (svar_dispatched_has_approval, svar_native_import_is_bookkeeping).
    await adminPool().query(`UPDATE social_post_variants SET status = 'published', native_import = true WHERE post_id = $1`, [postId]);
    const [hand] = await variantsOf(postId);
    expect(await settlePublisherResults(A, { variantIds: [hand.id] })).toEqual({ live: [], failed: [], errors: 0 });
    expect(await row(postId)).toMatchObject({ pipeline_status: "scheduled", schedule_via: "manual" });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the failure keyword
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("[simulate-fail]: the variant fails, social.post.failed is emitted, the post stays scheduled with engine status failed, once, and an approver can unschedule it", async () => {
    const { postId } = await scheduledAndDispatched("Fresh pastries every morning. [simulate-fail]");
    expect(verdicts[0]).toMatchObject({ ok: false, stage: "dispatch", reason: "dispatch_error" });
    const vs = await variantsOf(postId);
    // The simulator served the refused dispatch, so the variant carries its mark (simulated-dispatch.db.test.ts S2).
    expect(vs[0]).toMatchObject({ status: "failed", simulated: true, provider_post_id: null });
    expect(vs[0].last_error).toContain("simulated_publish_failed");
    expect(await count(`SELECT count(*)::int AS n FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1 AND event_type = 'social.post.failed'`, [vs[0].id])).toBe(1);

    expect(await row(postId)).toMatchObject({ pipeline_status: "scheduled", schedule_via: "publisher", status: "failed", live_url: null });
    expect(await activityCount(postId, "publisher_failed")).toBe(1);
    expect(await activityCount(postId, "mark_live")).toBe(0);

    // Replays: the reconcile, the settle and the due job write nothing more.
    await reconcileTenantPostStatus(A);
    expect(await settlePublisherResults(A, { variantIds: [vs[0].id] })).toEqual({ live: [], failed: [], errors: 0 });
    await runSimulatedDueSweep(new Date(), [A]);
    expect(await activityCount(postId, "publisher_failed")).toBe(1);
    expect(await row(postId)).toMatchObject({ pipeline_status: "scheduled", status: "failed" });

    // The officer sees it on the post page: the engine status and the variant's recorded failure.
    const page = (await read(U.officer, postId)).json();
    expect(page).toMatchObject({ pipelineStatus: "scheduled", engineStatus: "failed" });
    expect(page.variants[0]).toMatchObject({ status: "failed" });
    expect(page.variants[0].lastError).toContain("simulated_publish_failed");
    // Publish now has nothing to publish on a failed variant.
    expect((await publishNow(U.gm, postId)).json().error).toBe("simulated_not_dispatched");

    // An approver may unschedule it; the client's approval stands.
    const off = await ok(await act(U.gm, postId, "unschedule"), "unschedule");
    expect(off.post.pipelineStatus).toBe("approved");
    expect(await row(postId)).toMatchObject({ pipeline_status: "approved", status: "approved", schedule_via: null });
  });

  // The SCP-3 live walk (2026-10-29) left a post live BY HAND with `simulated = true`: the failed variant's mark outlived the
  // reset, and the purge refuses that shape (`hand_schedule_marked_simulated`).
  it("[simulate-fail], unscheduled, then posted by hand: the reset drops the failed variant's mark and the hand-made go-live is not simulated", async () => {
    const { eng, postId } = await scheduledAndDispatched("Fresh pastries every morning. [simulate-fail]");
    expect((await variantsOf(postId))[0]).toMatchObject({ status: "failed", simulated: true });
    await ok(await act(U.gm, postId, "unschedule"), "unschedule");
    expect((await variantsOf(postId))[0]).toMatchObject({ status: "draft", simulated: false, provider_post_id: null, approval_id: null });

    await ok(await act(eng.officer, postId, "schedule"), "schedule");
    await ok(await act(eng.officer, postId, "mark_live", { url: "https://example.invalid/mock-bakery/by-hand" }), "mark_live");
    expect(await row(postId)).toMatchObject({ pipeline_status: "live", schedule_via: "manual", simulated: false, live_url: "https://example.invalid/mock-bakery/by-hand" });
    expect((await variantsOf(postId))[0]).toMatchObject({ status: "published", simulated: false });
    expect((await read(U.officer, postId)).json()).toMatchObject({ pipelineStatus: "live", simulated: false });
  });

  it("[simulate-fail], then the officer marks it live by hand straight from the failed schedule: the failed variant's mark goes", async () => {
    const { eng, postId } = await scheduledAndDispatched("Fresh pastries every morning. [simulate-fail]");
    await ok(await act(eng.officer, postId, "mark_live", { url: "https://example.invalid/mock-bakery/by-hand" }), "mark_live");
    expect(await row(postId)).toMatchObject({ pipeline_status: "live", simulated: false });
    expect((await variantsOf(postId))[0]).toMatchObject({ status: "published", simulated: false });
  });

  it("a variant the simulator PUBLISHED keeps its mark when the officer marks the post live by hand", async () => {
    const { eng, postId } = await scheduledAndDispatched();
    // Set by hand, as this case says: the simulator has published the variant and the post is not settled yet (the reconcile
    // settles it at once, so the window cannot be reached through the routes with one variant).
    await adminPool().query(
      `UPDATE social_post_variants SET status = 'published', published_url = 'https://simulated.invalid/instagram/' || gen_random_uuid(), published_at = now()
        WHERE post_id = $1`, [postId]);
    await ok(await act(eng.officer, postId, "mark_live", { url: "https://example.invalid/mock-bakery/by-hand" }), "mark_live");
    expect(await row(postId)).toMatchObject({ pipeline_status: "live", simulated: true });
    expect((await variantsOf(postId))[0]).toMatchObject({ status: "published", simulated: true });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) the switch off
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("with the switch OFF: the due job does nothing, a queued simulated variant stays queued, nothing goes live, and Publish now is 409 simulation_disabled", async () => {
    const { postId } = await scheduledAndDispatched();
    config.socialSimulationEnabled = false;
    clock.at = Date.parse(FUTURE) + 1000;
    expect(await runSimulatedDueSweep(new Date(), [A])).toEqual({ skipped: true, tenants: 0, reconciled: 0, applied: 0, errors: 0 });
    const swept = await reconcileTenantPostStatus(A);
    expect(swept.applied).toBe(0);
    expect((await variantsOf(postId))[0].status).toBe("queued");
    expect((await row(postId)).pipeline_status).toBe("scheduled");
    const r = await publishNow(U.gm, postId);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("simulation_disabled");
    expect((await read(U.gm, postId)).json().simulatedPublishNow).toBeNull();
    expect(await activityCount(postId, "mark_live")).toBe(0);
  });

  it("with the switch OFF a decided approval does not dispatch: the variant fails simulation_disabled and is not marked simulated, and the post does not go live", async () => {
    const eng = await freshEngagement();
    const postId = await newPost(eng);
    await driveToApproved(eng, postId);
    await ok(await act(U.hod, postId, "schedule_publisher"), "schedule_publisher");
    config.socialSimulationEnabled = false;
    const [a] = await approvalsOf(postId);
    await decideAndExecute(a.id, a.variant_id);
    expect(verdicts[0]).toMatchObject({ ok: false });
    const vs = await variantsOf(postId);
    expect(vs[0]).toMatchObject({ status: "failed", simulated: false });
    expect(vs[0].last_error).toContain("simulation_disabled");
    expect(await row(postId)).toMatchObject({ pipeline_status: "scheduled", status: "failed", live_url: null, simulated: false });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) a Composer post is unchanged
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("a Composer post (no pipeline status): its simulated variant is published by the sweep exactly as before, and the post row is untouched", async () => {
    const clientId = await createClient(A, "Mock Composer Client");
    const engagementId = newId();
    const postId = newId();
    const variantId = newId();
    const accountId = newId();
    const orgId = newId();
    const approvalId = newId();
    const body = "A mock caption";
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'Composer engagement','active',$4,10,'central')`, [engagementId, A, clientId, JSON.stringify({ networks: { facebook: true } })]);
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`, [orgId, A, clientId, `composer-org-${newId().slice(0, 8)}`]);
      await c.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, simulated, origin_site)
         VALUES ($1,$2,$3,$4,'facebook','@mock-composer','simulated:facebook','connected','{}',true,'central')`, [accountId, A, clientId, orgId]);
      await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1,$2,$3,'Composer post','approved','central')`, [postId, A, engagementId]);
    }, SOCIAL);
    await adminPool().query(
      `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
       VALUES ($1,$2,'wf:delivery','social.publishPost',$3,'high','approved',$4,$5,now(),'automation','main','executed')`,
      [approvalId, A, JSON.stringify({ variantId }), U.hod, U.gm]);
    await withTenants([A], (c) => c.query(
      `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, provider_post_id, approval_id, simulated, origin_site)
       VALUES ($1,$2,$3,$4,$5,'[]','{}',$6,'queued',$7,$8,true,'central')`,
      [variantId, A, postId, accountId, body, variantArgsSha256({ tenantId: A, id: variantId, accountId, body, media: [], settings: {}, firstComment: null, scheduledAt: null }),
       `simulated:facebook:${Date.now() - 1000}:${newId()}`, approvalId]), SOCIAL);

    const sweep = await reconcileTenantPostStatus(A);
    expect(sweep.errors).toBe(0);
    expect((await variantsOf(postId))[0].status).toBe("published");
    expect(await row(postId)).toMatchObject({ pipeline_status: null, schedule_via: null, status: "approved", live_url: null, went_live_at: null, simulated: false });
    expect(await activityCount(postId, "mark_live")).toBe(0);
    expect(await activityCount(postId, "publisher_failed")).toBe(0);
    expect(await wentLiveNotices(postId)).toBe(0);
  });
});
