// SCP-3c — a post's metrics: typed in or pulled, the engagement rate and the boost candidate (BFF §63.10 "Metrics"; plan §4.2, §8 row 3c).
//
//   POST variants/:variantId/metrics    social_post · schedule   the officer types a snapshot in: appends one `manual` row
//   GET  posts/:postId/metrics          social_post · read       the post's numbers, its rate, the client's average, the boost mark
//
// WHO. Both routes ask Cerbos on the post's REAL resource, built from the rows exactly as every pipeline route builds it (`loadSocialPostAuthz`
// and `socialPostResource`, pipeline-authz.ts; BFF §63.3.3): never a value from the body. `schedule` is the client's officer's own rule (the
// engagement's `owner_id` is the caller), so another client's officer, a copywriter and a designer are refused 403; `platform_admin` has it
// through the wildcard. `read` is the social read tier. A variant or post that is absent, deleted or another company's is 404 `post_not_found`
// BEFORE the decision (there is no post to build the resource from), the same order `GET posts/:postId/pipeline` keeps.
//
// AUTHORIZATION BEFORE VALIDATION (BFF §63.0): the decision comes first, so a refused caller always gets 403, never 400 or 409.
//
// POST. The body is `{capturedAt, reach, impressions?, likes?, comments?, shares?, saves?, videoViews?, clicks?}` (post-metrics.ts: whole numbers
// from 0, `reach` required, `capturedAt` a real date-time with a zone, not more than five minutes ahead). After the decision:
//   - 409 `not_a_pipeline_post` for a Composer post (BFF §63.0);
//   - 400 `{field}` per bad field (`missing_field` for an absent `capturedAt` or `reach`, `invalid_field` otherwise);
//   - 409 `post_not_live` unless the post's `pipeline_status` is `live`, judged inside the insert's transaction with the post row share-locked,
//     so a post cannot leave `live` between the check and the row.
//   It appends ONE row (never an upsert: `social_post_metrics` is append-only snapshots) with `source = 'manual'`, `entered_by` the caller and
//   `fetched_at` the `capturedAt` typed, then answers 201 with the stored row. After the commit it writes ONE activity row (`writeActivity`, entity
//   `social_post`, verb `enter_metrics`, metadata `{engagementId, variantId, capturedAt}`; never a number). That verb has no `work_activity` bridge
//   entry on purpose: the bridge's social kind counts posts SCHEDULED OR SENT, and typing numbers in is neither.
//
// GET. `{latest, engagementRate, accountAverageRate, boostCandidate, simulated}` (post-metrics.ts has every rule):
//   - `latest` sums each variant's NEWEST snapshot (by `fetched_at`); null when no variant has one. A counter nobody reported is null, never 0.
//   - `engagementRate` is the post's rate, null without a reach; `accountAverageRate` is the mean rate of the same client's (engagement's) OTHER
//     live pipeline posts that went live in the last 90 days and have a rate, null when there are none;
//   - `boostCandidate` is the rate at least `social_settings.boost_candidate_factor` (1.25 with no settings row) times that average;
//   - `simulated` is the post's own flag, or a simulated latest source (BFF §63.0: a simulated row says so in every answer).
//   A post that is not live yet answers whatever snapshots it has (none, in practice): the numbers are the data's, not a status rule.
//
// THE MODULE WALL. Every query declares `{ modules: ["social"] }` (and `loadSocialPostAuthz` declares the scope itself): `social_post_metrics`,
// `social_posts`, `social_post_variants` and `social_settings` all carry 0105's / 202610271000's third wall.
import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../../../db";
import { authorize, writeActivity } from "../../../core/http";
import { AuthGuard } from "../../../auth/guards";
import { ModuleEnabledGuard } from "../../module-enabled.guard";
import { loadSocialPostAuthz, socialPostResource } from "../pipeline-authz";
import { ScpRouteError } from "./pipeline-effects";
import {
  AVERAGE_WINDOW_DAYS, DEFAULT_BOOST_FACTOR, combineSnapshots, isBoostCandidate, meanRate, parseMetricsBody, postRate, round6,
  type MetricSource, type Snapshot,
} from "./post-metrics";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOCIAL = { modules: ["social"] };
const DAY_MS = 86_400_000;

