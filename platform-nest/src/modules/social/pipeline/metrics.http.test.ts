// SCP-3c — `POST variants/:variantId/metrics` and `GET posts/:postId/metrics` against REAL Postgres (the three walls) and REAL Cerbos, through the
// real HTTP layer: BFF §63.10 "Metrics".
//
// THE CLAIMS UNDER TEST
//   POST
//   1. The client's officer (`social_post` · `schedule` on the post's real resource) appends one `manual` row: 201 with the stored row, `entered_by` the
//      caller, `fetched_at` the `capturedAt` typed; one `enter_metrics` activity row follows; a counter not sent is NULL, never 0; a second entry appends
//      (no upsert).
//   2. Another client's officer, a copywriter, a read-only member, a member with no social tier and another company's member are 403 (own code
//      `not authorized: …`), and a refused caller is 403 even with a bad body or on a post that is not live (authorization before validation).
//   3. Every bad field is 400 `{error, field}` (`missing_field` for an absent `capturedAt` or `reach`); nothing is written.
//   4. 409 `post_not_live` unless the post is `live`; 409 `not_a_pipeline_post` for a Composer post.
//   5. An unknown, deleted or another company's variant (and a non-uuid) is 404 `post_not_found`.
//   GET
//   6. `latest` is each variant's NEWEST snapshot (by capture time, not by when the row was written), summed across the post's variants; a counter nobody
//      reported is null; the source is simulated if any variant's is, else manual, else pull; the capture time the newest.
//   7. The rate is (likes + comments + saves + shares) / reach over the variants that report a reach; null without one. The account average is the mean
//      rate of the same engagement's OTHER live posts that went live in the last 90 days and have a rate: an older, archived, deleted, not-live,
//      Composer or another engagement's post is left out.
//   8. `boostCandidate` is the rate at least the company's factor (1.25 by default, `social_settings.boost_candidate_factor`) times the average: the exact bar
//      counts, one hair under does not; false when the rate or the average is null.
//   9. `simulated` is the post's flag or a simulated source.
//   10. `social_post` · `read` decides (the read tier and the copywriter read; no tier and another company are 403); 404 and 409 as POST's.
//
// The pure maths is pinned in post-metrics.test.ts; this suite proves the SQL and the walls.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { newId } from "../../../db";
import { buildApp } from "../../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../../testing/fixtures";
import { grantSocialRole, placeOfficerOnAllocation, seedSocialOrgTree } from "../../../testing/social-pipeline-fixtures";
import { registerModule, resetModules } from "../../registry";
import { socialModule } from "../index";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const DAY = 86_400_000;
const ago = (days: number): Date => new Date(Date.now() - days * DAY);
const isoAgo = (days: number): string => ago(days).toISOString();
/** True when `iso` is `days` ago, give or take the seconds a test takes to run. */
const isAbout = (iso: string, days: number): boolean => Math.abs(Date.parse(iso) - ago(days).getTime()) < 30_000;

interface Eng { id: string; clientId: string; cycleId: string; ig: string; fb: string }
interface SnapIn {
  reach?: number | null; impressions?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null;
  videoViews?: number | null; clicks?: number | null; source?: "pull" | "manual" | "simulated"; daysAgo?: number; by?: string;
}
interface VariantIn { on: "ig" | "fb"; snaps?: SnapIn[] }
interface PostIn {
  title: string; liveDaysAgo?: number; status?: string; simulated?: boolean; archived?: boolean; deleted?: boolean; composer?: boolean; variants?: VariantIn[];
}
interface Made { postId: string; variants: string[] }
interface Answer {
  latest: null | {
    reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
    clicks: number | null; videoViews: number | null; source: string; capturedAt: string;
  };
  engagementRate: number | null; accountAverageRate: number | null; boostCandidate: boolean; simulated: boolean;
}

