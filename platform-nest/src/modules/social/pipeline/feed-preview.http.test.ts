// SCP-3d — the client's feed preview against REAL Postgres (the three walls) and REAL Cerbos, through the real HTTP layer: BFF §63.10.
//
//   GET  engagements/:engagementId/feed-preview        social_post · read
//   POST engagements/:engagementId/feed-preview/swap   {postA, postB, expectedA, expectedB}
//
// THE CLAIMS UNDER TEST
//   1. The read answers the engagement's pipeline posts that have a date, NEWEST FIRST, with `locked` true for a live post only, a story left out,
//      and an archived, a deleted, a Composer and an undated post left out; another engagement's and another company's posts never appear. It keeps
//      every post that is not live and the newest 12 live ones (`liveHidden` says how many it left out), and the thumbnail is the first stored design.
//   2. Every item says what a date move would do (`dateMove`, `dateMoveRefusal`), by the fixture (`dateMoveOf`, pure, every status and change case).
//   3. A swap of two drafting posts is two edits: the dates trade, neither post leaves `drafting`, and nobody is asked.
//   4. A swap of two approved posts is two reschedules (SCP-Q13, §63.21): both go back to `client`, every review is pending again, each client is told once,
//      the variants carry the new dates, and each post has its activity row.
//   5. An approved post with a drafting one: the approved one goes back to the client, the drafting one stays a draft.
//   6. ALL OR NOTHING: a post in `proofread` refuses the whole swap 409 `field_locked`, a live post 409 `post_is_live`, and NEITHER post changed; a post
//      that cannot move inside the transaction (no account for its network) rolls the OTHER post's already-applied edit back.
//   7. A stale `expected` (the status, or the date) is 409 `status_changed` and nothing changed; the same date on both is 409 `no_change`.
//   8. A post of another engagement, of another company, or that does not exist is 404; the same post twice is 400; a Composer post is 409.
//   9. AUTHORIZATION BEFORE VALIDATION: a caller who is not the client's officer is 403 `not_the_officer` before the body is read (so before any 400),
//      a caller with no social tier is 403 on the read, and a scheduled post's publisher schedule needs `cancel` (403 `cancel_required`) with nothing changed.
//
// Posts are seeded by SQL at the status under test (the stage machine's own routes are proved by pipeline-routes.test.ts), fixed days far in the future.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { withTenants, newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { seedSocialOrgTree, grantSocialRole } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";
import { FEED_PREVIEW_LIVE_CAP, dateMoveOf, parseSwapBody } from "./feed-preview";

const SOCIAL = { modules: ["social"] };
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const D = (n: number) => `2027-04-${String(n).padStart(2, "0")}T10:00:00.000Z`;
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

describe("dateMoveOf (pure, by the fixture)", () => {
  const post = (pipelineStatus: string, c: { changeBy?: string; changeKind?: string; returnTo?: string } = {}) => ({
    pipelineStatus, changeBy: c.changeBy ?? null, changeKind: c.changeKind ?? null, returnTo: c.returnTo ?? null,
    scheduleVia: null, blockWaitingOn: null, creativeState: null,
  });
  it("planned, drafting and a team copy change are an edit", () => {
    expect(dateMoveOf(post("planned"))).toEqual({ move: "edit", refusal: null });
    expect(dateMoveOf(post("drafting"))).toEqual({ move: "edit", refusal: null });
    for (const [by, kind, to] of [["copywriter", "copy", "proofread"], ["hod", "copy", "hod"], ["final", "copy", "final"]]) {
      expect(dateMoveOf(post("changes", { changeBy: by, changeKind: kind, returnTo: to })), by).toEqual({ move: "edit", refusal: null });
    }
  });
  it("approved and scheduled are a reschedule", () => {
    expect(dateMoveOf(post("approved"))).toEqual({ move: "reschedule", refusal: null });
    expect(dateMoveOf(post("scheduled"))).toEqual({ move: "reschedule", refusal: null });
  });
  it("proofread, hod, design, final, client, blocked and the client's copy change are field_locked; the design changes too", () => {
    for (const s of ["proofread", "hod", "design", "final", "client", "blocked"]) expect(dateMoveOf(post(s)), s).toEqual({ move: "locked", refusal: "field_locked" });
    expect(dateMoveOf(post("changes", { changeBy: "client", changeKind: "copy", returnTo: "proofread" }))).toEqual({ move: "locked", refusal: "field_locked" });
    expect(dateMoveOf(post("changes", { changeBy: "client", changeKind: "design", returnTo: "final" }))).toEqual({ move: "locked", refusal: "field_locked" });
    expect(dateMoveOf(post("changes", { changeBy: "final", changeKind: "design", returnTo: "final" }))).toEqual({ move: "locked", refusal: "field_locked" });
  });
  it("a live post is post_is_live", () => {
    expect(dateMoveOf(post("live"))).toEqual({ move: "locked", refusal: "post_is_live" });
  });
});

