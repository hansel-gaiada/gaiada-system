// SCP-2 (lane A) — the client's approval page of the content pipeline, against live Postgres and Cerbos (FRONTEND-BFF-CONTRACT
// §63.9, §63.14, §63.21 "Variants and the client" and "The portal"). Skips without DATABASE_URL_TEST; on CI it runs for real.
// Every case drives the REAL endpoints as a real portal contact (a `client_contacts` row and the `client` role) or a real staff
// persona, never a service function with the authorization mocked out.
//
// What it proves:
//   (1) reads: the shape of `PortalSocialPost`, nothing internal in it, a team comment never appears, a post that has not
//       reached the client is 404, another client's post is 404, the tabs, the counts, the paging and the stories;
//   (2) decisions: one decision updates every variant review in one transaction (a forced failure leaves none changed), the
//       portal shape of the decision columns, the legacy per-variant event is not emitted, the order of checks (403 before
//       404 before 400), `seenHash`, replay, a different decision, approve-all;
//   (3) undo: inside the window it restores the post and the reviews, after it is 409, another contact's is 403, a recorded
//       decision has none, and anything that happened since makes it 409;
//   (4) the notices wait out the undo window and are sent only if the decision stands; `social.post.client_recorded` reaches the
//       client's contacts when staff record a decision;
//   (5) the portal file route serves a live design's file and nothing else of the post;
//   (6) the way in: the review-requested notice opens `/portal/social?post=<id>` for a pipeline post, and the portal's Ball lists
//       the post once, as `social_post`;
//   (7) the staff read's additive `clientDecision`.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { setStorageForTest, localStorage } from "../../../core/storage";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { handleClientReviewRequested } from "../event-handlers";
import { MUST_HAVE_KEYS } from "./handoff-checks";
import { dropDecisionNotices, flushDecisionNotices, pendingDecisionNoticeCount } from "./decision-notices";

const SOCIAL = { modules: ["social"] };
const SVC = { authorization: "Bearer svc-token" };
const as = (userId: string) => ({ ...SVC, "x-user-id": userId });
const d = (day: number) => `2027-03-${String(day).padStart(2, "0")}T10:00:00.000Z`;
const INSIDE_MARCH_2027 = () => new Date().toISOString().slice(0, 7) === "2027-03";

interface Eng { clientId: string; engagementId: string; cycleId: string }
type Json = Record<string, any>;