/** The stored row `POST variants/:variantId/metrics` answers with (BFF §63.10): every counter as typed, null where not reported. */
export interface StoredMetrics {
  id: string;
  variantId: string;
  postId: string;
  source: "manual";
  capturedAt: string;
  reach: number;
  impressions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  videoViews: number | null;
  clicks: number | null;
  enteredBy: string;
}

/** `GET posts/:postId/metrics` (BFF §63.10). `rate` and `average` are ratios (0.042 is 4.2%), to six decimals. */
export interface PostMetricsAnswer {
  latest: {
    reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
    clicks: number | null; videoViews: number | null; source: MetricSource; capturedAt: string;
  } | null;
  engagementRate: number | null;
  accountAverageRate: number | null;
  boostCandidate: boolean;
  simulated: boolean;
}

interface SnapshotRow {
  post_id: string; reach: number | null; impressions: number | null; likes: number | null; comments: number | null; shares: number | null;
  saves: number | null; video_views: number | null; clicks: number | null; source: MetricSource; fetched_at: Date | string;
}

const toSnapshot = (r: SnapshotRow): Snapshot => ({
  reach: r.reach, impressions: r.impressions, likes: r.likes, comments: r.comments, shares: r.shares, saves: r.saves,
  videoViews: r.video_views, clicks: r.clicks, source: r.source, capturedAt: new Date(r.fetched_at),
});

@Controller("api/:tenantId/modules/social")
@UseGuards(AuthGuard, ModuleEnabledGuard("social"))
export class SocialMetricsController {
  // ── POST variants/:variantId/metrics ──────────────────────────────────────────────────────────────────────────────
  @Post("variants/:variantId/metrics")
  @HttpCode(201)
  async enter(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("variantId") variantId: string, @Body() body: unknown,
  ): Promise<StoredMetrics> {
    if (!UUID_RE.test(variantId)) throw new ScpRouteError(404, "post_not_found");
    const found = await withTenants([tenantId], async (c) => {
      const { rows } = await c.query<{ post_id: string }>(
        `SELECT v.post_id::text AS post_id FROM social_post_variants v WHERE v.tenant_id = $1 AND v.id = $2 AND v.deleted_at IS NULL`,
        [tenantId, variantId],
      );
      const postId = rows[0]?.post_id;
      return postId ? { postId, authz: await loadSocialPostAuthz(c, tenantId, postId) } : null;
    }, SOCIAL);
    if (!found?.authz) throw new ScpRouteError(404, "post_not_found");

    // The decision first: `schedule` on the post's real resource (the client's officer; BFF §63.3.3).
    await authorize(req.principal, socialPostResource(tenantId, found.authz), "schedule");
    const callerId = req.principal.userId;
    if (!callerId) throw new ForbiddenException("not authorized: a person is required to enter metrics");

    if (found.authz.pipelineStatus === null) throw new ScpRouteError(409, "not_a_pipeline_post");
    const m = parseMetricsBody(body, new Date());

    const stored = await withTenants([tenantId], async (c) => {
      // Share-locked: the post cannot be discarded or moved on while the row is written. `live` is judged HERE, on the locked row.
      const post = await c.query<{ pipeline_status: string | null }>(
        `SELECT pipeline_status FROM social_posts WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR SHARE`,
        [tenantId, found.postId],
      );
      if (!post.rows[0]) throw new ScpRouteError(404, "post_not_found");
      if (post.rows[0].pipeline_status !== "live") throw new ScpRouteError(409, "post_not_live");
      const { rows } = await c.query<{ id: string; fetched_at: Date | string }>(
        `INSERT INTO social_post_metrics
           (tenant_id, variant_id, impressions, likes, comments, shares, saves, video_views, clicks, reach, source, entered_by, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual', $11, $12)
         RETURNING id::text AS id, fetched_at`,
        [tenantId, variantId, m.impressions, m.likes, m.comments, m.shares, m.saves, m.videoViews, m.clicks, m.reach, callerId, m.capturedAt],
      );
      return rows[0];
    }, SOCIAL);

    await writeActivity(tenantId, callerId, "enter_metrics", "social_post", found.postId, {
      engagementId: found.authz.engagementId, variantId, capturedAt: m.capturedAt.toISOString(),
    });
    return {
      id: stored.id, variantId, postId: found.postId, source: "manual", capturedAt: new Date(stored.fetched_at).toISOString(),
      reach: m.reach, impressions: m.impressions, likes: m.likes, comments: m.comments, shares: m.shares, saves: m.saves,
      videoViews: m.videoViews, clicks: m.clicks, enteredBy: callerId,
    };
  }

