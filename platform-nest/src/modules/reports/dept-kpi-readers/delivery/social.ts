// DW-6n n7, n8, n9 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3): the social-media department's readers. Each reads through
// withTenants with the `social` wall declared, so a tenant without the module finds no rows and gets null, never an error.
// Scope is the department's clients C(u) (§40.5.2).
import type { PoolClient } from "pg";
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import { isSocialSimulationEnabled } from "../../../social/publisher/simulation";
import type { KpiValue } from "../../dept-kpis";
import type { ModuleKpiReader, ReaderCtx } from "../types";
import { deptClientIdsSql, localDateSql, windowEndSql, windowStartSql } from "../scope";

const social = <T>(ctx: ReaderCtx, fn: (c: PoolClient) => Promise<T>) => withTenants([ctx.tenantId], fn, { modules: ["social"] });

// n7 `social.posts_on_schedule`. $1 tenant, $2 unit, $3 start, $4 end, $5 zone, $6 asOf, $7 simulator switch.
// Two kinds of unit, one ratio. "Already due" is the slot's local date on or before asOf. The 15 minutes is a documented default,
// not a ruling. A unit with no slot is not on any schedule and is left out.
//   * A COMPOSER variant (the post has no `pipeline_status`): as before. The slot is the variant's own scheduled_at, else the post's
//     plan-level slot (social_posts.scheduled_at); a native import is left out, because a Composer import records a post made elsewhere.
//   * A PIPELINE post (SCP-3f, BFF §63.10): the post itself, hand-posted ones included. `mark_live` writes each variant as a
//     native-import row, so the variants cannot be the unit; the post's own `went_live_at` (the officer's `at`, or the publisher's
//     last `published_at`) against its approved slot `scheduled_at` is. It counts once its variants exist (the post has reached the client);
//     a post archived before it went live is not a promise kept or broken, one archived after is still the record.
// SIMULATED rows (plan §5): counted only while the switch is on. A pipeline post is simulated by its own mark or by any live variant's
// (`social_posts.simulated` is written on the way live only), a Composer variant by its own.
const SLOT = `COALESCE(v.scheduled_at, p.scheduled_at)`;
const POST_SIMULATED = `(p.simulated OR EXISTS (SELECT 1 FROM social_post_variants sv WHERE sv.tenant_id = p.tenant_id AND sv.post_id = p.id AND sv.deleted_at IS NULL AND sv.simulated))`;
const ON_SCHEDULE_SQL = `
  WITH units AS (
    SELECT (v.published_at IS NOT NULL AND v.published_at <= ${SLOT} + interval '15 minutes') AS on_time
      FROM social_post_variants v
      JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
      JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
     WHERE v.tenant_id = $1::uuid
       AND v.deleted_at IS NULL AND p.deleted_at IS NULL
       AND p.pipeline_status IS NULL
       AND NOT v.native_import
       AND v.status <> 'cancelled'
       AND ($7::boolean OR NOT v.simulated)
       AND ${SLOT} >= ${windowStartSql(3, 5)}
       AND ${SLOT} <  ${windowEndSql(4, 5)}
       AND e.client_id IN ${deptClientIdsSql(1, 2)}
       AND (v.published_at IS NOT NULL OR ${localDateSql(SLOT, 5)} <= $6::date)
    UNION ALL
    SELECT (p.went_live_at IS NOT NULL AND p.went_live_at <= p.scheduled_at + interval '15 minutes') AS on_time
      FROM social_posts p
      JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
     WHERE p.tenant_id = $1::uuid
       AND p.deleted_at IS NULL
       AND p.pipeline_status IS NOT NULL
       AND (p.archived_at IS NULL OR p.went_live_at IS NOT NULL)
       AND EXISTS (SELECT 1 FROM social_post_variants v
                    WHERE v.tenant_id = p.tenant_id AND v.post_id = p.id AND v.deleted_at IS NULL AND v.status <> 'cancelled')
       AND ($7::boolean OR NOT ${POST_SIMULATED})
       AND p.scheduled_at >= ${windowStartSql(3, 5)}
       AND p.scheduled_at <  ${windowEndSql(4, 5)}
       AND e.client_id IN ${deptClientIdsSql(1, 2)}
       AND (p.went_live_at IS NOT NULL OR ${localDateSql("p.scheduled_at", 5)} <= $6::date)
  )
  SELECT count(*)::text AS denominator, (count(*) FILTER (WHERE on_time))::text AS numerator FROM units`;

