// SCP-3a / SCP-3b — scheduling by hand and marking live by hand (FRONTEND-BFF-CONTRACT §63.10; plan §4.3, §8 rows 3a and 3b;
// fixture scp-stage-machine.json actions `schedule`, `unschedule`, `reschedule`, `mark_live`) against live Postgres and Cerbos,
// through `POST posts/:postId/actions` as real personas. Skips without DATABASE_URL_TEST, like every suite here; on CI it runs for real.
// The publisher's result path and the simulator have their own suites (`publisher-result.test.ts`, `simulated-publisher.http.test.ts`).
//
// What it proves:
//   (1) "Schedule in Meta" by hand at the approved date, time and placement: `scheduled`, `schedule_via` manual, the engine status the
//       fixture gives, and the client's approval KEPT (every review `approved` on the same `reviewed_args_sha256`, nobody asked again),
//       for the three placements: feed and carousel on Instagram + Facebook, a reel on Instagram + Facebook, a story on Instagram;
//   (2) the media validator: a placement whose media fails a rule is 409 `media_rules_failed` naming the variant and the rule, and the post
//       stays `approved`;
//   (3) `approved_time_passed`: an approved time more than 5 minutes ago is refused, one inside the grace schedules;
//   (4) unschedule by hand: back to `approved`, the reviews still approved, and scheduling again works;
//   (5) reschedule (SCP-Q13): a new time or placement asks the client again (every review pending, the client told once, a variant of a
//       dropped network soft-deleted with its review withdrawn); from `scheduled` it unschedules first; unchanged values are 409 `no_change`;
//   (6) mark live by hand: each variant becomes a native-import bookkeeping row, the post gets its link and its time, a bad link is 400,
//       and a post that is not scheduled is refused;
//   (7) who: the officer schedules; a copywriter, a designer and a plain member are refused.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialSeat, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { variantArgsSha256 } from "../canonical-args";
import { MUST_HAVE_KEYS } from "./handoff-checks";

const SOCIAL = { modules: ["social"] };
const SVC = { authorization: "Bearer svc-token" };
const as = (userId: string) => ({ ...SVC, "x-user-id": userId });
const DAY = 24 * 60 * 60 * 1000;
/** Facebook's native window is 10 minutes to 30 days ahead of the check, so every Instagram + Facebook post is dated days from now. */
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

interface Eng { clientId: string; engagementId: string; cycleId: string }
type Asset = "image" | "video";
type Json = Record<string, any>;