  // ── GET posts/:postId/metrics ─────────────────────────────────────────────────────────────────────────────────────
  @Get("posts/:postId/metrics")
  async read(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string): Promise<PostMetricsAnswer> {
    if (!UUID_RE.test(postId)) throw new ScpRouteError(404, "post_not_found");
    const authz = await withTenants([tenantId], (c) => loadSocialPostAuthz(c, tenantId, postId), SOCIAL);
    if (!authz) throw new ScpRouteError(404, "post_not_found");

    await authorize(req.principal, socialPostResource(tenantId, authz), "read");
    if (authz.pipelineStatus === null) throw new ScpRouteError(409, "not_a_pipeline_post");

    const windowStart = new Date(Date.now() - AVERAGE_WINDOW_DAYS * DAY_MS);
    const data = await withTenants([tenantId], async (c) => {
      const post = await c.query<{ simulated: boolean }>(`SELECT simulated FROM social_posts WHERE tenant_id = $1 AND id = $2`, [tenantId, postId]);
      const settings = await c.query<{ factor: string }>(`SELECT boost_candidate_factor::text AS factor FROM social_settings WHERE tenant_id = $1`, [tenantId]);
      // Each variant's NEWEST snapshot, for this post and for the client's other live posts of the last 90 days: one read.
      const { rows } = await c.query<SnapshotRow>(
        `SELECT p.id::text AS post_id, m.reach, m.impressions, m.likes, m.comments, m.shares, m.saves, m.video_views, m.clicks, m.source, m.fetched_at
           FROM social_posts p
           JOIN social_post_variants v ON v.tenant_id = p.tenant_id AND v.post_id = p.id AND v.deleted_at IS NULL
           JOIN LATERAL (
             SELECT x.reach, x.impressions, x.likes, x.comments, x.shares, x.saves, x.video_views, x.clicks, x.source, x.fetched_at
               FROM social_post_metrics x
              WHERE x.tenant_id = v.tenant_id AND x.variant_id = v.id
              ORDER BY x.fetched_at DESC, x.created_at DESC, x.id DESC LIMIT 1
           ) m ON true
          WHERE p.tenant_id = $1 AND p.deleted_at IS NULL
            AND (p.id = $2
                 OR (p.engagement_id = $3 AND p.pipeline_status = 'live' AND p.archived_at IS NULL AND p.went_live_at >= $4::timestamptz))`,
        [tenantId, postId, authz.engagementId, windowStart],
      );
      return { simulated: post.rows[0]?.simulated === true, factor: settings.rows[0] ? Number(settings.rows[0].factor) : DEFAULT_BOOST_FACTOR, rows };
    }, SOCIAL);

    const byPost = new Map<string, Snapshot[]>();
    for (const r of data.rows) byPost.set(r.post_id, [...(byPost.get(r.post_id) ?? []), toSnapshot(r)]);
    const mine = byPost.get(postId) ?? [];
    byPost.delete(postId);

    const latest = combineSnapshots(mine);
    const rate = postRate(mine);
    const average = meanRate([...byPost.values()].map((s) => postRate(s)));
    return {
      latest: latest && {
        reach: latest.reach, impressions: latest.impressions, likes: latest.likes, comments: latest.comments, shares: latest.shares, saves: latest.saves,
        clicks: latest.clicks, videoViews: latest.videoViews, source: latest.source, capturedAt: latest.capturedAt.toISOString(),
      },
      engagementRate: round6(rate),
      accountAverageRate: round6(average),
      boostCandidate: isBoostCandidate(rate, average, data.factor),
      simulated: data.simulated || latest?.source === "simulated",
    };
  }
}