describe("parseSwapBody (pure)", () => {
  const ok = { postA: UUID_A, postB: UUID_B, expectedA: { status: "drafting", scheduledAt: D(1) }, expectedB: { status: "approved", scheduledAt: D(2) } };
  const field = (b: unknown) => {
    try {
      parseSwapBody(b);
    } catch (e) {
      const r = (e as { getResponse: () => { message: string; field?: string } }).getResponse();
      return `${r.message}:${r.field}`;
    }
    return "ok";
  };
  it("accepts the shape", () => {
    expect(parseSwapBody({ ...ok, postA: UUID_A.toUpperCase() }).postA).toBe(UUID_A);
  });
  it("names the missing and the invalid field, in order", () => {
    expect(field({})).toBe("missing_field:postA");
    expect(field({ ...ok, postB: undefined })).toBe("missing_field:postB");
    expect(field({ ...ok, postA: "nope" })).toBe("invalid_field:postA");
    expect(field({ ...ok, expectedA: undefined })).toBe("missing_field:expectedA");
    expect(field({ ...ok, expectedB: { status: "approved" } })).toBe("invalid_field:expectedB");
    expect(field({ ...ok, expectedA: { status: "bogus", scheduledAt: D(1) } })).toBe("invalid_field:expectedA");
    expect(field({ ...ok, expectedA: { status: "drafting", scheduledAt: "tomorrow" } })).toBe("invalid_field:expectedA");
  });
  it("refuses the same post twice", () => {
    expect(field({ ...ok, postB: UUID_A })).toBe("invalid_field:postB");
    expect(field("not an object")).toBe("missing_field:postA");
  });
});