describe.skipIf(!TEST_URL)("SCP-3a/3b · schedule by hand and mark live (BFF §63.10)", () => {
  let app: NestFastifyApplication;
  let A: string;
  const U: Record<string, string> = {};
  const assets: Record<Asset, string> = { image: "", video: "" };
  let eng: Eng;
  let n = 0;
  const base = () => `/api/${A}/modules/social`;

  // ── fixtures ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** An in-team engagement of the officer, with a connected Instagram and Facebook account and a planned cycle. */
  async function freshEngagement(): Promise<Eng> {
    n += 1;
    const clientId = await createClient(A, `Mock Client ${n}`);
    const engagementId = newId();
    const cycleId = newId();
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'in_team', $7, 'central')`,
        [engagementId, A, clientId, `Mock engagement ${n}`, U.officer, JSON.stringify({ networks: { instagram: true, facebook: true } }), ["instagram", "facebook"]],
      );
      const orgId = newId();
      await c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
        [orgId, A, clientId, `mock-org-${n}-${newId().slice(0, 8)}`],
      );
      for (const network of ["instagram", "facebook"]) {
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $7, 'central')`,
          [newId(), A, clientId, orgId, network, `@mock-${network}-${n}`, `int-${network}-${n}`],
        );
      }
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         -- this month's cycle, its ready-by already passed, so a post dated in the next days is not before it (hand-off check date_before_ready_by)
         VALUES ($1, $2, $3, date_trunc('month', current_date)::date, current_date - 8, current_date - 10, 'central')`,
        [cycleId, A, engagementId],
      );
    }, SOCIAL);
    return { clientId, engagementId, cycleId };
  }

  async function row(postId: string) {
    const r = await adminPool().query(
      `SELECT pipeline_status, status, schedule_via, live_url, went_live_at, scheduled_at, placement FROM social_posts WHERE id = $1`, [postId]);
    return r.rows[0] as { pipeline_status: string; status: string; schedule_via: string | null; live_url: string | null; went_live_at: Date | null; scheduled_at: Date | null; placement: string[] };
  }
  async function act(who: string, postId: string, action: string, body: Record<string, unknown> = {}) {
    const expectedStatus = body.expectedStatus ?? (await row(postId))?.pipeline_status ?? "planned";
    return app.inject({ method: "POST", url: `${base()}/posts/${postId}/actions`, headers: as(who), payload: { action, expectedStatus, ...body } });
  }
  async function ok(res: { statusCode: number; body: string; json: () => unknown }, label: string) {
    if (res.statusCode !== 200 && res.statusCode !== 201) throw new Error(`${label}: ${res.statusCode} ${res.body}`);
    return res.json() as Json;
  }
  /** Every variant of the post (the dropped ones too) with its review. */
  async function variants(postId: string) {
    return (await adminPool().query(
      `SELECT v.id::text AS id, a.network, v.status, v.args_sha256, v.scheduled_at, v.deleted_at, v.native_import, v.published_url, v.published_at,
              v.approval_id, v.provider_post_id, v.media, v.validation, v.settings,
              r.status AS review_status, r.reviewed_args_sha256
         FROM social_post_variants v
         JOIN social_accounts a ON a.id = v.account_id
         LEFT JOIN social_post_client_reviews r ON r.variant_id = v.id
        WHERE v.post_id = $1 ORDER BY a.network, v.created_at`, [postId])).rows as Json[];
  }
  const live = async (postId: string) => (await variants(postId)).filter((v) => v.deleted_at === null);
  /** What the client approved, as the reviews carry it. */
  const approvedSnapshot = async (postId: string) => (await live(postId)).map((v) => [v.network, v.review_status, v.reviewed_args_sha256, v.args_sha256]);
  /** Outbox events that ask the client to review this post: the client is "told" once per ask. */
  const asks = async (postId: string) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'social.client_review.requested' AND payload->>'postId' = $1`, [postId])).rows[0].n);
  const activityCount = async (postId: string, verb: string) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM activities WHERE target_entity_id = $1 AND verb = $2`, [postId, verb])).rows[0].n);

  async function newPost(format: string, placement: string[], scheduledAt: string, title = "Mock bakery: morning pastries"): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `${base()}/cycles/${eng.cycleId}/posts`, headers: as(U.officer), payload: { title, format, scheduledAt, placement },
    });
    return (await ok(res, "create")).post.id as string;
  }
  /** Drive a new in-team post through the real routes to `approved` (the officer records the client's approval), with this design asset. */
  async function approvedPost(o: { format?: string; placement?: string[]; scheduledAt?: string; asset?: Asset } = {}): Promise<string> {
    const postId = await newPost(o.format ?? "feed", o.placement ?? ["instagram"], o.scheduledAt ?? inDays(3));
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
    await ok(await act(U.designer, postId, "start_design"), "start_design");
    await ok(await app.inject({
      method: "POST", url: `${base()}/posts/${postId}/designs`, headers: as(U.designer), payload: { expectedStatus: "design", assetGroupId: assets[o.asset ?? "image"] },
    }), "add_design");
    await ok(await act(U.designer, postId, "submit_design"), "submit_design");
    await ok(await act(U.hod, postId, "final_approve"), "final_approve");
    await ok(await act(U.officer, postId, "record_client_approve", { channel: "whatsapp", note: "Approved on a call." }), "record_client_approve");
    expect((await row(postId)).pipeline_status).toBe("approved");
    return postId;
  }
  /** Move the approved time itself (the post's, the variants', and the approval with it) so a test can put it in the past. */
  async function moveApprovedTime(postId: string, iso: string) {
    await adminPool().query(`UPDATE social_posts SET scheduled_at = $2 WHERE id = $1`, [postId, iso]);
    for (const v of await variants(postId)) {
      if (v.deleted_at !== null) continue;
      const acc = (await adminPool().query(`SELECT account_id::text AS a, first_comment, body FROM social_post_variants WHERE id = $1`, [v.id])).rows[0];
      const hash = variantArgsSha256({ tenantId: A, id: v.id, accountId: acc.a, body: acc.body, firstComment: acc.first_comment, media: v.media, settings: v.settings, scheduledAt: iso });
      await adminPool().query(`UPDATE social_post_variants SET scheduled_at = $2, args_sha256 = $3 WHERE id = $1`, [v.id, iso, hash]);
      await adminPool().query(`UPDATE social_post_client_reviews SET reviewed_args_sha256 = $2 WHERE variant_id = $1`, [v.id, hash]);
    }
  }

  // ── setup ───────────────────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.SOCIAL_POSTIZ_ORG_API_KEY = "mock-key";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("Mock Agency", ["social", "pm"]);
    const units = await seedSocialOrgTree(A);
    for (const p of ["officer", "copywriter", "hod", "designer", "member"]) {
      U[p] = await createUser(`scp3ab-${p}@mock.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
      await grantSocialRole(A, U[p], "member");
    }
    for (const p of ["officer", "copywriter", "hod"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");
    await grantSocialRole(A, U.designer, "social_designer");
    await grantSocialSeat(A, units.socialMedia, U.hod);

    for (const [kind, type] of [["image", "image/jpeg"], ["video", "video/mp4"]] as const) {
      const id = newId();
      await adminPool().query(
        `INSERT INTO creative_assets (id, tenant_id, uploader_id, name, content_type, grade, graded_key, graded_byte_size, origin_site)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, 1024, 'central')`,
        [id, A, U.designer, `Mock ${kind}`, type, `mock/${id}.${kind === "image" ? "jpg" : "mp4"}`],
      );
      assets[kind] = id;
    }
    eng = await freshEngagement();
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (1) schedule by hand, keeping the approval, for the three placements
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  const PLACEMENTS: Array<{ name: string; format: string; placement: string[]; asset: Asset; igType: string }> = [
    { name: "feed on Instagram and Facebook", format: "feed", placement: ["instagram", "facebook"], asset: "image", igType: "feed" },
    { name: "carousel on Instagram and Facebook", format: "carousel", placement: ["instagram", "facebook"], asset: "image", igType: "feed" },
    { name: "a reel on Instagram and Facebook", format: "reel", placement: ["instagram", "facebook"], asset: "video", igType: "reel" },
    { name: "a story on Instagram", format: "story", placement: ["instagram"], asset: "image", igType: "story" },
  ];
  for (const p of PLACEMENTS) {
    it(`schedules ${p.name} by hand at the approved values and keeps the client's approval`, async () => {
      const at = inDays(3);
      const postId = await approvedPost({ format: p.format, placement: p.placement, asset: p.asset, scheduledAt: at });
      const before = await approvedSnapshot(postId);
      const asked = await asks(postId);
      expect(before.map((b) => b[0])).toEqual([...p.placement].sort());
      expect(before.every((b) => b[1] === "approved" && b[2] !== null && b[2] === b[3])).toBe(true);

      const res = await act(U.officer, postId, "schedule");
      expect(res.statusCode, res.body).toBe(200);
      const post = await row(postId);
      // The engine status the fixture gives a scheduled post (`engineStatus.byPipelineStatus.scheduled`).
      expect(post).toMatchObject({ pipeline_status: "scheduled", status: "scheduled", schedule_via: "manual" });
      // The approved date, time and placement are used as they are.
      expect(new Date(post.scheduled_at!).toISOString()).toBe(at);
      expect([...post.placement].sort()).toEqual([...p.placement].sort());
      // The approval is kept: the same reviews, approved, on the same hash; nobody is asked again.
      expect(await approvedSnapshot(postId)).toEqual(before);
      expect(await asks(postId)).toBe(asked);
      // The media fits each network and format.
      const vs = await live(postId);
      expect(vs.every((v) => (v.validation as Json).ok !== false)).toBe(true);
      expect((vs.find((v) => v.network === "instagram")!.settings as Json).igType).toBe(p.igType);
      expect(await activityCount(postId, "schedule")).toBe(1);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (2) the media validator
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("a reel with an image is 409 media_rules_failed naming the variant and the rule, and the post stays approved", async () => {
    const postId = await approvedPost({ format: "reel", placement: ["instagram"], asset: "image" });
    const res = await act(U.officer, postId, "schedule");
    expect(res.statusCode).toBe(409);
    const body = res.json() as Json;
    expect(body.error).toBe("media_rules_failed");
    const ig = (await live(postId))[0];
    expect(body.detail.variants).toHaveLength(1);
    expect(body.detail.variants[0].variantId).toBe(ig.id);
    expect(body.detail.variants[0].errors.map((e: Json) => e.rule)).toContain("reel_requires_video");
    expect(await row(postId)).toMatchObject({ pipeline_status: "approved", status: "approved", schedule_via: null });
    expect(await activityCount(postId, "schedule")).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (3) the approved time
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("an approved time more than 5 minutes ago is 409 approved_time_passed; one inside the grace schedules", async () => {
    const late = await approvedPost();
    await moveApprovedTime(late, ago(10));
    const res = await act(U.officer, late, "schedule");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("approved_time_passed");
    expect((await row(late)).pipeline_status).toBe("approved");

    // Instagram has no native window, so the grace is judged alone here (an Instagram + Facebook post at that time would meet Facebook's
    // ten-minute lead rule first, which is the media validator's answer).
    const inGrace = await approvedPost();
    await moveApprovedTime(inGrace, ago(3));
    const inside = await act(U.officer, inGrace, "schedule");
    expect(inside.statusCode, inside.body).toBe(200);
    expect((await row(inGrace)).pipeline_status).toBe("scheduled");
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (4) unschedule by hand
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("unschedule by hand goes back to approved with the reviews still approved, and scheduling again works", async () => {
    const postId = await approvedPost({ placement: ["instagram", "facebook"] });
    const before = await approvedSnapshot(postId);
    const asked = await asks(postId); // final_approve asked the client once already
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    const un = await act(U.officer, postId, "unschedule");
    expect(un.statusCode, un.body).toBe(200);
    expect(await row(postId)).toMatchObject({ pipeline_status: "approved", status: "approved", schedule_via: null });
    expect(await approvedSnapshot(postId)).toEqual(before);
    expect(await asks(postId)).toBe(asked);
    const again = await act(U.officer, postId, "schedule");
    expect(again.statusCode, again.body).toBe(200);
    expect(await row(postId)).toMatchObject({ pipeline_status: "scheduled", schedule_via: "manual" });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (5) reschedule asks the client again (SCP-Q13)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("reschedule from approved with a new time sends it back to the client: every review pending, the client told once", async () => {
    const postId = await approvedPost({ placement: ["instagram", "facebook"] });
    const asked = await asks(postId);
    const later = inDays(5);
    const res = await act(U.officer, postId, "reschedule", { at: later });
    expect(res.statusCode, res.body).toBe(200);
    const post = await row(postId);
    expect(post).toMatchObject({ pipeline_status: "client", status: "in_review", schedule_via: null });
    expect(new Date(post.scheduled_at!).toISOString()).toBe(later);
    const vs = await live(postId);
    expect(vs).toHaveLength(2);
    expect(vs.every((v) => v.review_status === "pending" && v.reviewed_args_sha256 === null)).toBe(true);
    expect(vs.every((v) => new Date(v.scheduled_at).toISOString() === later)).toBe(true);
    expect(await asks(postId)).toBe(asked + 1);
    // The client approves the new time and it schedules at that time.
    await ok(await act(U.officer, postId, "record_client_approve", { channel: "email", note: "Fine at the new time." }), "approve again");
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    expect(new Date((await row(postId)).scheduled_at!).toISOString()).toBe(later);
  });

  it("reschedule with a new placement drops the other network's variant (soft-deleted, review withdrawn) and syncs the rest", async () => {
    const postId = await approvedPost({ placement: ["instagram", "facebook"] });
    const fb = (await variants(postId)).find((v) => v.network === "facebook")!;
    const asked = await asks(postId);
    const res = await act(U.officer, postId, "reschedule", { placement: ["instagram"] });
    expect(res.statusCode, res.body).toBe(200);
    const post = await row(postId);
    expect(post).toMatchObject({ pipeline_status: "client", schedule_via: null });
    expect(post.placement).toEqual(["instagram"]);
    const after = await variants(postId);
    const dropped = after.find((v) => v.id === fb.id)!;
    expect(dropped.deleted_at).not.toBeNull();
    // The client is not asked about a network that left: the dropped variant's review is never set pending. A pending review on it would
    // be withdrawn; this one was approved, and stays as the record of that decision (a deleted variant is skipped by every post read).
    expect(dropped.review_status).not.toBe("pending");
    const kept = after.filter((v) => v.deleted_at === null);
    expect(kept.map((v) => v.network)).toEqual(["instagram"]);
    expect(kept[0]).toMatchObject({ review_status: "pending", reviewed_args_sha256: null });
    expect(await asks(postId)).toBe(asked + 1);
  });

  it("reschedule from scheduled unschedules first, then asks the client", async () => {
    const postId = await approvedPost({ placement: ["instagram", "facebook"] });
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    const res = await act(U.officer, postId, "reschedule", { at: inDays(6) });
    expect(res.statusCode, res.body).toBe(200);
    expect(await row(postId)).toMatchObject({ pipeline_status: "client", status: "in_review", schedule_via: null });
    const vs = await live(postId);
    expect(vs.every((v) => v.review_status === "pending" && v.status === "draft" && v.approval_id === null)).toBe(true);
  });

  it("reschedule with unchanged values is 409 no_change and moves nothing", async () => {
    const at = inDays(3);
    const postId = await approvedPost({ placement: ["instagram", "facebook"], scheduledAt: at });
    const before = await approvedSnapshot(postId);
    for (const body of [{ at }, { placement: ["facebook", "instagram"] }, { at, placement: ["instagram", "facebook"] }]) {
      const res = await act(U.officer, postId, "reschedule", body);
      expect(res.statusCode, JSON.stringify(body)).toBe(409);
      expect(res.json().error).toBe("no_change");
    }
    expect((await row(postId)).pipeline_status).toBe("approved");
    expect(await approvedSnapshot(postId)).toEqual(before);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (6) mark live by hand
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("mark_live with a link makes every variant a native-import published row and the post live", async () => {
    const postId = await approvedPost({ placement: ["instagram", "facebook"] });
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    const url = "https://www.instagram.example/p/mock-post-1/";
    const at = ago(30);
    const res = await act(U.officer, postId, "mark_live", { url, at });
    expect(res.statusCode, res.body).toBe(200);
    const vs = await live(postId);
    expect(vs).toHaveLength(2);
    for (const v of vs) {
      expect(v.native_import).toBe(true);
      expect(v.status).toBe("published");
      expect(v.published_url).toBe(url);
      expect(new Date(v.published_at).toISOString()).toBe(at);
      expect(v.approval_id).toBeNull();
      expect(v.provider_post_id).toBeNull();
    }
    const post = await row(postId);
    expect(post).toMatchObject({ pipeline_status: "live", live_url: url });
    expect(new Date(post.went_live_at!).toISOString()).toBe(at);
    expect(await activityCount(postId, "mark_live")).toBe(1);
  });

  it("mark_live without a time uses now", async () => {
    const postId = await approvedPost();
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    const t0 = Date.now();
    await ok(await act(U.officer, postId, "mark_live", { url: "https://www.instagram.example/p/mock-post-2/" }), "mark_live");
    const went = new Date((await row(postId)).went_live_at!).getTime();
    expect(went).toBeGreaterThanOrEqual(t0 - 60_000);
    expect(went).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("a missing or bad link is 400 and the post stays scheduled", async () => {
    const postId = await approvedPost();
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    const missing = await act(U.officer, postId, "mark_live", {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("missing_field");
    for (const url of ["not a link", "ftp://files.example/post", "javascript:alert(1)"]) {
      const res = await act(U.officer, postId, "mark_live", { url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error).toBe("invalid_field");
    }
    const badAt = await act(U.officer, postId, "mark_live", { url: "https://www.instagram.example/p/x/", at: "yesterday" });
    expect(badAt.statusCode).toBe(400);
    expect(await row(postId)).toMatchObject({ pipeline_status: "scheduled", live_url: null });
    expect((await live(postId)).every((v) => v.native_import === false && v.status !== "published")).toBe(true);
  });

  it("mark_live on an approved post that is not scheduled is refused with invalid_transition", async () => {
    const postId = await approvedPost();
    const res = await act(U.officer, postId, "mark_live", { url: "https://www.instagram.example/p/mock-post-3/" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_transition");
    expect(await row(postId)).toMatchObject({ pipeline_status: "approved", live_url: null });
    expect(await activityCount(postId, "mark_live")).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // (7) who (the full matrix is pipeline-authz.db.test.ts)
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  it("a copywriter, a designer and a plain member cannot schedule or mark live: 403 not_the_officer, nothing changes", async () => {
    const postId = await approvedPost();
    for (const who of ["copywriter", "designer", "member"]) {
      const res = await act(U[who], postId, "schedule");
      expect(res.statusCode, who).toBe(403);
      expect(res.json().error, who).toBe("not_the_officer");
    }
    expect((await row(postId)).pipeline_status).toBe("approved");
    await ok(await act(U.officer, postId, "schedule"), "schedule");
    for (const who of ["copywriter", "designer", "member"]) {
      for (const [action, extra] of [["unschedule", {}], ["reschedule", { at: inDays(8) }], ["mark_live", { url: "https://www.instagram.example/p/mock-post-4/" }]] as const) {
        const res = await act(U[who], postId, action, extra);
        expect(res.statusCode, `${who} ${action}`).toBe(403);
        expect(res.json().error, `${who} ${action}`).toBe("not_the_officer");
      }
    }
    expect(await row(postId)).toMatchObject({ pipeline_status: "scheduled", schedule_via: "manual" });
  });
});