describe.skipIf(!TEST_URL)("SCP-3c · post metrics (BFF §63.10)", () => {
  let app: NestFastifyApplication;
  let A: string; // the agency: social on
  let C: string; // another company: social on
  const U: Record<string, string> = {};
  let engMain: Eng; // the officer's client for the write routes
  let engOther: Eng; // the other officer's client
  let engC: Eng;
  let seq = 0;

  const route = (tenant: string, tail: string) => `/api/${tenant}/modules/social/${tail}`;
  const enter = (who: string, variantId: string, body: unknown, tenant = A) =>
    app.inject({ method: "POST", url: route(tenant, `variants/${variantId}/metrics`), headers: asUser(who), payload: body as object });
  const read = (who: string, postId: string, tenant = A) =>
    app.inject({ method: "GET", url: route(tenant, `posts/${postId}/metrics`), headers: asUser(who) });
  const answer = async (postId: string, who = U.staff): Promise<Answer> => {
    const r = await read(who, postId);
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as Answer;
  };
  const good = (over: Record<string, unknown> = {}) => ({ capturedAt: isoAgo(0.01), reach: 1000, ...over });

  /** An engagement with a cycle, a publisher org and an Instagram and a Facebook account (a pipeline post needs its cycle). */
  async function makeEngagement(tenant: string, name: string, officer: string | null): Promise<Eng> {
    const clientId = await createClient(tenant, name);
    const id = newId();
    const cycleId = newId();
    const org = newId();
    const ig = newId();
    const fb = newId();
    const db = adminPool();
    await db.query(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status, owner_id) VALUES ($1, $2, $3, $4, 'active', $5)`,
      [id, tenant, clientId, `${name} engagement`, officer]);
    await db.query(
      `INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
       VALUES ($1, $2, $3, '2026-03-01', '2026-02-26', '2026-02-24', 'central')`, [cycleId, tenant, id]);
    await db.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1, $2, $3, 'postiz', $4, 'default', 'active', 'central')`, [org, tenant, clientId, `scp3c-org-${++seq}`]);
    for (const [acc, network] of [[ig, "instagram"], [fb, "facebook"]] as const) {
      await db.query(
        `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, quota, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'connected', '{}', 'central')`, [acc, tenant, clientId, org, network, `@scp3c-${++seq}`]);
    }
    return { id, clientId, cycleId, ig, fb };
  }

  async function addSnap(variantId: string, tenant: string, s: SnapIn): Promise<void> {
    const source = s.source ?? "pull";
    await adminPool().query(
      `INSERT INTO social_post_metrics (tenant_id, variant_id, reach, impressions, likes, comments, shares, saves, video_views, clicks, source, entered_by, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [tenant, variantId, s.reach ?? null, s.impressions ?? null, s.likes ?? null, s.comments ?? null, s.shares ?? null, s.saves ?? null,
       s.videoViews ?? null, s.clicks ?? null, source, source === "manual" ? (s.by ?? U.officer) : null, ago(s.daysAgo ?? 1)],
    );
  }

  /** One pipeline post (live by default) with its variants and their snapshots, in `tenant`'s engagement `e`. */
  async function makePost(e: Eng, p: PostIn, tenant = A): Promise<Made> {
    const postId = newId();
    const status = p.composer ? null : (p.status ?? "live");
    const live = status === "live";
    const db = adminPool();
    await db.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, pipeline_status, status_since, schedule_via, live_url, went_live_at,
                                 simulated, archived_at, archived_by, archive_reason, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END,
               CASE WHEN $6::text IN ('scheduled', 'live') THEN 'manual' ELSE NULL END,
               CASE WHEN $7::boolean THEN 'https://instagram.example.test/p/mock' ELSE NULL END,
               CASE WHEN $7::boolean THEN $8::timestamptz ELSE NULL END,
               $9::boolean, CASE WHEN $10::boolean THEN now() ELSE NULL END, CASE WHEN $10::boolean THEN $11::uuid ELSE NULL END,
               CASE WHEN $10::boolean THEN 'archived' ELSE NULL END, CASE WHEN $12::boolean THEN now() ELSE NULL END)`,
      [postId, tenant, e.id, status === null ? null : e.cycleId, p.title, status, live, ago(p.liveDaysAgo ?? 5), p.simulated ?? false,
       p.archived ?? false, U.officer, p.deleted ?? false],
    );
    const variants: string[] = [];
    for (const v of p.variants ?? []) {
      const id = newId();
      // A hand-posted variant is a bookkeeping row (native_import, published); any other post's variant is a draft.
      await db.query(
        `INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, status, native_import, published_url, published_at, origin_site)
         VALUES ($1, $2, $3, $4, 'copy', $5, $6::boolean, CASE WHEN $6::boolean THEN 'https://example.test/p' ELSE NULL END,
                 CASE WHEN $6::boolean THEN now() ELSE NULL END, 'central')`,
        [id, tenant, postId, v.on === "ig" ? e.ig : e.fb, live ? "published" : "draft", live],
      );
      variants.push(id);
      for (const s of v.snaps ?? []) await addSnap(id, tenant, s);
    }
    return { postId, variants };
  }

  /** A live post with one Instagram variant holding one snapshot: `engaged` likes over `reach`. */
  const rated = (e: Eng, title: string, reach: number, engaged: number, liveDaysAgo = 5, extra: Partial<PostIn> = {}) =>
    makePost(e, { title, liveDaysAgo, variants: [{ on: "ig", snaps: [{ reach, likes: engaged }] }], ...extra });

  const rows = async (variantId: string) =>
    (await adminPool().query(`SELECT * FROM social_post_metrics WHERE variant_id = $1 ORDER BY created_at, id`, [variantId])).rows as Array<Record<string, unknown>>;
  const fresh = async (name: string) => makeEngagement(A, name, U.officer);
  const setFactor = (factor: number | null) =>
    factor === null
      ? adminPool().query(`DELETE FROM social_settings WHERE tenant_id = $1`, [A])
      : adminPool().query(
          `INSERT INTO social_settings (tenant_id, boost_candidate_factor) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET boost_candidate_factor = EXCLUDED.boost_candidate_factor`, [A, factor]);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SCP3c Agency", ["social"]);
    C = await createCompany("SCP3c Other Co", ["social"]);
    await seedSocialOrgTree(A);
    await seedSocialOrgTree(C);
    for (const p of ["officer", "otherOfficer", "copywriter", "staff", "noTier"]) {
      U[p] = await createUser(`${p.toLowerCase()}@scp3c.test`, `Mock ${p}`);
      await addMembership(A, U[p]);
    }
    U.outsider = await createUser("outsider@scp3c.test", "Mock outsider");
    await addMembership(C, U.outsider);
    await grantSocialRole(C, U.outsider, "social_staff");
    for (const p of ["officer", "otherOfficer", "staff"]) await grantSocialRole(A, U[p], "social_staff");
    await grantSocialRole(A, U.copywriter, "social_copywriter");

    engMain = await makeEngagement(A, "Metrics Alpha", null);
    engOther = await makeEngagement(A, "Metrics Beta", null);
    engC = await makeEngagement(C, "Metrics Other", null);
    await placeOfficerOnAllocation(A, engMain.id, U.officer);
    await placeOfficerOnAllocation(A, engOther.id, U.otherOfficer);

    app = await buildApp();
  }, 120_000);
  afterAll(async () => {
    await setFactor(null).catch(() => {});
    await app?.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // POST variants/:variantId/metrics
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("POST variants/:variantId/metrics", () => {
    it("the officer appends one manual row: 201, the stored row, entered_by the caller, fetched_at the capture time, and one activity row", async () => {
      const m = await makePost(engMain, { title: "Typed in", variants: [{ on: "ig" }, { on: "fb" }] });
      const capturedAt = isoAgo(0.5);
      const r = await enter(U.officer, m.variants[0], { capturedAt, reach: 1200, impressions: 3400, likes: 80, comments: 6, shares: 4, saves: 9, videoViews: 0, clicks: 11 });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toEqual({
        id: expect.any(String), variantId: m.variants[0], postId: m.postId, source: "manual", capturedAt, reach: 1200, impressions: 3400,
        likes: 80, comments: 6, shares: 4, saves: 9, videoViews: 0, clicks: 11, enteredBy: U.officer,
      });
      const stored = await rows(m.variants[0]);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        id: (r.json() as { id: string }).id, tenant_id: A, source: "manual", entered_by: U.officer, reach: 1200, impressions: 3400, likes: 80,
        comments: 6, shares: 4, saves: 9, video_views: 0, clicks: 11,
      });
      expect((stored[0].fetched_at as Date).toISOString()).toBe(capturedAt);
      expect(await rows(m.variants[1])).toHaveLength(0); // the post's other variant is untouched
      const act = await adminPool().query(
        `SELECT actor_id::text AS actor, metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'social_post' AND target_entity_id = $2 AND verb = 'enter_metrics'`,
        [A, m.postId]);
      expect(act.rows).toHaveLength(1);
      expect(act.rows[0].actor).toBe(U.officer);
      expect(act.rows[0].metadata).toMatchObject({ engagementId: engMain.id, variantId: m.variants[0], capturedAt });
      expect(JSON.stringify(act.rows[0].metadata)).not.toContain("1200"); // no number in the audit trail
    });

    it("a counter not sent is NULL, never 0; reach alone is enough", async () => {
      const m = await makePost(engMain, { title: "Reach only", variants: [{ on: "ig" }] });
      const r = await enter(U.officer, m.variants[0], good({ reach: 0 }));
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ reach: 0, impressions: null, likes: null, comments: null, shares: null, saves: null, videoViews: null, clicks: null });
      expect((await rows(m.variants[0]))[0]).toMatchObject({ reach: 0, impressions: null, likes: null, comments: null, shares: null, saves: null, video_views: null, clicks: null });
    });

    it("a second entry appends a second row (append-only, no upsert), and the read takes the newest capture", async () => {
      const m = await makePost(engMain, { title: "Typed twice", variants: [{ on: "ig" }] });
      expect((await enter(U.officer, m.variants[0], good({ capturedAt: isoAgo(2), reach: 100, likes: 5 }))).statusCode).toBe(201);
      expect((await enter(U.officer, m.variants[0], good({ capturedAt: isoAgo(1), reach: 300, likes: 30 }))).statusCode).toBe(201);
      // Typed later but captured earlier: it is history, not the newest.
      expect((await enter(U.officer, m.variants[0], good({ capturedAt: isoAgo(3), reach: 9999, likes: 1 }))).statusCode).toBe(201);
      expect(await rows(m.variants[0])).toHaveLength(3);
      const a = await answer(m.postId);
      expect(a.latest).toMatchObject({ reach: 300, likes: 30, source: "manual" });
    });

    it("takes a capture time with an offset, and one a few minutes ahead (clock skew), and refuses one further ahead", async () => {
      const m = await makePost(engMain, { title: "Skew", variants: [{ on: "ig" }] });
      const withOffset = await enter(U.officer, m.variants[0], good({ capturedAt: "2026-03-05T15:00:00+07:00" }));
      expect(withOffset.statusCode, withOffset.body).toBe(201);
      expect((withOffset.json() as { capturedAt: string }).capturedAt).toBe("2026-03-05T08:00:00.000Z");
      const near = await enter(U.officer, m.variants[0], good({ capturedAt: new Date(Date.now() + 3 * 60_000).toISOString() }));
      expect(near.statusCode, near.body).toBe(201);
      const far = await enter(U.officer, m.variants[0], good({ capturedAt: new Date(Date.now() + 20 * 60_000).toISOString() }));
      expect(far.statusCode).toBe(400);
      expect(far.json()).toMatchObject({ error: "invalid_field", field: "capturedAt" });
    });

    it("another client's officer, a copywriter, a read-only member, a member with no social tier and another company's member are 403, even with a bad body", async () => {
      const m = await makePost(engMain, { title: "Not yours", variants: [{ on: "ig" }] });
      for (const who of ["otherOfficer", "copywriter", "staff", "noTier", "outsider"]) {
        const ok = await enter(U[who], m.variants[0], good());
        expect(ok.statusCode, `${who}: ${ok.body}`).toBe(403);
        expect((ok.json() as { error: string }).error, who).toMatch(/^not authorized/);
        const bad = await enter(U[who], m.variants[0], { reach: -1 });
        expect(bad.statusCode, `${who} with a bad body: ${bad.body}`).toBe(403);
      }
      expect(await rows(m.variants[0])).toHaveLength(0);
    });

    it("a refused caller is 403, not 409, on a post that is not live", async () => {
      const m = await makePost(engMain, { title: "Not live, not yours", status: "scheduled", variants: [{ on: "ig" }] });
      const r = await enter(U.copywriter, m.variants[0], good());
      expect(r.statusCode, r.body).toBe(403);
      const officer = await enter(U.officer, m.variants[0], good());
      expect(officer.statusCode).toBe(409);
    });

    it("every bad field is 400 with its field, and nothing is written", async () => {
      const m = await makePost(engMain, { title: "Bad bodies", variants: [{ on: "ig" }] });
      const cases: Array<[unknown, string, string]> = [
        [{ reach: 5 }, "capturedAt", "missing_field"],
        [{ capturedAt: null, reach: 5 }, "capturedAt", "missing_field"],
        [{ capturedAt: "yesterday", reach: 5 }, "capturedAt", "invalid_field"],
        [{ capturedAt: "2026-02-30T08:00:00Z", reach: 5 }, "capturedAt", "invalid_field"],
        [{ capturedAt: "2026-03-05T08:00:00", reach: 5 }, "capturedAt", "invalid_field"], // no zone
        [{ capturedAt: 1_772_000_000, reach: 5 }, "capturedAt", "invalid_field"],
        [{ capturedAt: new Date(Date.now() + DAY).toISOString(), reach: 5 }, "capturedAt", "invalid_field"],
        [{ capturedAt: isoAgo(1) }, "reach", "missing_field"],
        [{ capturedAt: isoAgo(1), reach: null }, "reach", "missing_field"],
        [{ capturedAt: isoAgo(1), reach: -1 }, "reach", "invalid_field"],
        [{ capturedAt: isoAgo(1), reach: 1.5 }, "reach", "invalid_field"],
        [{ capturedAt: isoAgo(1), reach: "100" }, "reach", "invalid_field"],
        [{ capturedAt: isoAgo(1), reach: 2_147_483_648 }, "reach", "invalid_field"],
      ];
      for (const k of ["impressions", "likes", "comments", "shares", "saves", "videoViews", "clicks"]) {
        cases.push([good({ [k]: -1 }), k, "invalid_field"], [good({ [k]: 2.5 }), k, "invalid_field"], [good({ [k]: "3" }), k, "invalid_field"]);
      }
      for (const [body, field, error] of cases) {
        const r = await enter(U.officer, m.variants[0], body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
        expect(r.json(), JSON.stringify(body)).toMatchObject({ error, field });
      }
      const empty = await app.inject({ method: "POST", url: route(A, `variants/${m.variants[0]}/metrics`), headers: asUser(U.officer) });
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toMatchObject({ field: "capturedAt" });
      expect(await rows(m.variants[0])).toHaveLength(0);
    });

    it("409 post_not_live unless the post is live; 409 not_a_pipeline_post for a Composer post; nothing is written", async () => {
      for (const status of ["planned", "drafting", "client", "approved", "scheduled"]) {
        const m = await makePost(engMain, { title: `Not live ${status}`, status, variants: [{ on: "ig" }] });
        const r = await enter(U.officer, m.variants[0], good());
        expect(r.statusCode, `${status}: ${r.body}`).toBe(409);
        expect(r.json(), status).toMatchObject({ error: "post_not_live" });
        expect(await rows(m.variants[0])).toHaveLength(0);
      }
      const composer = await makePost(engMain, { title: "Composer post", composer: true, variants: [{ on: "ig" }] });
      const r = await enter(U.officer, composer.variants[0], good());
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "not_a_pipeline_post" });
    });

    it("an unknown, deleted or another company's variant (and a non-uuid) is 404 post_not_found", async () => {
      const gone = await makePost(engMain, { title: "Variant gone", variants: [{ on: "ig" }] });
      await adminPool().query(`UPDATE social_post_variants SET deleted_at = now() WHERE id = $1`, [gone.variants[0]]);
      const postGone = await makePost(engMain, { title: "Post gone", deleted: true, variants: [{ on: "ig" }] });
      const foreign = await makePost(engC, { title: "Another company's post", variants: [{ on: "ig" }] }, C);
      for (const id of [newId(), "not-a-uuid", gone.variants[0], postGone.variants[0], foreign.variants[0]]) {
        const r = await enter(U.officer, id, good());
        expect(r.statusCode, id).toBe(404);
        expect(r.json(), id).toMatchObject({ error: "post_not_found" });
      }
      expect(await rows(foreign.variants[0])).toHaveLength(0);
      // The other company's own officer-side member cannot reach it through the agency's route either.
      const viaA = await enter(U.outsider, foreign.variants[0], good());
      expect([403, 404]).toContain(viaA.statusCode);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // GET posts/:postId/metrics
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("GET posts/:postId/metrics", () => {
    it("sums each variant's snapshot, keeps a counter nobody reported null, and takes the engagement rate over the variants with a reach", async () => {
      const e = await fresh("Rate Sum");
      await rated(e, "Peer four", 1000, 40, 10);
      await rated(e, "Peer two", 500, 10, 30);
      const p = await makePost(e, {
        title: "Under test",
        variants: [
          { on: "ig", snaps: [{ reach: 600, likes: 30, comments: 5, saves: 3, shares: 2, impressions: 900, source: "manual", daysAgo: 1 }] },
          { on: "fb", snaps: [{ reach: 400, likes: 10, source: "manual", daysAgo: 2 }] },
        ],
      });
      const a = await answer(p.postId);
      expect(a.latest).toEqual({
        reach: 1000, impressions: 900, likes: 40, comments: 5, shares: 2, saves: 3, clicks: null, videoViews: null, source: "manual", capturedAt: expect.any(String),
      });
      expect(isAbout(a.latest!.capturedAt, 1)).toBe(true); // the newer of the two variants' captures
      expect(a.engagementRate).toBeCloseTo(0.05, 6); // (40 + 5 + 3 + 2) / 1000
      expect(a.accountAverageRate).toBeCloseTo(0.03, 6); // the mean of 4% and 2%: the post itself is not in its own average
      expect(a.boostCandidate).toBe(true); // 5% >= 1.25 x 3% = 3.75%
      expect(a.simulated).toBe(false);
    });

    it("takes each variant's NEWEST snapshot by capture time, not the last row written", async () => {
      const e = await fresh("Rate Newest");
      const p = await makePost(e, {
        title: "Three snapshots",
        variants: [{ on: "ig", snaps: [{ reach: 200, likes: 20, daysAgo: 1 }, { reach: 100, likes: 1, daysAgo: 3 }, { reach: 9999, likes: 9999, daysAgo: 6 }] }],
      });
      const a = await answer(p.postId);
      expect(a.latest).toMatchObject({ reach: 200, likes: 20, source: "pull" });
      expect(isAbout(a.latest!.capturedAt, 1)).toBe(true);
      expect(a.engagementRate).toBeCloseTo(0.1, 6);
    });

    it("a pulled variant with likes and no reach adds to the numbers shown but never lifts the rate", async () => {
      const e = await fresh("Rate No Reach");
      const p = await makePost(e, {
        title: "Mixed variants",
        variants: [{ on: "ig", snaps: [{ reach: 500, likes: 25, source: "manual" }] }, { on: "fb", snaps: [{ likes: 900, source: "pull" }] }],
      });
      const a = await answer(p.postId);
      expect(a.latest).toMatchObject({ reach: 500, likes: 925, source: "manual" });
      expect(a.engagementRate).toBeCloseTo(0.05, 6);
    });

    it("the source is simulated if any variant's is, else manual, else pull; the post's own flag also marks it simulated", async () => {
      const e = await fresh("Sources");
      const pulled = await makePost(e, { title: "Pulled", variants: [{ on: "ig", snaps: [{ reach: 10, likes: 1 }] }, { on: "fb", snaps: [{ reach: 10, likes: 1 }] }] });
      expect(await answer(pulled.postId)).toMatchObject({ latest: { source: "pull" }, simulated: false });
      const mixed = await makePost(e, { title: "Manual and pulled", variants: [{ on: "ig", snaps: [{ reach: 10, source: "manual" }] }, { on: "fb", snaps: [{ reach: 10 }] }] });
      expect(await answer(mixed.postId)).toMatchObject({ latest: { source: "manual" }, simulated: false });
      const sim = await makePost(e, { title: "Simulated", variants: [{ on: "ig", snaps: [{ reach: 10, source: "simulated" }] }, { on: "fb", snaps: [{ reach: 10, source: "manual" }] }] });
      expect(await answer(sim.postId)).toMatchObject({ latest: { source: "simulated" }, simulated: true });
      const flagged = await makePost(e, { title: "Simulated post", simulated: true, variants: [{ on: "ig", snaps: [{ reach: 10, source: "manual" }] }] });
      expect(await answer(flagged.postId)).toMatchObject({ latest: { source: "manual" }, simulated: true });
    });

    it("the account average counts the client's other live posts of the last 90 days that have a rate, and nothing else", async () => {
      const e = await fresh("Window");
      const other = await fresh("Window Other Client");
      await rated(e, "Peer 4% (10 days)", 1000, 40, 10);
      await rated(e, "Peer 2% (89 days)", 1000, 20, 89);
      // Every one of these would drag the average far above 3% if it were counted.
      await rated(e, "Too old (91 days)", 1000, 900, 91);
      await rated(e, "Archived", 1000, 900, 5, { archived: true });
      await rated(e, "Deleted", 1000, 900, 5, { deleted: true });
      await rated(e, "Not live", 1000, 900, 5, { status: "scheduled" });
      await rated(e, "Composer", 1000, 900, 5, { composer: true });
      await rated(other, "Another client's post", 1000, 900, 5);
      // Counted as no rate at all: a live post with no snapshot, and one with no reach.
      await makePost(e, { title: "No snapshot", variants: [{ on: "ig" }] });
      await makePost(e, { title: "No reach", variants: [{ on: "ig", snaps: [{ likes: 500 }] }] });
      const p = await rated(e, "Under test", 1000, 50);
      const a = await answer(p.postId);
      expect(a.accountAverageRate).toBeCloseTo(0.03, 6);
      expect(a.engagementRate).toBeCloseTo(0.05, 6);
      expect(a.boostCandidate).toBe(true);
    });

    it("the exact bar is a candidate and one hair under is not (factor 1.25 over a 4% average: 5%)", async () => {
      const exact = await fresh("Bar Exact");
      await rated(exact, "Peer", 1000, 40, 10);
      const at = await rated(exact, "At the bar", 1000, 50);
      expect(await answer(at.postId)).toMatchObject({ boostCandidate: true });
      const under = await fresh("Bar Under");
      await rated(under, "Peer", 1000, 40, 10);
      const below = await rated(under, "Under the bar", 1000, 49);
      const a = await answer(below.postId);
      expect(a.boostCandidate).toBe(false);
      expect(a.engagementRate).toBeCloseTo(0.049, 6);
    });

    it("the factor is the company's social_settings value", async () => {
      const e = await fresh("Factor");
      await rated(e, "Peer", 1000, 40, 10);
      const p = await rated(e, "Five percent", 1000, 50);
      try {
        expect((await answer(p.postId)).boostCandidate).toBe(true); // no settings row: 1.25, the bar is 5%
        await setFactor(1.5); // the bar is 6%
        expect((await answer(p.postId)).boostCandidate).toBe(false);
        await setFactor(1.0); // the bar is 4%
        expect((await answer(p.postId)).boostCandidate).toBe(true);
        await setFactor(10); // the bar is 40%
        expect((await answer(p.postId)).boostCandidate).toBe(false);
      } finally {
        await setFactor(null);
      }
    });

    it("the null cases: no snapshot, no reach, no peer with a rate: the numbers are null and the post is not a candidate", async () => {
      const e = await fresh("Nulls");
      const none = await makePost(e, { title: "No snapshot", variants: [{ on: "ig" }] });
      expect(await answer(none.postId)).toEqual({ latest: null, engagementRate: null, accountAverageRate: null, boostCandidate: false, simulated: false });

      const noReach = await makePost(e, { title: "Pulled, no reach", variants: [{ on: "ig", snaps: [{ likes: 10 }] }] });
      expect(await answer(noReach.postId)).toMatchObject({
        latest: { reach: null, likes: 10, source: "pull" }, engagementRate: null, accountAverageRate: null, boostCandidate: false,
      });

      // A rate but no peer to compare with: the average is null and so is the candidate.
      const alone = await fresh("Nulls Alone");
      const solo = await rated(alone, "Only post", 1000, 500);
      expect(await answer(solo.postId)).toMatchObject({ accountAverageRate: null, boostCandidate: false });
      expect((await answer(solo.postId)).engagementRate).toBeCloseTo(0.5, 6);

      // Peers with no rate (no reach, no snapshot) give no average either.
      const peers = await fresh("Nulls Peers");
      await makePost(peers, { title: "Peer no reach", variants: [{ on: "ig", snaps: [{ likes: 99 }] }] });
      await makePost(peers, { title: "Peer no snapshot", variants: [{ on: "ig" }] });
      const p = await rated(peers, "Has a rate", 1000, 500);
      expect(await answer(p.postId)).toMatchObject({ accountAverageRate: null, boostCandidate: false });

      // A zero reach is no rate, and a rate of 0 over a real reach is 0 (not null).
      const zeroReach = await makePost(alone, { title: "Zero reach", variants: [{ on: "ig", snaps: [{ reach: 0, likes: 4 }] }] });
      expect((await answer(zeroReach.postId)).engagementRate).toBeNull();
      const flat = await rated(alone, "Flat", 800, 0);
      expect((await answer(flat.postId)).engagementRate).toBe(0);
    });

    it("who may read: the read tier, the copywriter and the officer; not a member with no tier or another company's member", async () => {
      const p = await rated(engMain, "Readable", 1000, 40);
      for (const who of ["staff", "copywriter", "officer", "otherOfficer"]) {
        const r = await read(U[who], p.postId);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
      }
      for (const who of ["noTier", "outsider"]) {
        const r = await read(U[who], p.postId);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(403);
      }
    });

    it("404 post_not_found for an unknown, deleted or another company's post; 409 not_a_pipeline_post for a Composer post", async () => {
      const deleted = await rated(engMain, "Deleted", 100, 1, 5, { deleted: true });
      const foreignPost = await makePost(engC, { title: "Another company's post", variants: [{ on: "ig", snaps: [{ reach: 100, likes: 1 }] }] }, C);
      for (const id of [newId(), "nope", deleted.postId, foreignPost.postId]) {
        const r = await read(U.staff, id);
        expect(r.statusCode, id).toBe(404);
        expect(r.json(), id).toMatchObject({ error: "post_not_found" });
      }
      const composer = await makePost(engMain, { title: "Composer", composer: true, variants: [{ on: "ig" }] });
      const r = await read(U.staff, composer.postId);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ error: "not_a_pipeline_post" });
    });

    it("another company's numbers never leak: its own member reads them on its own route, and the agency's member cannot read them through the agency's", async () => {
      const mine = await makePost(engC, { title: "Other company post", variants: [{ on: "ig", snaps: [{ reach: 100, likes: 7 }] }] }, C);
      const own = await read(U.outsider, mine.postId, C);
      expect(own.statusCode, own.body).toBe(200);
      expect((own.json() as Answer).latest).toMatchObject({ reach: 100, likes: 7 });
      const viaA = await read(U.staff, mine.postId, A);
      expect(viaA.statusCode).toBe(404);
    });

    it("a typed-in entry reaches the read: the officer enters, the read tier sees it as manual with the rate", async () => {
      const e = await fresh("Round trip");
      await rated(e, "Peer", 1000, 40, 10);
      const p = await makePost(e, { title: "Round trip post", variants: [{ on: "ig" }] });
      const r = await enter(U.officer, p.variants[0], good({ reach: 2000, likes: 100, comments: 10, shares: 5, saves: 5 }));
      expect(r.statusCode, r.body).toBe(201);
      const a = await answer(p.postId);
      expect(a).toMatchObject({ latest: { reach: 2000, likes: 100, source: "manual" }, boostCandidate: true, simulated: false });
      expect(a.engagementRate).toBeCloseTo(0.06, 6); // 120 / 2000, over the peer's 4%: 1.5 x
    });
  });
});