describe.skipIf(!TEST_URL)("SCP-3d · the feed preview (BFF §63.10)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  const U: Record<string, string> = {};
  interface Eng { engagementId: string; clientId: string; cycleId: string; accountId: string }
  let eng: Eng;
  let engOther: Eng;
  let engForeign: Eng;
  let n = 0;
  const base = (tenant = A) => `/api/${tenant}/modules/social`;

  const get = (who: string, engagementId: string, tenant = A) =>
    app.inject({ method: "GET", url: `${base(tenant)}/engagements/${engagementId}/feed-preview`, headers: asUser(who) });
  const swap = (who: string, engagementId: string, payload: unknown, tenant = A) =>
    app.inject({ method: "POST", url: `${base(tenant)}/engagements/${engagementId}/feed-preview/swap`, headers: asUser(who), payload: payload as Record<string, unknown> });

  /** An engagement owned by `officer`, with its cycle and an Instagram account (a reschedule syncs the variants to the client's account). */
  async function makeEngagement(tenant: string, officer: string, o: { account?: boolean } = {}): Promise<Eng> {
    n += 1;
    const clientId = await createClient(tenant, `Mock Client ${n}`);
    const engagementId = newId();
    const cycleId = newId();
    const accountId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, owner_id, status, tool_scope, creative_source, platforms, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, 'in_team', $7, 'central')`,
        [engagementId, tenant, clientId, `Mock engagement ${n}`, officer, JSON.stringify({ networks: { instagram: true } }), ["instagram"]],
      );
      if (o.account !== false) {
        const orgId = newId();
        await c.query(
          `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
           VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`,
          [orgId, tenant, clientId, `mock-org-${n}-${newId().slice(0, 8)}`],
        );
        await c.query(
          `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, postiz_integration_id, origin_site)
           VALUES ($1, $2, $3, $4, 'instagram', $5, 'connected', '{"igPosts24h":{"used":0,"cap":100}}', $6, 'central')`,
          [accountId, tenant, clientId, orgId, `@mock-instagram-${n}`, `int-instagram-${n}`],
        );
      }
      await c.query(
        `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
         VALUES ($1, $2, $3, '2027-04-01', '2027-03-26', '2027-03-24', 'central')`,
        [cycleId, tenant, engagementId],
      );
    }, SOCIAL);
    return { engagementId, clientId, cycleId, accountId };
  }

  interface Seed {
    status?: string | null; format?: string; archived?: boolean; deleted?: boolean; simulated?: boolean; variant?: boolean; viaPublisher?: boolean;
    change?: [string, string, string];
  }

  /** A post at `status`, by SQL: the columns its state CHECKs ask for, and (an approved or scheduled post) its variant with the client's approved review. */
  async function seed(e: Eng, tenant: string, title: string, at: string | null, o: Seed = {}): Promise<string> {
    const id = newId();
    const status = o.status === undefined ? "drafting" : o.status;
    const cols: Record<string, unknown> = {
      id, tenant_id: tenant, engagement_id: e.engagementId, cycle_id: status === null ? null : e.cycleId, title, scheduled_at: at, pipeline_status: status,
      status_since: status === null ? null : new Date(), format: o.format ?? "feed", placement: ["instagram"], simulated: o.simulated ?? false,
      deleted_at: o.deleted ? new Date() : null,
    };
    if (o.archived) Object.assign(cols, { archived_at: new Date(), archived_by: U.officer, archive_reason: "archived" });
    if (status === "changes") {
      const [by, kind, to] = o.change ?? ["copywriter", "copy", "proofread"];
      Object.assign(cols, { change_by: by, change_kind: kind, return_to: to, change_note: "a note" });
    }
    if (status === "blocked") Object.assign(cols, { blocked_from: "drafting", block_waiting_on: "officer", block_reason: "waiting", blocked_at: new Date() });
    if (status === "design") Object.assign(cols, { creative_source: "in_team", creative_state: "not_started" });
    if (status === "scheduled") Object.assign(cols, { schedule_via: o.viaPublisher ? "publisher" : "manual" });
    if (status === "live") Object.assign(cols, { schedule_via: "manual", live_url: "https://example.invalid/p/1", went_live_at: new Date() });
    const keys = Object.keys(cols);
    await withTenants([tenant], async (c) => {
      await c.query(`INSERT INTO social_posts (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => cols[k]));
      if (o.variant ?? (status === "approved" || status === "scheduled")) {
        const variantId = newId();
        await c.query(
          `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, scheduled_at, status, origin_site)
           VALUES ($1, $2, $3, $4, 'A mock caption', $5, 'draft', 'central')`,
          [variantId, tenant, id, e.accountId, at],
        );
        await c.query(
          `INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, decided_at, origin_site)
           VALUES ($1, $2, $3, $4, 'approved', now(), 'central')`,
          [newId(), tenant, variantId, e.clientId],
        );
      }
    }, SOCIAL);
    return id;
  }

  const postRow = async (id: string) =>
    (await adminPool().query(
      `SELECT pipeline_status, to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, schedule_via FROM social_posts WHERE id = $1`, [id])).rows[0] as
      { pipeline_status: string; at: string | null; schedule_via: string | null };
  const reviewsOf = async (postId: string) =>
    (await adminPool().query(
      `SELECT r.status FROM social_post_client_reviews r JOIN social_post_variants v ON v.id = r.variant_id WHERE v.post_id = $1 AND v.deleted_at IS NULL`, [postId])).rows.map((r) => r.status as string);
  const variantDates = async (postId: string) =>
    (await adminPool().query(`SELECT scheduled_at FROM social_post_variants WHERE post_id = $1 AND deleted_at IS NULL`, [postId])).rows.map((r) => new Date(r.scheduled_at).toISOString());
  const told = async (postId: string) =>
    (await adminPool().query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'social.client_review.requested' AND payload->>'postId' = $1`, [postId])).rows[0].n as number;
  const activityOf = async (postId: string, verb: string) =>
    (await adminPool().query(
      `SELECT actor_id::text AS actor_id, metadata FROM activities WHERE target_entity_type = 'social_post' AND target_entity_id = $1 AND verb = $2`, [postId, verb])).rows as
      Array<{ actor_id: string; metadata: Record<string, unknown> }>;

  const exp = (status: string, at: string) => ({ status, scheduledAt: at });
  const body = (a: string, ea: [string, string], b: string, eb: [string, string]) => ({ postA: a, postB: b, expectedA: exp(...ea), expectedB: exp(...eb) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP3d Agency", ["social", "pm"]);
    C = await createCompany("SCP3d Other Co", ["social"]);
    await seedSocialOrgTree(A);
    for (const p of ["officer", "otherOfficer", "reader", "noTier", "foreign"]) U[p] = await createUser(`scp3d-${p.toLowerCase()}@mock.test`, `Mock ${p}`);
    for (const p of ["officer", "otherOfficer", "reader", "noTier"]) {
      await addMembership(A, U[p]);
      if (p !== "noTier") await grantSocialRole(A, U[p], "member"); // noTier: a member of the company with no role at all (no social tier)
    }
    await addMembership(C, U.foreign);
    await grantSocialRole(C, U.foreign, "member");
    for (const p of ["officer", "otherOfficer", "reader"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(C, U.foreign, "social_staff");

    eng = await makeEngagement(A, U.officer);
    engOther = await makeEngagement(A, U.otherOfficer);
    engForeign = await makeEngagement(C, U.foreign);

    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // The read
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  describe("GET feed-preview", () => {
    it("answers the grid newest first, with `locked` for a live post only, and what a date move would do", async () => {
      const e = await makeEngagement(A, U.officer);
      const ids: Record<string, string> = {};
      ids.planned = await seed(e, A, "Planned", D(20), { status: "planned" });
      ids.approved = await seed(e, A, "Approved", D(18), { status: "approved" });
      ids.proofread = await seed(e, A, "Proofread", D(16), { status: "proofread", simulated: true });
      ids.live = await seed(e, A, "Live", D(10), { status: "live" });
      ids.clientCopy = await seed(e, A, "Client copy", D(8), { status: "changes", change: ["client", "copy", "proofread"] });
      const r = await get(U.reader, e.engagementId);
      expect(r.statusCode, r.body).toBe(200);
      const j = r.json() as { items: Array<Record<string, unknown>>; liveHidden: number };
      expect(j.items.map((i) => i.title)).toEqual(["Planned", "Approved", "Proofread", "Live", "Client copy"]);
      expect(j.liveHidden).toBe(0);
      expect(j.items[0]).toEqual({
        postId: ids.planned, scheduledAt: D(20), thumbFileId: null, pipelineStatus: "planned", locked: false, title: "Planned", format: "feed",
        phase: "brief", simulated: false, dateMove: "edit", dateMoveRefusal: null,
      });
      expect(j.items.map((i) => i.locked)).toEqual([false, false, false, true, false]);
      expect(j.items.map((i) => [i.dateMove, i.dateMoveRefusal])).toEqual([
        ["edit", null], ["reschedule", null], ["locked", "field_locked"], ["locked", "post_is_live"], ["locked", "field_locked"],
      ]);
      expect(j.items[2].simulated).toBe(true);
    });

    it("leaves out a story, an archived, a deleted, a Composer and an undated post, and every other engagement's and company's post", async () => {
      const e = await makeEngagement(A, U.officer);
      const keep = await seed(e, A, "Kept", D(5), { status: "planned" });
      await seed(e, A, "A story", D(6), { status: "planned", format: "story" });
      await seed(e, A, "Archived", D(7), { status: "planned", archived: true });
      await seed(e, A, "Deleted", D(8), { status: "planned", deleted: true });
      await seed(e, A, "Composer", D(9), { status: null });
      await seed(e, A, "Undated", null, { status: "planned" });
      await seed(engOther, A, "Another client's", D(10), { status: "planned" });
      await seed(engForeign, C, "Another company's", D(11), { status: "planned" });
      const r = await get(U.reader, e.engagementId);
      expect((r.json() as { items: Array<{ postId: string }> }).items.map((i) => i.postId)).toEqual([keep]);
    });

    it("keeps every post that is not live and the newest live ones, and says how many it left out", async () => {
      const e = await makeEngagement(A, U.officer);
      for (let i = 1; i <= FEED_PREVIEW_LIVE_CAP + 3; i++) await seed(e, A, `Live ${i}`, `2027-03-${String(i).padStart(2, "0")}T10:00:00.000Z`, { status: "live" });
      await seed(e, A, "Old planned", "2026-01-05T10:00:00.000Z", { status: "planned" });
      const j = (await get(U.reader, e.engagementId)).json() as { items: Array<{ title: string; locked: boolean }>; liveHidden: number };
      expect(j.items.filter((i) => i.locked)).toHaveLength(FEED_PREVIEW_LIVE_CAP);
      expect(j.liveHidden).toBe(3);
      expect(j.items.map((i) => i.title)).toContain("Old planned"); // never dropped, however old
      expect(j.items.map((i) => i.title)).not.toContain("Live 1");
      expect(j.items[0].title).toBe(`Live ${FEED_PREVIEW_LIVE_CAP + 3}`);
    });

    it("answers the first stored design's file as the thumbnail", async () => {
      const e = await makeEngagement(A, U.officer);
      const postId = await seed(e, A, "With a design", D(4), { status: "final" });
      const fileId = newId();
      await adminPool().query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, scrubbed, origin_site)
         VALUES ($1, $2, $3, 'social_post', $4, 'design.jpg', 'image/jpeg', 1024, $5, false, 'central')`,
        [fileId, A, U.officer, postId, `mock/${fileId}.jpg`],
      );
      await adminPool().query(
        `INSERT INTO social_post_designs (id, tenant_id, post_id, position, link_url, link_source, file_id, added_by, origin_site)
         VALUES ($1, $2, $3, 1, 'https://example.invalid/design', 'own', $4, $5, 'central')`,
        [newId(), A, postId, fileId, U.officer],
      );
      const j = (await get(U.reader, e.engagementId)).json() as { items: Array<{ thumbFileId: string | null }> };
      expect(j.items[0].thumbFileId).toBe(fileId);
    });

    it("is refused without the social tier (403), and an engagement that is not this company's or does not exist is 404", async () => {
      expect((await get(U.noTier, eng.engagementId)).statusCode).toBe(403);
      expect((await get(U.reader, engForeign.engagementId)).statusCode).toBe(404);
      expect((await get(U.reader, newId())).statusCode).toBe(404);
      const bad = await get(U.reader, "not-a-uuid");
      expect(bad.statusCode).toBe(404);
      expect(bad.json().error).toBe("engagement_not_found");
      // The tier decides before the engagement is looked at: a refused caller is never told whether it exists.
      expect((await get(U.noTier, newId())).statusCode).toBe(403);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // The swap
  // ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

  describe("POST feed-preview/swap", () => {
    it("two drafting posts: two edits, the dates trade and nobody is asked", async () => {
      const a = await seed(eng, A, "Drafting one", D(1), { status: "drafting" });
      const b = await seed(eng, A, "Drafting two", D(2), { status: "drafting" });
      const r = await swap(U.officer, eng.engagementId, body(a, ["drafting", D(1)], b, ["drafting", D(2)]));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({
        posts: [
          { postId: a, scheduledAt: D(2), pipelineStatus: "drafting", askedClient: false },
          { postId: b, scheduledAt: D(1), pipelineStatus: "drafting", askedClient: false },
        ],
      });
      expect((await postRow(a)).at).toBe(D(2));
      expect((await postRow(b)).at).toBe(D(1));
      expect((await postRow(a)).pipeline_status).toBe("drafting");
      expect(await told(a)).toBe(0);
      // each post has its own activity row, naming the other
      const act = await activityOf(a, "edit");
      expect(act).toHaveLength(1);
      expect(act[0].actor_id).toBe(U.officer);
      expect(act[0].metadata.swappedWith).toBe(b);
      expect((await activityOf(b, "edit"))[0].metadata.swappedWith).toBe(a);
    });

    it("a planned post and a team copy change are edits too", async () => {
      const a = await seed(eng, A, "Planned", D(3), { status: "planned" });
      const b = await seed(eng, A, "Copy change", D(4), { status: "changes", change: ["hod", "copy", "hod"] });
      const r = await swap(U.officer, eng.engagementId, body(a, ["planned", D(3)], b, ["changes", D(4)]));
      expect(r.statusCode, r.body).toBe(200);
      expect((await postRow(a)).at).toBe(D(4));
      expect((await postRow(b)).at).toBe(D(3));
      expect((await postRow(b)).pipeline_status).toBe("changes");
    });

    it("two approved posts: both go back to the client with every review pending, each client told once (SCP-Q13)", async () => {
      const a = await seed(eng, A, "Approved one", D(5), { status: "approved" });
      const b = await seed(eng, A, "Approved two", D(6), { status: "approved" });
      expect(await reviewsOf(a)).toEqual(["approved"]);
      const r = await swap(U.officer, eng.engagementId, body(a, ["approved", D(5)], b, ["approved", D(6)]));
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({
        posts: [
          { postId: a, scheduledAt: D(6), pipelineStatus: "client", askedClient: true },
          { postId: b, scheduledAt: D(5), pipelineStatus: "client", askedClient: true },
        ],
      });
      for (const [id, at] of [[a, D(6)], [b, D(5)]] as const) {
        const row = await postRow(id);
        expect([row.pipeline_status, row.at, row.schedule_via]).toEqual(["client", at, null]);
        expect(await reviewsOf(id)).toEqual(["pending"]);
        expect(await variantDates(id)).toEqual([at]);
        expect(await told(id)).toBe(1);
        const act = await activityOf(id, "reschedule");
        expect(act).toHaveLength(1);
        expect(act[0].metadata).toMatchObject({ from: "approved", to: "client", swappedWith: id === a ? b : a });
      }
    });

    it("an approved post and a drafting one: the approved one goes back to the client, the drafting one stays a draft", async () => {
      const a = await seed(eng, A, "Approved", D(7), { status: "approved" });
      const b = await seed(eng, A, "Drafting", D(8), { status: "drafting" });
      const r = await swap(U.officer, eng.engagementId, body(a, ["approved", D(7)], b, ["drafting", D(8)]));
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as { posts: Array<{ askedClient: boolean }> }).posts.map((p) => p.askedClient)).toEqual([true, false]);
      expect(await postRow(a)).toMatchObject({ pipeline_status: "client", at: D(8) });
      expect(await postRow(b)).toMatchObject({ pipeline_status: "drafting", at: D(7) });
      expect(await reviewsOf(a)).toEqual(["pending"]);
      expect(await told(b)).toBe(0);
    });

    it("a scheduled post (by hand) is unscheduled, moved and sent back to the client", async () => {
      const a = await seed(eng, A, "Scheduled", D(9), { status: "scheduled" });
      const b = await seed(eng, A, "Approved", D(10), { status: "approved" });
      const r = await swap(U.officer, eng.engagementId, body(a, ["scheduled", D(9)], b, ["approved", D(10)]));
      expect(r.statusCode, r.body).toBe(200);
      expect(await postRow(a)).toMatchObject({ pipeline_status: "client", at: D(10), schedule_via: null });
      expect(await postRow(b)).toMatchObject({ pipeline_status: "client", at: D(9) });
    });

    it("a post in proofread refuses the whole swap, 409 field_locked, and NEITHER post changes", async () => {
      const a = await seed(eng, A, "Drafting", D(11), { status: "drafting" });
      const b = await seed(eng, A, "Proofread", D(12), { status: "proofread" });
      for (const [x, ex, y, ey] of [[a, "drafting", b, "proofread"], [b, "proofread", a, "drafting"]] as const) {
        const r = await swap(U.officer, eng.engagementId, body(x, [ex, x === a ? D(11) : D(12)], y, [ey, y === a ? D(11) : D(12)]));
        expect(r.statusCode, r.body).toBe(409);
        expect(r.json().error).toBe("field_locked");
        expect(r.json().detail).toMatchObject({ postId: b, status: "proofread", field: "scheduledAt" });
      }
      expect(await postRow(a)).toMatchObject({ pipeline_status: "drafting", at: D(11) });
      expect(await postRow(b)).toMatchObject({ pipeline_status: "proofread", at: D(12) });
      expect(await activityOf(a, "edit")).toHaveLength(0);
    });

    it("every other locked step and the client's copy change are field_locked", async () => {
      const a = await seed(eng, A, "Drafting", D(13), { status: "drafting" });
      const cases: Array<[string, Seed]> = [
        ["hod", {}], ["design", {}], ["final", {}], ["client", {}], ["blocked", {}], ["changes", { change: ["client", "copy", "proofread"] }],
      ];
      for (const [status, o] of cases) {
        const b = await seed(eng, A, `Locked ${status}`, D(14), { status, ...o });
        const r = await swap(U.officer, eng.engagementId, body(a, ["drafting", D(13)], b, [status, D(14)]));
        expect(r.statusCode, `${status}: ${r.body}`).toBe(409);
        expect(r.json().error, status).toBe("field_locked");
      }
      expect(await postRow(a)).toMatchObject({ pipeline_status: "drafting", at: D(13) });
    });

    it("a live post is 409 post_is_live and nothing changes", async () => {
      const a = await seed(eng, A, "Approved", D(15), { status: "approved" });
      const b = await seed(eng, A, "Live", D(16), { status: "live" });
      const r = await swap(U.officer, eng.engagementId, body(a, ["approved", D(15)], b, ["live", D(16)]));
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("post_is_live");
      expect(await postRow(a)).toMatchObject({ pipeline_status: "approved", at: D(15) });
      expect(await reviewsOf(a)).toEqual(["approved"]);
      expect(await postRow(b)).toMatchObject({ pipeline_status: "live", at: D(16) });
    });

    it("rolls the first move back when the second cannot happen inside the transaction (all or nothing)", async () => {
      // A drafting post's edit is applied first; the approved post of a client WITHOUT an Instagram account cannot sync its variants
      // (409 no_account_for_network, found under the lock), so the edit must not stay.
      const noAccount = await makeEngagement(A, U.officer, { account: false });
      const a = await seed(noAccount, A, "Drafting", D(17), { status: "drafting" });
      const b = await seed(noAccount, A, "Approved", D(18), { status: "approved", variant: false });
      const r = await swap(U.officer, noAccount.engagementId, body(a, ["drafting", D(17)], b, ["approved", D(18)]));
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("no_account_for_network");
      expect(await postRow(a)).toMatchObject({ pipeline_status: "drafting", at: D(17) });
      expect(await postRow(b)).toMatchObject({ pipeline_status: "approved", at: D(18) });
      expect(await activityOf(a, "edit")).toHaveLength(0);
    });

    it("a stale expected status or date is 409 status_changed and nothing changes", async () => {
      const a = await seed(eng, A, "Drafting", D(19), { status: "drafting" });
      const b = await seed(eng, A, "Approved", D(20), { status: "approved" });
      const staleStatus = await swap(U.officer, eng.engagementId, body(a, ["planned", D(19)], b, ["approved", D(20)]));
      expect(staleStatus.statusCode, staleStatus.body).toBe(409);
      expect(staleStatus.json().error).toBe("status_changed");
      const staleDate = await swap(U.officer, eng.engagementId, body(a, ["drafting", D(19)], b, ["approved", D(21)]));
      expect(staleDate.statusCode, staleDate.body).toBe(409);
      expect(staleDate.json().error).toBe("status_changed");
      expect(staleDate.json().detail).toMatchObject({ postId: b, status: "approved", scheduledAt: D(20) });
      expect(await postRow(a)).toMatchObject({ pipeline_status: "drafting", at: D(19) });
      expect(await postRow(b)).toMatchObject({ pipeline_status: "approved", at: D(20) });
      expect(await reviewsOf(b)).toEqual(["approved"]);
      // replaying a swap that landed is the same refusal: the picture is stale
      const c1 = await seed(eng, A, "One", D(22), { status: "drafting" });
      const c2 = await seed(eng, A, "Two", D(23), { status: "drafting" });
      const payload = body(c1, ["drafting", D(22)], c2, ["drafting", D(23)]);
      expect((await swap(U.officer, eng.engagementId, payload)).statusCode).toBe(200);
      expect((await swap(U.officer, eng.engagementId, payload)).statusCode).toBe(409);
    });

    it("the same date on both posts is 409 no_change", async () => {
      const a = await seed(eng, A, "One", D(24), { status: "drafting" });
      const b = await seed(eng, A, "Two", D(24), { status: "drafting" });
      const r = await swap(U.officer, eng.engagementId, body(a, ["drafting", D(24)], b, ["drafting", D(24)]));
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("no_change");
    });

    it("a post of another engagement, of another company, or that does not exist is 404; the same post twice is 400; a Composer post is 409", async () => {
      const a = await seed(eng, A, "Mine", D(25), { status: "drafting" });
      const other = await seed(engOther, A, "Another client's", D(26), { status: "drafting" });
      const foreign = await seed(engForeign, C, "Another company's", D(27), { status: "drafting" });
      for (const [label, id, at] of [["another engagement", other, D(26)], ["another company", foreign, D(27)], ["nowhere", newId(), D(28)]] as const) {
        const r = await swap(U.officer, eng.engagementId, body(a, ["drafting", D(25)], id, ["drafting", at]));
        expect(r.statusCode, `${label}: ${r.body}`).toBe(404);
        expect(r.json().error, label).toBe("post_not_found");
      }
      expect((await swap(U.officer, eng.engagementId, body(a, ["drafting", D(25)], a, ["drafting", D(25)]))).statusCode).toBe(400);
      const composer = await seed(eng, A, "Composer", D(28), { status: null });
      const c = await swap(U.officer, eng.engagementId, body(a, ["drafting", D(25)], composer, ["drafting", D(28)]));
      expect(c.statusCode, c.body).toBe(409);
      expect(c.json().error).toBe("not_a_pipeline_post");
      // the engagement itself: another company's is 404
      expect((await swap(U.officer, engForeign.engagementId, body(a, ["drafting", D(25)], newId(), ["drafting", D(26)]))).statusCode).toBe(404);
      expect(await postRow(a)).toMatchObject({ pipeline_status: "drafting", at: D(25) });
    });

    it("a body that is wrong is 400 with its field", async () => {
      const a = await seed(eng, A, "Mine", D(1), { status: "drafting" });
      const r = await swap(U.officer, eng.engagementId, { postA: a, postB: "nope", expectedA: exp("drafting", D(1)), expectedB: exp("drafting", D(2)) });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: "invalid_field", field: "postB" });
      expect((await swap(U.officer, eng.engagementId, {})).json()).toMatchObject({ error: "missing_field", field: "postA" });
    });

    it("authorization comes before validation: not the client's officer is 403 not_the_officer, whatever the body", async () => {
      const a = await seed(eng, A, "One", D(2), { status: "drafting" });
      const b = await seed(eng, A, "Two", D(3), { status: "drafting" });
      for (const who of [U.reader, U.otherOfficer]) {
        const bad = await swap(who, eng.engagementId, {});
        expect(bad.statusCode, bad.body).toBe(403);
        expect(bad.json().error).toBe("not_the_officer");
        const valid = await swap(who, eng.engagementId, body(a, ["drafting", D(2)], b, ["drafting", D(3)]));
        expect(valid.statusCode).toBe(403);
      }
      expect((await swap(U.noTier, eng.engagementId, {})).statusCode).toBe(403);
      expect(await postRow(a)).toMatchObject({ at: D(2) });
    });

    it("the officer of another client cannot move this client's dates; the officer can on theirs only", async () => {
      const a = await seed(engOther, A, "One", D(4), { status: "drafting" });
      const b = await seed(engOther, A, "Two", D(5), { status: "drafting" });
      expect((await swap(U.officer, engOther.engagementId, body(a, ["drafting", D(4)], b, ["drafting", D(5)]))).statusCode).toBe(403);
      expect((await swap(U.otherOfficer, engOther.engagementId, body(a, ["drafting", D(4)], b, ["drafting", D(5)]))).statusCode).toBe(200);
    });

    it("a publisher schedule needs `cancel` as well: the officer is 403 cancel_required and nothing changes", async () => {
      const a = await seed(eng, A, "Via the publisher", D(6), { status: "scheduled", viaPublisher: true });
      const b = await seed(eng, A, "Drafting", D(7), { status: "drafting" });
      const r = await swap(U.officer, eng.engagementId, body(a, ["scheduled", D(6)], b, ["drafting", D(7)]));
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe("cancel_required");
      expect(await postRow(a)).toMatchObject({ pipeline_status: "scheduled", at: D(6) });
      expect(await postRow(b)).toMatchObject({ pipeline_status: "drafting", at: D(7) });
    });
  });
});
