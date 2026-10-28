// SCP-3f — the data side of `GET overview` (BFF §63.7). One caller-owned `withTenants([tenantId], fn, { modules: ["social", "hr"] })` client,
// the same transaction the feed uses, and THREE statements however many posts there are (the feed's bar, fast at ~600 posts):
//   Q1  `readFeedContext`    the calendar and the client-slowness samples `late` needs (feed-data.ts, unchanged).
//   Q2  `readFeedCandidates` the pipeline posts, unnarrowed (`view: "all"`): the phase and the health are pure JS over them.
//   Q3  `readOverviewFacts`  below: the numbers only SQL can see (failed posts, this week's scheduled posts, boosts waiting) and, while simulated rows are
//                            left out, which pipeline posts are simulated through their variants.
// Every statement starts with `OVERVIEW_TAG`; the feed's two start with `FEED_TAG`.
import type { PoolClient } from "pg";
import { declareSocialModuleScope } from "../module-scope";

export const OVERVIEW_TAG = "/* scp-overview */";

/** A post is simulated when it says so or when any of its live variants was served by the simulator (`social_posts.simulated` is derived on the way
 *  live only, so a scheduled post whose publisher dispatch failed has the mark on its variants alone). */
const SIMULATED_SQL = `(p.simulated OR EXISTS (SELECT 1 FROM social_post_variants v WHERE v.tenant_id = p.tenant_id AND v.post_id = p.id AND v.deleted_at IS NULL AND v.simulated))`;

export interface OverviewFacts {
  /** Pipeline posts with engine status `failed` or `partially_published`, plus Composer posts with status `failed`. One count, no post twice. */
  failedPosts: number;
  /** Boosts requested, plus approved and not yet started (BFF §63.7), on undeleted, unarchived posts. */
  boostsWaiting: number;
  /** Pipeline posts in `scheduled` whose time falls in the week. */
  scheduledThisWeek: number;
  /** Pipeline post ids that are simulated through a variant; empty while simulated rows are counted (nothing is left out then). */
  simulatedIds: Set<string>;
}

/**
 * `week` is the company's Monday to Sunday as local dates (`from` inclusive, `to` exclusive); `tz` the zone they are read in.
 * `includeSimulated` is the simulator switch: off leaves every simulated row out of both counts and names the simulated pipeline posts.
 */
export async function readOverviewFacts(
  c: PoolClient, tenantId: string, a: { tz: string; week: { from: string; to: string }; includeSimulated: boolean },
): Promise<OverviewFacts> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{ failed: string; scheduled: string; boosts_waiting: string; simulated_ids: string[] | null }>(
    `${OVERVIEW_TAG}
    WITH live AS (
      SELECT p.id, p.status, p.pipeline_status, p.scheduled_at, ${SIMULATED_SQL} AS is_simulated
        FROM social_posts p
        JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id AND e.deleted_at IS NULL
       WHERE p.tenant_id = $1::uuid AND p.deleted_at IS NULL AND p.archived_at IS NULL
    )
    SELECT
      count(*) FILTER (WHERE ($2::boolean OR NOT is_simulated)
                         AND (status = 'failed' OR (pipeline_status IS NOT NULL AND status = 'partially_published'))) AS failed,
      count(*) FILTER (WHERE ($2::boolean OR NOT is_simulated) AND pipeline_status = 'scheduled' AND scheduled_at IS NOT NULL
                         AND (scheduled_at AT TIME ZONE $3)::date >= $4::date AND (scheduled_at AT TIME ZONE $3)::date < $5::date) AS scheduled,
      -- SCP-4d: a scalar subquery, so the route stays three statements. A boost waits while requested, or approved and not yet started.
      (SELECT count(*) FROM social_boosts b
         JOIN social_posts bp ON bp.id = b.post_id AND bp.tenant_id = b.tenant_id AND bp.deleted_at IS NULL AND bp.archived_at IS NULL
        WHERE b.tenant_id = $1::uuid AND ($2::boolean OR NOT b.simulated)
          AND (b.status = 'requested' OR (b.status = 'approved' AND b.started_at IS NULL))) AS boosts_waiting,
      CASE WHEN $2::boolean THEN '[]'::json
           ELSE coalesce(json_agg(id::text) FILTER (WHERE pipeline_status IS NOT NULL AND is_simulated), '[]'::json) END AS simulated_ids
      FROM live`,
    [tenantId, a.includeSimulated, a.tz, a.week.from, a.week.to],
  );
  const r = rows[0];
  return { failedPosts: Number(r?.failed ?? 0), scheduledThisWeek: Number(r?.scheduled ?? 0), boostsWaiting: Number(r?.boosts_waiting ?? 0), simulatedIds: new Set(r?.simulated_ids ?? []) };
}