export const postsOnSchedule: ModuleKpiReader = async (ctx): Promise<KpiValue | null> => {
  const row = await social(
    ctx,
    async (c) =>
      (
        await c.query<{ numerator: string; denominator: string }>(ON_SCHEDULE_SQL, [
          ctx.tenantId,
          ctx.unitId,
          ctx.start,
          ctx.end,
          config.reportsTz,
          ctx.asOf,
          isSocialSimulationEnabled(),
        ])
      ).rows[0],
  );
  const den = Number(row?.denominator ?? 0);
  if (den === 0) return null;
  const num = Number(row.numerator);
  return { value: num / den, numerator: num, denominator: den };
};

// n8 `social.client_approval_turnaround`: the mean of decided_at - requested_at, in minutes. No numerator/denominator.
// §40.5.4 limit: social_post_client_reviews keeps ONE row per variant (UNIQUE (variant_id)), so only the LATEST approval
// round is seen; a re-request overwrites the earlier one and a series over re-requests is understated.
// The table itself carries only the plain tenant wall (0105 comment), so the variant join is what applies the `social` wall.
// $1 tenant, $2 unit, $3 start, $4 end, $5 zone.
const TURNAROUND_SQL = `
  SELECT (avg(extract(epoch FROM (rv.decided_at - rv.requested_at)) / 60.0))::text AS minutes
    FROM social_post_client_reviews rv
    JOIN social_post_variants v ON v.id = rv.variant_id AND v.tenant_id = rv.tenant_id
   WHERE rv.tenant_id = $1::uuid
     AND rv.status IN ('approved','changes_requested')
     AND rv.decided_at >= ${windowStartSql(3, 5)}
     AND rv.decided_at <  ${windowEndSql(4, 5)}
     AND rv.client_id IN ${deptClientIdsSql(1, 2)}`;

export const clientApprovalTurnaround: ModuleKpiReader = async (ctx): Promise<KpiValue | null> => {
  const row = await social(
    ctx,
    async (c) =>
      (await c.query<{ minutes: string | null }>(TURNAROUND_SQL, [ctx.tenantId, ctx.unitId, ctx.start, ctx.end, config.reportsTz]))
        .rows[0],
  );
  if (!row || row.minutes === null) return null;
  return { value: Number(row.minutes) };
};

// n9 `social.engagement_growth`: (cur - prev) / prev, pooled over accounts with at least one non-null `engagements`
// value in BOTH windows. Measured to date, so a window still running is not read as a decline: with L = asOf - start + 1,
// cur covers the dates [start, asOf] and prev the L days just before start, [start - L, start - 1]. Rows after asOf never count.
// Numerator and denominator are left out: this is a growth rate, not a share.
// $1 tenant, $2 unit, $3 start, $4 asOf (the earlier of asOf and end).
const GROWTH_SQL = `
  WITH per AS (
    SELECT m.account_id,
           sum(m.engagements) FILTER (WHERE m.date >= $3::date) AS cur,
           count(m.engagements) FILTER (WHERE m.date >= $3::date) AS cur_n,
           sum(m.engagements) FILTER (WHERE m.date < $3::date) AS prev,
           count(m.engagements) FILTER (WHERE m.date < $3::date) AS prev_n
      FROM social_metrics_daily m
      JOIN social_accounts a ON a.id = m.account_id AND a.tenant_id = m.tenant_id
     WHERE m.tenant_id = $1::uuid
       AND a.deleted_at IS NULL
       AND a.client_id IN ${deptClientIdsSql(1, 2)}
       AND m.date >= $3::date - ($4::date - $3::date + 1)
       AND m.date <= $4::date
     GROUP BY m.account_id)
  SELECT sum(cur)::text AS cur, sum(prev)::text AS prev, count(*)::text AS accounts
    FROM per WHERE cur_n > 0 AND prev_n > 0`;

export const engagementGrowth: ModuleKpiReader = async (ctx): Promise<KpiValue | null> => {
  const upTo = ctx.asOf < ctx.end ? ctx.asOf : ctx.end;
  if (upTo < ctx.start) return null; // the window has not begun: nothing measured yet
  const row = await social(
    ctx,
    async (c) =>
      (await c.query<{ cur: string | null; prev: string | null; accounts: string }>(GROWTH_SQL, [ctx.tenantId, ctx.unitId, ctx.start, upTo]))
        .rows[0],
  );
  if (!row || Number(row.accounts) === 0 || row.cur === null || row.prev === null) return null;
  const prev = Number(row.prev);
  if (prev === 0) return null;
  return { value: (Number(row.cur) - prev) / prev };
};