describe.skipIf(!TEST_URL)("SCP-2 · the portal's approval page for pipeline posts (BFF §63.9)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  const P: Record<string, string> = {}; // portal contacts
  let c1: Eng; // pA1 and pA2 are its contacts
  let c2: Eng; // pB is its contact
  let c3: Eng; // pP is its contact: the paging and tab tests, so its counts are exact
  let assetId: string;
  const blobs = new Map<string, Buffer>();
  let n = 0;
  const base = () => `/api/${A}/modules/social`;
  const portal = () => `/api/${A}/portal/social`;

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
  async function freshEngagement(label: string): Promise<Eng> {
    n += 1;
    const clientId = await createClient(A, `Mock Client ${label}`);
    const engagementId = newId();
    const cycleId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'creatives', $7, 'central')`,
        [engagementId, A, clientId, `Mock engagement ${label}`, U.officer, JSON.stringify({ networks: { instagram: true, facebook: true } }), ["instagram", "facebook"]],
      );
      const orgId = newId();
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, A, clientId, `mock-org-${label}-${newId().slice(0, 8)}`],
      );
      for (const network of ["instagram", "facebook"]) {
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $7, 'central')`,
          [newId(), A, clientId, orgId, network, `@mock-${network}-${label}`, `int-${network}-${label}`],
        );
      }
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         VALUES ($1, $2, $3, '2027-03-01', '2027-02-26', '2027-02-24', 'central')`,
        [cycleId, A, engagementId],
      );
    }, SOCIAL);
    return { clientId, engagementId, cycleId };
  }

  async function ok(res: { statusCode: number; body: string }, label: string) {
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${label}: ${res.statusCode} ${res.body}`);
    return JSON.parse(res.body) as Json;
  }
  async function statusOf(postId: string): Promise<string | null> {
    return (await adminPool().query(`SELECT pipeline_status FROM social_posts WHERE id = $1`, [postId])).rows[0]?.pipeline_status ?? null;
  }
  async function act(who: string, postId: string, action: string, body: Record<string, unknown> = {}) {
    const expectedStatus = body.expectedStatus ?? (await statusOf(postId));
    return app.inject({ method: "POST", url: `${base()}/posts/${postId}/actions`, headers: as(who), payload: { action, expectedStatus, ...body } });
  }
  async function assignDesigner(postId: string) {
    const r = await adminPool().query(`SELECT creative_request_id::text AS id FROM social_posts WHERE id = $1`, [postId]);
    await adminPool().query(
      `UPDATE pm_tasks SET assignee = jsonb_set(COALESCE(assignee, '{}'::jsonb), '{responsibleId}', to_jsonb($2::text))
        WHERE id = (SELECT pm_task_id FROM work_requests WHERE id = $1)`,
      [r.rows[0].id, U.designer],
    );
  }

  /** A post driven through the real routes to `client`: by default two variants (instagram, facebook), one stored design. A post that
   *  is to be scheduled by hand takes `networks: ["instagram"]` (the media rules of the other network are not under test here). */
  async function postAtClient(eng: Eng, o: { format?: string; scheduledAt?: string; title?: string; networks?: string[] } = {}): Promise<string> {
    const created = await ok(await app.inject({
      method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: as(U.officer),
      payload: { title: o.title ?? "Mock bakery: morning pastries", format: o.format ?? "feed", scheduledAt: o.scheduledAt ?? d(10), placement: o.networks ?? ["instagram", "facebook"] },
    }), "create");
    const postId = created.post.id as string;
    await ok(await act(U.officer, postId, "start_draft"), "start_draft");
    await ok(await app.inject({
      method: "PATCH", url: `${base()}/posts/${postId}/pipeline`, headers: as(U.officer),
      payload: {
        expectedStatus: "drafting",
        fields: {
          caption: "Fresh pastries every morning.", onAssetText: "Open daily", cta: "Visit us", hashtags: ["mockbakery"],
          mustHaves: [...MUST_HAVE_KEYS], rawAssets: [{ url: "https://example.invalid/ref.jpg", label: "Reference", source: "own" }],
        },
      },
    }), "fill");
    await ok(await act(U.officer, postId, "send_to_proofread"), "send_to_proofread");
    await ok(await act(U.copywriter, postId, "approve_copy"), "approve_copy");
    await ok(await act(U.hod, postId, "approve_for_design"), "approve_for_design");
    await assignDesigner(postId);
    await ok(await act(U.designer, postId, "start_design"), "start_design");
    await ok(await app.inject({ method: "POST", url: `${base()}/posts/${postId}/designs`, headers: as(U.designer), payload: { expectedStatus: "design", assetGroupId: assetId } }), "add_design");
    await ok(await act(U.designer, postId, "submit_design"), "submit_design");
    await ok(await act(U.hod, postId, "final_approve"), "final_approve");
    expect(await statusOf(postId)).toBe("client");
    return postId;
  }

  /** A post that has NOT reached the client (drafting). */
  async function postInProduction(eng: Eng): Promise<string> {
    const created = await ok(await app.inject({
      method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: as(U.officer),
      payload: { title: "Mock draft", format: "feed", scheduledAt: d(11), placement: ["instagram"] },
    }), "create");
    await ok(await act(U.officer, created.post.id, "start_draft"), "start_draft");
    return created.post.id as string;
  }

  const detail = async (who: string, postId: string) => app.inject({ method: "GET", url: `${portal()}/posts/${postId}`, headers: as(who) });
  const decide = (who: string, postId: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `${portal()}/posts/${postId}/decide`, headers: as(who), payload: body });
  const undo = (who: string, decisionId: string) => app.inject({ method: "POST", url: `${portal()}/decisions/${decisionId}/undo`, headers: as(who) });
  const hashOf = async (who: string, postId: string) => (await ok(await detail(who, postId), "detail")).reviewHash as string;
  const imageOf = async (who: string, postId: string) => (await ok(await detail(who, postId), "detail")).images[0].fileId as string;
  const reviews = async (postId: string) =>
    (await adminPool().query(
      `SELECT r.status, r.decision_id::text AS decision_id, r.decided_by::text AS decided_by, r.recorded_by::text AS recorded_by, r.channel,
              r.change_kind, r.comment, r.anchor, r.reviewed_args_sha256, r.undo_until, r.decided_at, v.args_sha256
         FROM social_post_client_reviews r JOIN social_post_variants v ON v.id = r.variant_id WHERE v.post_id = $1 AND v.deleted_at IS NULL ORDER BY v.id`,
      [postId])).rows;
  const postRow = async (postId: string) =>
    (await adminPool().query(
      `SELECT pipeline_status, status, status_since, schedule_via, client_first_sent_at, creative_state, change_by, change_kind, return_to, change_note,
              changed_only, copy_before, last_action_id::text AS last_action_id
         FROM social_posts WHERE id = $1`, [postId])).rows[0];
  /** The window passes: `undo_until` of the post's reviews moves into the past (the tests never skip the window with a flush). */
  const closeWindow = async (postId: string) => {
    await adminPool().query(
      `UPDATE social_post_client_reviews SET undo_until = clock_timestamp() - interval '1 second'
        WHERE undo_until IS NOT NULL AND variant_id IN (SELECT id FROM social_post_variants WHERE post_id = $1)`, [postId]);
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const noticeCount = async (userId: string, type: string, postId: string) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = $2 AND payload->>'entityId' = $3`, [userId, type, postId])).rows[0].n);

  // ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.SOCIAL_POSTIZ_ORG_API_KEY = "mock-key";
    setStorageForTest({
      put: async (k, b) => { blobs.set(k, b); },
      get: async (k) => { const b = blobs.get(k); if (!b) throw new Error(`missing blob ${k}`); return b; },
      del: async (k) => { blobs.delete(k); },
    });
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    const units = await seedSocialOrgTree(A);
    for (const p of ["officer", "copywriter", "hod", "designer", "otherStaff"]) {
      U[p] = await createUser(`scp2-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
      await grantSocialRole(A, U[p], "member");
    }
    for (const p of ["officer", "copywriter", "hod"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialSeat(A, units.socialMedia, U.hod);

    const asset = newId();
    await adminPool().query(
      `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
       VALUES ($1, $2, $3, 'Mock design', 'image/jpeg', '{}'::jsonb, $4, 1024, 'central')`,
      [asset, A, U.designer, `mock/${asset}.jpg`],
    );
    assetId = asset;

    c1 = await freshEngagement("one");
    c2 = await freshEngagement("two");
    c3 = await freshEngagement("three");

    const clientRole = await createRole("client");
    for (const [key, eng] of [["pA1", c1], ["pA2", c1], ["pB", c2], ["pP", c3]] as const) {
      P[key] = await createUser(`scp2-${key.toLowerCase()}@client.test`, `Mock Contact ${key}`);
      await withTenants([A], (c) => c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, 'viewer', 'active', 'central')`,
        [newId(), A, eng.clientId, P[key]],
      ));
      await grantRole(P[key], clientRole, "company", A);
    }

    app = await buildApp();
  });
  afterEach(async () => {
    // A notice that waits out an undo window must never fire into the next case: dropped, never flushed (a flush is a re-check).
    dropDecisionNotices();
  });
  afterAll(async () => {
    await app?.close();
    setStorageForTest(localStorage);
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) the reads
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the one post reads in the contract's shape, with nothing internal, and its hash is the staff read's", async () => {
    const postId = await postAtClient(c1);
    const res = await detail(P.pA1, postId);
    expect(res.statusCode, res.body).toBe(200);
    const p = res.json() as Json;
    expect(p).toMatchObject({
      id: postId, clientId: c1.clientId, clientName: "Mock Client one", month: "2027-03", title: "Mock bakery: morning pastries", format: "feed",
      plannedAt: d(10), placement: ["instagram", "facebook"], state: "to_review", caption: "Fresh pastries every morning.", onAssetText: "Open daily",
      cta: "Visit us", hashtags: ["mockbakery"], decision: null, liveUrl: null, simulated: false, comments: [],
    });
    expect(p.images).toHaveLength(1);
    expect(p.images[0]).toMatchObject({ position: 1 });
    expect(p.images[0].thumbFileId).toBe(p.images[0].fileId);
    expect(p.variants.map((v: Json) => [v.network, v.handle, v.surface]).sort()).toEqual([
      ["facebook", "@mock-facebook-one", "feed"], ["instagram", "@mock-instagram-one", "feed"],
    ]);
    const staff = await ok(await app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: as(U.officer) }), "staff read");
    expect(p.reviewHash).toBe(staff.reviewHash);
    // Nothing of the team's: no internal status, holder, check, copy log, suggestion, officer, author, task, change or creative state.
    for (const k of ["pipelineStatus", "phase", "holder", "checks", "copyLog", "suggestions", "officer", "author", "tasks", "change", "creativeState", "skippedChecks", "history", "actions"]) {
      expect(p, k).not.toHaveProperty(k);
    }
    const text = res.body;
    for (const name of ["Mock hod", "Mock copywriter", "Mock designer", "Mock officer"]) expect(text).not.toContain(name);
  });

  it("a team comment never appears; a client comment does, with its author's name and its pin", async () => {
    const postId = await postAtClient(c1);
    const file = await imageOf(P.pA1, postId);
    const say = (body: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/${A}/comments`, headers: as(U.officer), payload: { entityType: "social_post", entityId: postId, ...body } });
    expect((await say({ body: "TEAM ONLY: the client is slow again." })).statusCode).toBe(201);
    expect((await say({ body: "Please look at the logo.", visibility: "client", anchor: { x: 0.25, y: 0.5, fileId: file } })).statusCode).toBe(201);
    const res = await detail(P.pA1, postId);
    const p = res.json() as Json;
    expect(p.comments).toHaveLength(1);
    expect(p.comments[0]).toMatchObject({ body: "Please look at the logo.", author: { name: "Mock officer" }, anchor: { x: 0.25, y: 0.5, fileId: file } });
    expect(res.body).not.toContain("TEAM ONLY");
  });

  it("a post that has not reached the client is 404 on every route, and a staff member is no portal caller", async () => {
    const early = await postInProduction(c1);
    const r = await detail(P.pA1, early);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("post_not_found");
    expect((await decide(P.pA1, early, { decision: "approve", seenHash: "x" })).statusCode).toBe(404);
    expect((await detail(U.officer, early)).statusCode).toBe(403);
    expect((await decide(U.officer, early, { decision: "bogus" })).statusCode).toBe(403); // 403 before 400
    expect((await app.inject({ method: "GET", url: `${portal()}/posts`, headers: as(U.officer) })).statusCode).toBe(403);
    // …and a post that was sent and later archived is gone from the portal.
    const archived = await postAtClient(c1);
    await ok(await act(U.officer, archived, "archive", { reason: "The client cancelled the month." }), "archive");
    expect((await detail(P.pA1, archived)).statusCode).toBe(404);
    // Neither is in the lists.
    const list = await ok(await app.inject({ method: "GET", url: `${portal()}/posts?tab=to_review`, headers: as(P.pA1) }), "list");
    const ids = list.items.map((i: Json) => i.id);
    expect(ids).not.toContain(early);
    expect(ids).not.toContain(archived);
  });

  it("another client's post, decision and file are 404, and its list reads as if it had none", async () => {
    const postId = await postAtClient(c1);
    expect((await detail(P.pB, postId)).statusCode).toBe(404);
    const res = await decide(P.pB, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("post_not_found");
    expect((await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) }), "own decide")).decisionId).toBeTruthy();
    const decisionId = (await reviews(postId))[0].decision_id as string;
    const u = await undo(P.pB, decisionId);
    expect(u.statusCode).toBe(404);
    expect(u.json().error).toBe("decision_not_found");
    expect((await undo(P.pB, "not-a-uuid")).statusCode).toBe(404);
    const file = await imageOf(P.pA1, postId);
    expect((await app.inject({ method: "GET", url: `/api/${A}/portal/files/${file}`, headers: as(P.pB) })).statusCode).toBe(404);
    // pB asks for client one's posts by id: no posts, no counts, no error that says another client exists.
    const list = await ok(await app.inject({ method: "GET", url: `${portal()}/posts?tab=to_review&clientId=${c1.clientId}`, headers: as(P.pB) }), "list");
    expect(list).toEqual({ items: [], nextCursor: null, counts: { toReview: 0, approved: 0, changesAsked: 0 } });
    // Nothing of A's changed.
    expect((await reviews(postId)).every((x) => x.decided_by === P.pA1)).toBe(true);
  });

  it("the tabs, the counts, the paging, the grid and the stories", async () => {
    const p1 = await postAtClient(c3, { scheduledAt: d(10), title: "Mock tabs one" });
    const p2 = await postAtClient(c3, { scheduledAt: d(11), title: "Mock tabs two" });
    const p3 = await postAtClient(c3, { scheduledAt: d(12), title: "Mock tabs three" });
    const story = await postAtClient(c3, { scheduledAt: d(13), format: "story", title: "Mock tabs story" });
    const get = async (qs: string) => ok(await app.inject({ method: "GET", url: `${portal()}/posts${qs}`, headers: as(P.pP) }), `list ${qs}`);

    // to_review: the waiting posts by date, paged with an opaque cursor, no repeat, null at the end.
    const all = await get("?tab=to_review");
    expect(all.items.map((i: Json) => i.id)).toEqual([p1, p2, p3, story]);
    expect(all.counts).toEqual({ toReview: 4, approved: 0, changesAsked: 0 });
    expect(all.nextCursor).toBeNull();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Json = await get(`?tab=to_review&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...page.items.map((i: Json) => i.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual([p1, p2, p3, story]);
    expect(pages).toBe(2);

    // The stories circle: the story waiting on the client, and not the feed posts.
    const stories = await ok(await app.inject({ method: "GET", url: `${portal()}/stories`, headers: as(P.pP) }), "stories");
    expect(stories.items.map((i: Json) => i.id)).toEqual([story]);
    expect(stories.items[0].state).toBe("to_review");

    // Decide: p1 approved, p2 changes asked; the counts and the tabs follow.
    expect((await decide(P.pP, p1, { decision: "approve", seenHash: await hashOf(P.pP, p1) })).statusCode).toBe(200);
    expect((await decide(P.pP, p2, { decision: "change", changeKind: "copy", note: "Shorter, please.", seenHash: await hashOf(P.pP, p2) })).statusCode).toBe(200);
    const after = await get("?tab=to_review");
    expect(after.counts).toEqual({ toReview: 2, approved: 1, changesAsked: 1 });
    expect(after.items.map((i: Json) => i.id)).toEqual([p3, story]);
    const approved = await get("?tab=approved");
    expect(approved.items.map((i: Json) => [i.id, i.state])).toEqual([[p1, "approved"]]);
    expect(approved.items[0].decision).toMatchObject({ kind: "approved", recorded: false, decidedBy: { name: "Mock Contact pP" } });
    // The post the client asked changes on is still theirs to follow: the grid shows it as `changes_asked`.
    const grid = await get("?tab=grid&month=2027-03");
    expect(grid.items.map((i: Json) => [i.id, i.state])).toEqual([[story, "to_review"], [p3, "to_review"], [p2, "changes_asked"], [p1, "approved"]]); // newest first, as the feed
    const changed = grid.items.find((i: Json) => i.id === p2);
    expect(changed.decision).toMatchObject({ kind: "changes", changeKind: "copy", note: "Shorter, please." });
    // The default month is the current one in the report zone: these posts are March 2027's.
    expect((await get("?tab=grid")).items).toHaveLength(INSIDE_MARCH_2027() ? 4 : 0);
    // A client the caller is not a contact of reads as if it had no posts.
    expect(await get(`?tab=to_review&clientId=${c1.clientId}`)).toEqual({ items: [], nextCursor: null, counts: { toReview: 0, approved: 0, changesAsked: 0 } });
    expect((await get(`?tab=to_review&clientId=${c3.clientId}`)).items).toHaveLength(2);
    // A chosen month narrows every tab and the counts (the month's approval page); these posts are all March 2027's.
    const march = await get("?tab=to_review&month=2027-03");
    expect(march.items.map((i: Json) => i.id)).toEqual([p3, story]);
    expect(march.counts).toEqual({ toReview: 2, approved: 1, changesAsked: 1 });
    expect(await get("?tab=to_review&month=2027-04")).toEqual({ items: [], nextCursor: null, counts: { toReview: 0, approved: 0, changesAsked: 0 } });
    expect((await get("?tab=approved&month=2027-04")).items).toEqual([]);
    expect((await get("?tab=approved&month=2027-03")).items.map((i: Json) => i.id)).toEqual([p1]);
    // The query is validated after authorization.
    for (const [qs, field] of [["?tab=bogus", "tab"], ["?limit=0", "limit"], ["?limit=101", "limit"], ["?limit=x", "limit"], ["?month=2027-13", "month"], ["?cursor=%25%25", "cursor"], ["?clientId=nope", "clientId"]] as const) {
      const r = await app.inject({ method: "GET", url: `${portal()}/posts${qs}`, headers: as(P.pP) });
      expect(r.statusCode, qs).toBe(400);
      expect(r.json().field, qs).toBe(field);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) decisions
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("one approval decides every variant review in one transaction, in the portal's shape, and tells nobody at once", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const before = Date.now();
    const res = await decide(P.pA1, postId, { decision: "approve", seenHash: hash, note: "Lovely." });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as Json;
    expect(out).toMatchObject({ postId, state: "approved" });
    expect(out.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out).not.toHaveProperty("alreadyDecided");
    // undoUntil is ten seconds on.
    expect(Date.parse(out.undoUntil) - before).toBeGreaterThan(8000);
    expect(Date.parse(out.undoUntil) - before).toBeLessThan(13000);

    const rows = await reviews(postId);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r).toMatchObject({ status: "approved", decision_id: out.decisionId, decided_by: P.pA1, recorded_by: null, channel: null, comment: "Lovely.", change_kind: null, anchor: null });
      expect(r.reviewed_args_sha256).toBe(r.args_sha256);
      expect(r.undo_until).not.toBeNull();
    }
    expect(await postRow(postId)).toMatchObject({ pipeline_status: "approved", status: "approved", last_action_id: out.decisionId });
    const logged = (await adminPool().query(
      `SELECT actor_id::text AS actor_id, metadata FROM activities WHERE target_entity_type = 'social_post' AND target_entity_id = $1 AND verb = 'client_approve'`, [postId])).rows;
    expect(logged).toHaveLength(1);
    expect(logged[0].actor_id).toBe(P.pA1);
    expect(logged[0].metadata).toMatchObject({ from: "client", to: "approved", viaPortal: true, engagementId: c1.engagementId });
    // The legacy per-variant event, which would tell the officer at once, is not emitted for a pipeline post.
    const legacy = await adminPool().query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'social.client_review.decided' AND entity_id IN (SELECT id FROM social_post_variants WHERE post_id = $1)`, [postId]);
    expect(legacy.rows[0].n).toBe(0);
    // The officer is not told yet: the notice waits out the undo window.
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(0);
    expect(pendingDecisionNoticeCount()).toBeGreaterThan(0);
    // The post reads as approved, with the decision and its open undo window.
    const p = (await detail(P.pA1, postId)).json() as Json;
    expect(p.state).toBe("approved");
    expect(p.decision).toMatchObject({ decisionId: out.decisionId, kind: "approved", note: "Lovely.", recorded: false, decidedBy: { name: "Mock Contact pA1" }, undoUntil: out.undoUntil });
    // A colleague's view of the same post carries the same decision.
    expect(((await detail(P.pA2, postId)).json() as Json).decision.decisionId).toBe(out.decisionId);
  });

  it("the notice reaches the officer once the window has passed and the decision stands", async () => {
    const postId = await postAtClient(c1);
    expect((await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) })).statusCode).toBe(200);
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(0);
    await closeWindow(postId); // the window passes (the real timer is proved in the test of its own)
    expect(await flushDecisionNotices()).toBe(1);
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(1);
    // An approval does not tell the HoD (that is the change's notice).
    expect(await noticeCount(U.hod, "social.post.client_changed", postId)).toBe(0);
  });

  it("a change asks for copy or design with a note and a pin; the HoD, the officer and (design) the designer are told after the window", async () => {
    const copyPost = await postAtClient(c1);
    const file = await imageOf(P.pA1, copyPost);
    // The designer was told it was their turn when the post was handed to design: the baseline the decision must not move.
    const designerBefore = await noticeCount(U.designer, "social.post.your_turn", copyPost);
    const res = await decide(P.pA1, copyPost, {
      decision: "change", changeKind: "copy", note: "The price is wrong.", anchor: { x: 0.4, y: 0.6, fileId: file, junk: "dropped" }, seenHash: await hashOf(P.pA1, copyPost),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ postId: copyPost, state: "changes_asked" });
    for (const r of await reviews(copyPost)) {
      expect(r).toMatchObject({ status: "changes_requested", change_kind: "copy", comment: "The price is wrong.", decided_by: P.pA1, recorded_by: null, channel: null });
      expect(r.anchor).toEqual({ x: 0.4, y: 0.6, fileId: file });
    }
    expect(await postRow(copyPost)).toMatchObject({ pipeline_status: "changes", status: "draft", change_by: "client", change_kind: "copy", return_to: "proofread", changed_only: true });
    await closeWindow(copyPost);
    await flushDecisionNotices();
    expect(await noticeCount(U.officer, "social.post.client_decided", copyPost)).toBe(1);
    expect(await noticeCount(U.hod, "social.post.client_changed", copyPost)).toBe(1);
    expect(await noticeCount(U.designer, "social.post.your_turn", copyPost)).toBe(designerBefore); // a copy change is not the designer's

    const designPost = await postAtClient(c1);
    const designerBefore2 = await noticeCount(U.designer, "social.post.your_turn", designPost);
    const res2 = await decide(P.pA1, designPost, { decision: "change", changeKind: "design", note: "Brighter, please.", seenHash: await hashOf(P.pA1, designPost) });
    expect(res2.statusCode, res2.body).toBe(200);
    expect(await postRow(designPost)).toMatchObject({ pipeline_status: "changes", creative_state: "revision", change_by: "client", change_kind: "design", return_to: "final" });
    await closeWindow(designPost);
    await flushDecisionNotices();
    expect(await noticeCount(U.designer, "social.post.your_turn", designPost)).toBe(designerBefore2 + 1);
    expect(await noticeCount(U.hod, "social.post.client_changed", designPost)).toBe(1);
  });

  it("the order of checks and the body: 400 {field} after the post proved visible", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ seenHash: hash }, "decision"],
      [{ decision: "maybe", seenHash: hash }, "decision"],
      [{ decision: "approve" }, "seenHash"],
      [{ decision: "approve", seenHash: hash, note: "x".repeat(2001) }, "note"],
      [{ decision: "change", seenHash: hash, note: "Fix it." }, "changeKind"],
      [{ decision: "change", seenHash: hash, changeKind: "copy" }, "note"],
      [{ decision: "change", seenHash: hash, changeKind: "colour", note: "Fix it." }, "changeKind"],
      [{ decision: "change", seenHash: hash, changeKind: "copy", note: "x".repeat(2001) }, "note"],
      [{ decision: "change", seenHash: hash, changeKind: "copy", note: "Fix it.", anchor: { x: 1.5, y: 0.5, fileId: await imageOf(P.pA1, postId) } }, "anchor"],
      [{ decision: "change", seenHash: hash, changeKind: "copy", note: "Fix it.", anchor: { x: 0.5, y: 0.5, fileId: newId() } }, "anchor"],
      [{ decision: "change", seenHash: hash, changeKind: "copy", note: "Fix it.", anchor: { x: 0.5, y: 0.5 } }, "anchor"],
    ];
    for (const [body, field] of bad) {
      const r = await decide(P.pA1, postId, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().field, JSON.stringify(body)).toBe(field);
    }
    // Nothing was decided by any of them.
    expect((await reviews(postId)).every((x) => x.status === "pending" && x.decision_id === null)).toBe(true);
    expect(await statusOf(postId)).toBe("client");
  });

  it("seenHash refuses a post that changed while the client looked (409 content_changed) and decides nothing", async () => {
    const postId = await postAtClient(c1);
    const stale = await hashOf(P.pA1, postId);
    // The date moves (the content, the date, the time and the placement are what the hash covers).
    await adminPool().query(`UPDATE social_post_variants SET args_sha256 = repeat('0', 64) WHERE post_id = $1`, [postId]);
    const r = await decide(P.pA1, postId, { decision: "approve", seenHash: stale });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("content_changed");
    expect((await reviews(postId)).every((x) => x.status === "pending")).toBe(true);
    // With the fresh hash it goes through.
    expect((await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) })).statusCode).toBe(200);
  });

  it("a replay answers alreadyDecided; a different decision after one was made is 409; a colleague's replay is the same", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const first = (await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: hash }), "first")) as Json;
    const decidedAt = (await reviews(postId))[0].decided_at;
    const again = await decide(P.pA1, postId, { decision: "approve", seenHash: hash });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ alreadyDecided: true, decisionId: first.decisionId, postId, state: "approved" });
    const colleague = await decide(P.pA2, postId, { decision: "approve", seenHash: hash });
    expect(colleague.statusCode).toBe(200);
    expect(colleague.json()).toMatchObject({ alreadyDecided: true, decisionId: first.decisionId });
    const other = await decide(P.pA1, postId, { decision: "change", changeKind: "copy", note: "Actually, no.", seenHash: hash });
    expect(other.statusCode).toBe(409);
    expect(other.json().error).toBe("client_review_already_decided");
    // Untouched by the replays: the same decision, the same instant, one activity row, one notice job.
    const rows = await reviews(postId);
    expect(rows.every((x) => x.status === "approved" && x.decision_id === first.decisionId)).toBe(true);
    expect(new Date(rows[0].decided_at).getTime()).toBe(new Date(decidedAt).getTime());
    const acts = await adminPool().query(`SELECT count(*)::int AS n FROM activities WHERE target_entity_id = $1 AND verb LIKE 'client_%'`, [postId]);
    expect(acts.rows[0].n).toBe(1);
  });

  it("a post that is visible but not waiting is 409 post_not_with_client", async () => {
    const postId = await postAtClient(c1, { networks: ["instagram"] });
    expect((await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) })).statusCode).toBe(200);
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    expect(await statusOf(postId)).toBe("scheduled");
    // The decision still stands on the reviews, so the same one is a replay and the other is the conflict.
    expect((await decide(P.pA1, postId, { decision: "approve", seenHash: "x" })).json().alreadyDecided).toBe(true);
    // With the reviews reset (no decision on them), a scheduled post is not waiting on the client.
    await adminPool().query(
      `UPDATE social_post_client_reviews SET status = 'pending', decided_by = NULL, decided_at = NULL, decision_id = NULL, undo_until = NULL, reviewed_args_sha256 = NULL
        WHERE variant_id IN (SELECT id FROM social_post_variants WHERE post_id = $1)`, [postId]);
    const r = await decide(P.pA1, postId, { decision: "approve", seenHash: "x" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("post_not_with_client");
    // The body is judged only for a post that is waiting: a bad note or pin on a post that is not is still the 409.
    const bad = await decide(P.pA1, postId, { decision: "approve", seenHash: "x", note: "x".repeat(2001) });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toBe("post_not_with_client");
    const badPin = await decide(P.pA1, postId, { decision: "change", changeKind: "copy", note: "Fix.", seenHash: "x", anchor: { x: 9, y: 9 } });
    expect(badPin.statusCode).toBe(409);
    expect(badPin.json().error).toBe("post_not_with_client");
  });

  it("a decision already made answers alreadyDecided even when the repeat's note or pin is malformed", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const first = (await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: hash }), "first")) as Json;
    const again = await decide(P.pA1, postId, { decision: "approve", seenHash: hash, note: "x".repeat(2001) });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ alreadyDecided: true, decisionId: first.decisionId });
  });

  it("a forced failure part-way through leaves no review changed and the post as it was", async () => {
    const postId = await postAtClient(c1);
    const variants = (await adminPool().query(`SELECT id FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL ORDER BY id`, [postId])).rows.map((r) => r.id as string);
    expect(variants).toHaveLength(2);
    const hash = await hashOf(P.pA1, postId);
    await adminPool().query(
      `CREATE OR REPLACE FUNCTION scp2_force_fail() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.decision_id IS NOT NULL AND NEW.variant_id = '${variants[1]}'::uuid THEN RAISE EXCEPTION 'scp2 forced failure'; END IF;
         RETURN NEW;
       END $$`);
    await adminPool().query(`CREATE TRIGGER scp2_force_fail BEFORE UPDATE ON social_post_client_reviews FOR EACH ROW EXECUTE FUNCTION scp2_force_fail()`);
    let status: number;
    try {
      status = (await decide(P.pA1, postId, { decision: "approve", seenHash: hash })).statusCode;
    } finally {
      await adminPool().query(`DROP TRIGGER IF EXISTS scp2_force_fail ON social_post_client_reviews`);
      await adminPool().query(`DROP FUNCTION IF EXISTS scp2_force_fail()`);
    }
    expect(status).toBe(500);
    const rows = await reviews(postId);
    expect(rows.every((x) => x.status === "pending" && x.decision_id === null && x.decided_by === null && x.undo_until === null)).toBe(true);
    expect(await postRow(postId)).toMatchObject({ pipeline_status: "client", status: "in_review", last_action_id: null });
    const acts = await adminPool().query(`SELECT count(*)::int AS n FROM activities WHERE target_entity_id = $1 AND verb LIKE 'client_%'`, [postId]);
    expect(acts.rows[0].n).toBe(0);
    expect(await flushDecisionNotices()).toBe(0); // nothing was scheduled for a decision that never happened
    // And the same call, once the fault is gone, goes through whole.
    expect((await decide(P.pA1, postId, { decision: "approve", seenHash: hash })).statusCode).toBe(200);
  });

  it("approve-all approves exactly what waits with an unchanged hash and skips the rest with its reason", async () => {
    const wait = await postAtClient(c1);
    const changed = await postAtClient(c1);
    const already = await postAtClient(c1);
    const foreign = await postAtClient(c2);
    const early = await postInProduction(c1);
    const hashWait = await hashOf(P.pA1, wait);
    const hashChanged = await hashOf(P.pA1, changed);
    const hashAlready = await hashOf(P.pA1, already);
    expect((await decide(P.pA1, already, { decision: "approve", seenHash: hashAlready })).statusCode).toBe(200);
    await adminPool().query(`UPDATE social_post_variants SET args_sha256 = repeat('0', 64) WHERE post_id = $1`, [changed]);

    const res = await app.inject({
      method: "POST", url: `${portal()}/posts/approve-all`, headers: as(P.pA1),
      payload: { items: [
        { postId: wait, seenHash: hashWait }, { postId: changed, seenHash: hashChanged }, { postId: already, seenHash: hashAlready },
        { postId: foreign, seenHash: "x" }, { postId: early, seenHash: "x" }, { postId: newId(), seenHash: "x" },
      ] },
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as Json;
    expect(out.results.map((r: Json) => [r.postId, r.outcome, r.reason ?? null])).toEqual([
      [wait, "approved", null], [changed, "skipped", "content_changed"], [already, "skipped", "client_review_already_decided"],
      [foreign, "skipped", "post_not_found"], [early, "skipped", "post_not_found"], [out.results[5].postId, "skipped", "post_not_found"],
    ]);
    expect(out.results[0].decisionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof out.undoUntil).toBe("string");
    expect(await statusOf(wait)).toBe("approved");
    expect(await statusOf(changed)).toBe("client"); // not touched
    expect((await reviews(changed)).every((x) => x.status === "pending")).toBe(true);
    expect(await statusOf(foreign)).toBe("client");
    // Each approved post has its own decision, undoable on its own.
    const u = await undo(P.pA1, out.results[0].decisionId);
    expect(u.statusCode, u.body).toBe(200);
    expect(await statusOf(wait)).toBe("client");
    // The list is validated after authorization: 403 for a staff caller, then 400.
    const post = (who: string, payload: unknown) => app.inject({ method: "POST", url: `${portal()}/posts/approve-all`, headers: as(who), payload: payload as Record<string, unknown> });
    expect((await post(U.officer, { items: [] })).statusCode).toBe(403);
    for (const items of [[], Array.from({ length: 51 }, () => ({ postId: newId(), seenHash: "x" })), [{ postId: wait }], [{ seenHash: "x" }], "nope"]) {
      const r = await post(P.pA1, { items });
      expect(r.statusCode, JSON.stringify(items).slice(0, 60)).toBe(400);
      expect(r.json().field).toBe("items");
    }
    expect((await post(P.pA1, {})).statusCode).toBe(400);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) undo
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("an undo inside the window puts every review back to pending, the post back to the client, and cancels the notices", async () => {
    const postId = await postAtClient(c1);
    const res = await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId), note: "Lovely." });
    const { decisionId } = res.json() as Json;
    expect(pendingDecisionNoticeCount()).toBeGreaterThan(0);
    const events = async () => Number((await adminPool().query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'social.client_review.requested' AND payload->>'postId' = $1`, [postId])).rows[0].n);
    const requestedBefore = await events();

    const u = await undo(P.pA1, decisionId);
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json()).toMatchObject({ decisionId, postId, state: "to_review" });
    for (const r of await reviews(postId)) {
      expect(r).toMatchObject({ status: "pending", decision_id: null, decided_by: null, recorded_by: null, channel: null, comment: null, change_kind: null, anchor: null, reviewed_args_sha256: null, undo_until: null });
    }
    expect(await postRow(postId)).toMatchObject({ pipeline_status: "client", status: "in_review", last_action_id: null, change_by: null, changed_only: false });
    // No new review request: the client asked for nothing new.
    expect(await events()).toBe(requestedBefore);
    const logged = await adminPool().query(
      `SELECT metadata FROM activities WHERE target_entity_type = 'social_post' AND target_entity_id = $1 AND verb = 'client_undo'`, [postId]);
    expect(logged.rows).toHaveLength(1);
    expect(logged.rows[0].metadata).toMatchObject({ from: "approved", to: "client", viaPortal: true });
    // The notice that was waiting never goes out.
    expect(await flushDecisionNotices()).toBe(0);
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(0);
    // The decision is gone: a second undo has nothing to take back, and the client can decide again.
    expect((await undo(P.pA1, decisionId)).statusCode).toBe(404);
    expect((await ok(await decide(P.pA1, postId, { decision: "change", changeKind: "copy", note: "On second thought.", seenHash: await hashOf(P.pA1, postId) }), "again")).state).toBe("changes_asked");
  });

  /** The post after an undo is the post before the decision, column for column, except that `status_since` moved (the post is with the
   *  client again from now); `schedule_via` and `client_first_sent_at` are untouched. */
  function expectRestored(after: Json, before: Json) {
    expect(new Date(after.status_since).getTime()).toBeGreaterThan(new Date(before.status_since).getTime());
    expect({ ...after, status_since: null }).toEqual({ ...before, status_since: null });
    expect(after.schedule_via).toBe(before.schedule_via);
    expect(new Date(after.client_first_sent_at).getTime()).toBe(new Date(before.client_first_sent_at).getTime());
  }

  it("an undo restores what a change decision set: the change fields, changed_only, the copy before and the creative state", async () => {
    const designPost = await postAtClient(c1);
    const before = await postRow(designPost);
    expect(before.creative_state).toBe("submitted");
    const { decisionId } = (await ok(await decide(P.pA1, designPost, { decision: "change", changeKind: "design", note: "Brighter.", seenHash: await hashOf(P.pA1, designPost) }), "design")) as Json;
    expect((await postRow(designPost)).creative_state).toBe("revision");
    expect((await undo(P.pA1, decisionId)).statusCode).toBe(200);
    expectRestored(await postRow(designPost), before);

    const copyPost = await postAtClient(c1);
    const beforeCopy = await postRow(copyPost);
    const copyDecision = ((await ok(await decide(P.pA1, copyPost, { decision: "change", changeKind: "copy", note: "Shorter.", seenHash: await hashOf(P.pA1, copyPost) }), "copy")) as Json).decisionId;
    expect(await postRow(copyPost)).toMatchObject({ changed_only: true, change_by: "client" });
    expect((await postRow(copyPost)).copy_before).not.toBeNull();
    expect((await undo(P.pA1, copyDecision)).statusCode).toBe(200);
    expectRestored(await postRow(copyPost), beforeCopy);
    expect(await flushDecisionNotices()).toBe(0);
    expect(await noticeCount(U.hod, "social.post.client_changed", copyPost)).toBe(0);
  });

  it("after the window an undo is 409 undo_window_passed and nothing changes", async () => {
    const postId = await postAtClient(c1);
    const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) }), "decide")) as Json;
    await adminPool().query(`UPDATE social_post_client_reviews SET undo_until = now() - interval '1 second' WHERE decision_id = $1`, [decisionId]);
    const u = await undo(P.pA1, decisionId);
    expect(u.statusCode).toBe(409);
    expect(u.json().error).toBe("undo_window_passed");
    expect(await statusOf(postId)).toBe("approved");
    expect((await reviews(postId)).every((x) => x.status === "approved" && x.decision_id === decisionId)).toBe(true);
    // The window is closed in the post's own read, too.
    expect(((await detail(P.pA1, postId)).json() as Json).decision).not.toHaveProperty("undoUntil");
  });

  it("another contact's undo is 403 not_your_decision", async () => {
    const postId = await postAtClient(c1);
    const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) }), "decide")) as Json;
    const u = await undo(P.pA2, decisionId);
    expect(u.statusCode).toBe(403);
    expect(u.json().error).toBe("not_your_decision");
    expect(await statusOf(postId)).toBe("approved");
  });

  it("anything that happened to the post since makes the undo 409 even inside the window", async () => {
    const postId = await postAtClient(c1, { networks: ["instagram"] });
    const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) }), "decide")) as Json;
    // The officer acts on it at once (it is in the officer's hands as soon as it is approved).
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    const u = await undo(P.pA1, decisionId);
    expect(u.statusCode).toBe(409);
    expect(u.json().error).toBe("undo_window_passed");
    expect(await statusOf(postId)).toBe("scheduled");
    // An action that leaves the post in the status the decision took it to (it stamps another action id) counts too.
    const second = await postAtClient(c1);
    const dec2 = ((await ok(await decide(P.pA1, second, { decision: "change", changeKind: "copy", note: "Shorter.", seenHash: await hashOf(P.pA1, second) }), "decide")) as Json).decisionId;
    await adminPool().query(`UPDATE social_posts SET last_action_id = gen_random_uuid() WHERE id = $1`, [second]);
    expect((await undo(P.pA1, dec2)).statusCode).toBe(409);
  });

  it("a decision staff recorded has no undo, shows its channel and never the member of staff, and tells the client's contacts", async () => {
    const postId = await postAtClient(c1);
    const rec = await act(U.officer, postId, "record_client_approve", { channel: "whatsapp", note: "Approved on the phone." });
    expect(rec.statusCode, rec.body).toBe(200);
    const rows = await reviews(postId);
    expect(rows.every((x) => x.status === "approved" && x.decided_by === null && x.recorded_by === U.officer && x.channel === "whatsapp" && x.undo_until === null)).toBe(true);
    const decisionId = rows[0].decision_id as string;
    const u = await undo(P.pA1, decisionId);
    expect(u.statusCode).toBe(403);
    expect(u.json().error).toBe("not_your_decision");
    const res = await detail(P.pA1, postId);
    const p = res.json() as Json;
    expect(p.decision).toMatchObject({ decisionId, kind: "approved", note: "Approved on the phone.", recorded: true, channel: "whatsapp", decidedBy: null });
    expect(p.decision).not.toHaveProperty("undoUntil");
    expect(res.body).not.toContain("Mock officer");
    // The client's contacts are told we recorded it, with the link to the post in the portal; the staff-recorded path
    // sets no timer (the recorder is the officer, who is never told of their own act).
    for (const contact of [P.pA1, P.pA2]) expect(await noticeCount(contact, "social.post.client_recorded", postId)).toBe(1);
    const note = (await adminPool().query(`SELECT payload FROM notifications WHERE user_id = $1 AND type = 'social.post.client_recorded' AND payload->>'entityId' = $2`, [P.pA1, postId])).rows[0].payload;
    expect(note).toMatchObject({ title: "We recorded your decision on a post", href: `/portal/social?post=${postId}` });
    expect(await noticeCount(P.pB, "social.post.client_recorded", postId)).toBe(0);
    expect(pendingDecisionNoticeCount()).toBe(0);
    // The staff read says so (7).
    const staff = await ok(await app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: as(U.officer) }), "staff read");
    expect(staff.clientDecision).toMatchObject({
      decisionId, kind: "approved", note: "Approved on the phone.", via: "recorded", channel: "whatsapp", decidedBy: null, recordedBy: { id: U.officer, name: "Mock officer" },
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) the notices wait, and only a standing decision is told
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("a notice whose decision no longer stands sends nothing, even if its timer was never cancelled", async () => {
    const postId = await postAtClient(c1);
    expect((await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) })).statusCode).toBe(200);
    // Take the decision apart behind the timer's back (another route, a restart-and-replay, a manual fix).
    await adminPool().query(
      `UPDATE social_post_client_reviews SET status = 'pending', decided_by = NULL, decided_at = NULL, decision_id = NULL, undo_until = NULL, reviewed_args_sha256 = NULL
        WHERE variant_id IN (SELECT id FROM social_post_variants WHERE post_id = $1)`, [postId]);
    expect(await flushDecisionNotices()).toBe(1);
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(0);
    // Likewise when the post has moved on from the status the decision took it to.
    const second = await postAtClient(c1, { networks: ["instagram"] });
    expect((await decide(P.pA1, second, { decision: "approve", seenHash: await hashOf(P.pA1, second) })).statusCode).toBe(200);
    await ok(await act(U.officer, second, "schedule"), "schedule");
    expect(await flushDecisionNotices()).toBe(1);
    expect(await noticeCount(U.officer, "social.post.client_decided", second)).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) the files
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the portal serves a live design's file, and refuses every other file of the post, a removed design and a post not yet sent", async () => {
    const postId = await postAtClient(c1);
    const file = await imageOf(P.pA1, postId);
    const key = (await adminPool().query(`SELECT storage_key FROM files WHERE id = $1`, [file])).rows[0].storage_key as string;
    blobs.set(key, Buffer.from("mock-image-bytes"));
    const get = (who: string, id: string) => app.inject({ method: "GET", url: `/api/${A}/portal/files/${id}`, headers: as(who) });
    const ok1 = await get(P.pA1, file);
    expect(ok1.statusCode, ok1.body).toBe(200);
    expect(ok1.body).toBe("mock-image-bytes");
    expect(ok1.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(ok1.headers["content-disposition"])).toContain("attachment");
    expect(String(ok1.headers["content-security-policy"])).toContain("sandbox");
    expect((await get(P.pA2, file)).statusCode).toBe(200); // a colleague
    expect((await get(P.pB, file)).statusCode).toBe(404); // another client
    expect((await get(U.officer, file)).statusCode).toBe(403); // not a portal caller

    // A file of the same post that no live design names (a reference image) is the same 404 as a missing file.
    const ref = newId();
    await adminPool().query(
      `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, origin_site)
       VALUES ($1, $2, $3, 'social_post', $4, 'reference.jpg', 'image/jpeg', 12, $5, 'central')`,
      [ref, A, U.designer, postId, `mock/${ref}.jpg`]);
    blobs.set(`mock/${ref}.jpg`, Buffer.from("reference"));
    const refRes = await get(P.pA1, ref);
    expect(refRes.statusCode).toBe(404);
    expect((await get(P.pA1, newId())).statusCode).toBe(404);
    expect(refRes.json().error ?? refRes.json().message).toBe((await get(P.pA1, newId())).json().error ?? (await get(P.pA1, newId())).json().message);

    // The design removed: its file is no longer the client's.
    await adminPool().query(`UPDATE social_post_designs SET removed_at = now(), removed_by = $2 WHERE file_id = $1`, [file, U.designer]);
    expect((await get(P.pA1, file)).statusCode).toBe(404);
    await adminPool().query(`UPDATE social_post_designs SET removed_at = NULL, removed_by = NULL WHERE file_id = $1`, [file]);
    expect((await get(P.pA1, file)).statusCode).toBe(200);
    // The post is not (or no longer) visible: the same 404.
    await adminPool().query(`UPDATE social_posts SET client_first_sent_at = NULL WHERE id = $1`, [postId]);
    expect((await get(P.pA1, file)).statusCode).toBe(404);
    await adminPool().query(`UPDATE social_posts SET client_first_sent_at = now() WHERE id = $1`, [postId]);
    expect((await get(P.pA1, file)).statusCode).toBe(200);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) the way in
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the review-requested notice opens the post on /portal/social for a pipeline post, and the per-variant page for a Composer post", async () => {
    const postId = await postAtClient(c1);
    const row = (await adminPool().query(
      `SELECT id, tenant_id AS "tenantId", entity_type AS "entityType", entity_id AS "entityId", event_type AS "eventType", payload,
              origin_site AS "originSite", schema_version AS "schemaVersion", created_at AS "createdAt"
         FROM outbox_events WHERE event_type = 'social.client_review.requested' AND payload->>'postId' = $1`, [postId])).rows[0];
    expect(row, "final_approve emits the event with postId").toBeTruthy();
    const ev = { ...row, createdAt: new Date(row.createdAt).toISOString() };
    await handleClientReviewRequested(ev);
    const hrefs = async (reviewId: string) => (await adminPool().query(
      `SELECT payload->>'href' AS href FROM notifications WHERE user_id = $1 AND type = 'social.client_review.requested' AND payload->>'entityId' = $2`, [P.pA1, reviewId])).rows.map((r) => r.href);
    expect(await hrefs(ev.payload.reviewId)).toEqual([`/portal/social?post=${postId}`]);
    // A Composer post's event carries no postId: the per-variant page, as before.
    const composerReview = newId();
    await handleClientReviewRequested({ ...ev, payload: { reviewId: composerReview, clientId: c1.clientId, projectId: null, postTitle: "Composer post" } });
    expect(await hrefs(composerReview)).toEqual(["/portal/social-reviews"]);
  });

  it("the portal's Ball lists a pipeline post once, as social_post with the post id, however many variants it has", async () => {
    const postId = await postAtClient(c2);
    const res = await app.inject({ method: "GET", url: `/api/${A}/portal/health`, headers: as(P.pB) });
    expect(res.statusCode, res.body).toBe(200);
    const client = (res.json() as Json).clients.find((c: Json) => c.clientId === c2.clientId);
    const items = (client.clientWide.waitingOnYou.items as Json[]).filter((i) => i.id === postId || i.kind === "social_post");
    expect(items.filter((i) => i.id === postId)).toEqual([expect.objectContaining({ kind: "social_post", id: postId })]);
    expect((await ok(await decide(P.pB, postId, { decision: "change", changeKind: "copy", note: "A tweak.", seenHash: await hashOf(P.pB, postId) }), "decide")).state).toBe("changes_asked");
    const after = await app.inject({ method: "GET", url: `/api/${A}/portal/health`, headers: as(P.pB) });
    const us = ((after.json() as Json).clients.find((c: Json) => c.clientId === c2.clientId).clientWide.waitingOnUs.items as Json[]).filter((i) => i.id === postId);
    expect(us).toEqual([expect.objectContaining({ kind: "social_post", id: postId })]);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (7) the staff read
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("the staff read carries the client's latest decision: null before, the portal's after, additive to everything else", async () => {
    const postId = await postAtClient(c1);
    const read = async () => ok(await app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: as(U.officer) }), "staff read");
    const first = await read();
    expect(first.clientDecision).toBeNull();
    const file = await imageOf(P.pA1, postId);
    const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "change", changeKind: "design", note: "Brighter.", anchor: { x: 0.1, y: 0.9, fileId: file }, seenHash: await hashOf(P.pA1, postId) }), "decide")) as Json;
    const after = await read();
    expect(after.clientDecision).toMatchObject({
      decisionId, kind: "changes", changeKind: "design", note: "Brighter.", via: "portal", decidedBy: { id: P.pA1, name: "Mock Contact pA1" }, recordedBy: null,
    });
    expect(after.clientDecision).not.toHaveProperty("channel");
    expect(typeof after.clientDecision.decidedAt).toBe("string");
    // Every field the read had before is still there.
    for (const k of Object.keys(first)) expect(after, k).toHaveProperty(k);
    // The history shows the client's step as one made in the portal.
    expect(after.history.find((h: Json) => h.action === "client_change")).toMatchObject({ from: "client", to: "changes", viaPortal: true });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (8) review round: the races, the window against the lock, the lock-time checks, the Ball and the client's follow-up link
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("two contacts of the same client deciding the same post at once make exactly one decision", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const [a, b] = await Promise.all([
      decide(P.pA1, postId, { decision: "approve", seenHash: hash }),
      decide(P.pA2, postId, { decision: "approve", seenHash: hash }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const fresh = [a, b].filter((r) => !(r.json() as Json).alreadyDecided);
    expect(fresh).toHaveLength(1);
    const ids = new Set((await reviews(postId)).map((x) => x.decision_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe((fresh[0].json() as Json).decisionId);
    expect([a, b].map((r) => (r.json() as Json).decisionId)).toEqual([[...ids][0], [...ids][0]]);
    const acts = await adminPool().query(`SELECT count(*)::int AS n FROM activities WHERE target_entity_id = $1 AND verb = 'client_approve'`, [postId]);
    expect(acts.rows[0].n).toBe(1);
    // A colleague asking for the opposite at the same moment: one wins, the other is the conflict.
    const second = await postAtClient(c1);
    const h2 = await hashOf(P.pA1, second);
    const [x, y] = await Promise.all([
      decide(P.pA1, second, { decision: "approve", seenHash: h2 }),
      decide(P.pA2, second, { decision: "change", changeKind: "copy", note: "No.", seenHash: h2 }),
    ]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 409]);
    expect(new Set((await reviews(second)).map((r) => r.status)).size).toBe(1);
  });

  it("a client's decision racing the staff's recorded one leaves one decision and no mixed review rows", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const [portalRes, staffRes] = await Promise.all([
      decide(P.pA1, postId, { decision: "approve", seenHash: hash }),
      act(U.officer, postId, "record_client_approve", { channel: "email", note: "Approved by email." }),
    ]);
    const rows = await reviews(postId);
    expect(new Set(rows.map((r) => r.decision_id)).size).toBe(1);
    expect(new Set(rows.map((r) => `${r.status}|${r.decided_by}|${r.recorded_by}|${r.channel}`)).size).toBe(1);
    expect(rows.every((r) => r.status === "approved")).toBe(true);
    const logged = (await adminPool().query(`SELECT verb FROM activities WHERE target_entity_id = $1 AND verb IN ('client_approve', 'record_client_approve')`, [postId])).rows.map((r) => r.verb);
    expect(logged).toHaveLength(1);
    if (logged[0] === "client_approve") {
      expect(portalRes.statusCode).toBe(200);
      expect((portalRes.json() as Json).alreadyDecided).toBeUndefined();
      expect(staffRes.statusCode).toBe(409);
      expect(rows[0].decided_by).toBe(P.pA1);
    } else {
      expect(staffRes.statusCode).toBe(200);
      expect(portalRes.statusCode).toBe(200);
      expect((portalRes.json() as Json).alreadyDecided).toBe(true); // the post is approved, as the client asked
      expect(rows[0]).toMatchObject({ decided_by: null, recorded_by: U.officer });
    }
  });

  it("a post archived after the portal's first read but before the lock is still 404", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const held = await adminPool().connect();
    try {
      await held.query("BEGIN");
      await held.query(`SELECT 1 FROM social_posts WHERE id = $1 FOR UPDATE`, [postId]);
      const pending = decide(P.pA1, postId, { decision: "approve", seenHash: hash }); // reads the post as visible, then waits on the lock
      for (let i = 0; i < 50; i++) {
        const w = await adminPool().query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
        if (w.rows[0].n > 0) break;
        await sleep(100);
      }
      await held.query(
        `UPDATE social_posts SET archived_at = now(), archived_by = $2, archive_reason = 'Archived while the client looked', status = 'archived' WHERE id = $1`,
        [postId, U.officer]);
      await held.query("COMMIT");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().error).toBe("post_not_found");
    } finally {
      await held.query("ROLLBACK").catch(() => undefined);
      held.release();
    }
    expect((await reviews(postId)).every((r) => r.decision_id === null)).toBe(true);
  });

  it("nothing is sent while the undo window is open: an early job re-checks and waits; the real timer sends only after undo_until", async () => {
    const postId = await postAtClient(c1);
    const t0 = Date.now();
    const res = await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) });
    const { undoUntil } = res.json() as Json;
    // Fired early (a flush stands for any early fire): the window is open on the database clock, so it sends nothing and waits again.
    expect(await flushDecisionNotices()).toBe(1);
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(0);
    expect(pendingDecisionNoticeCount()).toBe(1);
    // No flush from here: the timer alone. Silent while the window is open…
    await sleep(2000);
    expect(Date.now()).toBeLessThan(Date.parse(undoUntil));
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(0);
    // …and the notice arrives once it has passed.
    for (let i = 0; i < 200 && (await noticeCount(U.officer, "social.post.client_decided", postId)) === 0; i++) await sleep(100);
    expect(await noticeCount(U.officer, "social.post.client_decided", postId)).toBe(1);
    expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(undoUntil));
    expect(Date.now() - t0).toBeGreaterThan(9000);
  }, 40_000);

  it("the window is written from the moment of the decision, not the start of the transaction: a decision that waited on the lock keeps its full ten seconds", async () => {
    const postId = await postAtClient(c1);
    const hash = await hashOf(P.pA1, postId);
    const held = await adminPool().connect();
    let res;
    let freed = 0;
    try {
      await held.query("BEGIN");
      await held.query(`SELECT 1 FROM social_posts WHERE id = $1 FOR UPDATE`, [postId]);
      const pending = decide(P.pA1, postId, { decision: "approve", seenHash: hash });
      await sleep(3000); // the decision's transaction has been open, waiting, for three seconds
      freed = Date.now();
      await held.query("COMMIT");
      res = await pending;
    } finally {
      await held.query("ROLLBACK").catch(() => undefined);
      held.release();
    }
    expect(res.statusCode, res.body).toBe(200);
    expect(Date.parse((res.json() as Json).undoUntil) - freed).toBeGreaterThan(9000);
  }, 30_000);

  it("an undo after loop e (the post reached the client through approve_copy with changed_only) restores exactly what the decision changed", async () => {
    const postId = await postAtClient(c1);
    expect((await decide(P.pA1, postId, { decision: "change", changeKind: "copy", note: "Shorter, please.", seenHash: await hashOf(P.pA1, postId) })).statusCode).toBe(200);
    await ok(await app.inject({
      method: "PATCH", url: `${base()}/posts/${postId}/pipeline`, headers: as(U.officer),
      payload: { expectedStatus: "changes", fields: { caption: "Fresh pastries, baked daily." } },
    }), "edit");
    await ok(await act(U.officer, postId, "send_to_proofread"), "send_to_proofread");
    await ok(await act(U.copywriter, postId, "approve_copy"), "approve_copy"); // changedOnly: straight back to the client
    expect(await statusOf(postId)).toBe("client");
    const before = await postRow(postId);
    expect(before).toMatchObject({ changed_only: false, copy_before: null, change_by: null });
    for (const kind of ["copy", "design"] as const) {
      const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "change", changeKind: kind, note: "Once more.", seenHash: await hashOf(P.pA1, postId) }), kind)) as Json;
      expect((await postRow(postId)).change_kind).toBe(kind);
      expect((await undo(P.pA1, decisionId)).statusCode).toBe(200);
      expectRestored(await postRow(postId), before);
    }
    const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) }), "approve")) as Json;
    expect((await undo(P.pA1, decisionId)).statusCode).toBe(200);
    expectRestored(await postRow(postId), before);
  });

  it("a designer's design PATCH inside the window is something that happened: the undo is 409 and the post stays where it is", async () => {
    const postId = await postAtClient(c1);
    const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "change", changeKind: "design", note: "Brighter.", seenHash: await hashOf(P.pA1, postId) }), "decide")) as Json;
    const staff = await ok(await app.inject({ method: "GET", url: `${base()}/posts/${postId}/pipeline`, headers: as(U.officer) }), "staff read");
    const patch = await app.inject({
      method: "PATCH", url: `${base()}/posts/${postId}/designs/${staff.designs[0].id}`, headers: as(U.designer), payload: { expectedStatus: "changes", position: 2 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await postRow(postId)).last_action_id).toBeNull();
    const u = await undo(P.pA1, decisionId);
    expect(u.statusCode).toBe(409);
    expect(u.json().error).toBe("undo_window_passed");
    expect(await statusOf(postId)).toBe("changes");
  });

  it("two undos at once: one takes the decision back, the other finds it gone (404); a decision a later change set aside reads as gone too", async () => {
    const postId = await postAtClient(c1);
    const { decisionId } = (await ok(await decide(P.pA1, postId, { decision: "approve", seenHash: await hashOf(P.pA1, postId) }), "decide")) as Json;
    const [a, b] = await Promise.all([undo(P.pA1, decisionId), undo(P.pA1, decisionId)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 404]);
    expect([a, b].find((r) => r.statusCode === 404)!.json().error).toBe("decision_not_found");
    // A change after the client (the Composer's edit of an approved post) resets the reviews inside the window: the decision is gone.
    const second = await postAtClient(c1);
    const dec2 = ((await ok(await decide(P.pA1, second, { decision: "approve", seenHash: await hashOf(P.pA1, second) }), "decide")) as Json).decisionId;
    await adminPool().query(
      `UPDATE social_post_client_reviews SET status = 'pending', decided_by = NULL, decided_at = NULL, decision_id = NULL, undo_until = NULL, reviewed_args_sha256 = NULL
        WHERE variant_id IN (SELECT id FROM social_post_variants WHERE post_id = $1)`, [second]);
    await adminPool().query(`UPDATE social_posts SET pipeline_status = 'client', status = 'in_review' WHERE id = $1`, [second]);
    const u = await undo(P.pA1, dec2);
    expect(u.statusCode).toBe(404);
    expect(u.json().error).toBe("decision_not_found");
  });

  it("the Ball drops a pipeline post that was archived after the client asked for changes (no dead link), and the link is the post's", async () => {
    const postId = await postAtClient(c2);
    expect((await ok(await decide(P.pB, postId, { decision: "change", changeKind: "copy", note: "A tweak.", seenHash: await hashOf(P.pB, postId) }), "decide")).state).toBe("changes_asked");
    const listed = async () => {
      const r = await app.inject({ method: "GET", url: `/api/${A}/portal/health`, headers: as(P.pB) });
      const cl = (r.json() as Json).clients.find((c: Json) => c.clientId === c2.clientId);
      return (cl.clientWide.waitingOnUs.items as Json[]).some((i) => i.kind === "social_post" && i.id === postId);
    };
    expect(await listed()).toBe(true);
    await ok(await act(U.officer, postId, "archive", { reason: "The client cancelled the month." }), "archive");
    // The change request's review is still `changes_requested` (archiving withdraws only pending reviews).
    expect((await reviews(postId)).some((r) => r.status === "changes_requested")).toBe(true);
    expect(await listed()).toBe(false);
  });

  it("a follow-up on a post that is with the client reaches the client's contacts with the portal link, not a staff page", async () => {
    const postId = await postAtClient(c1);
    await ok(await act(U.officer, postId, "follow_up", { note: "Any news?" }), "follow_up");
    for (const contact of [P.pA1, P.pA2]) {
      const n = (await adminPool().query(`SELECT payload FROM notifications WHERE user_id = $1 AND type = 'social.post.follow_up' AND payload->>'entityId' = $2`, [contact, postId])).rows;
      expect(n).toHaveLength(1);
      expect(n[0].payload.href).toBe(`/portal/social?post=${postId}`);
    }
    expect(await noticeCount(P.pB, "social.post.follow_up", postId)).toBe(0);
  });
});
