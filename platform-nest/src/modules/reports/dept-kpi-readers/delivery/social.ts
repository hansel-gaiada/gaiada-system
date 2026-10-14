// DW-6n n7, n8, n9 (docs/FRONTEND-BFF-CONTRACT.md §40.5.3): the social-media department's readers. Each reads through
// withTenants with the `social` wall declared, so a tenant without the module finds no rows and gets null, never an error.
// Scope is the department's clients C(u) (§40.5.2).
import type { PoolClient } from "pg";
import { config } from "../../../../config";
import { withTenants } from "../../../../db";
import type { KpiValue } from "../../dept-kpis";
import type { ModuleKpiReader, ReaderCtx } from "../types";
import { deptClientIdsSql, localDateSql, windowEndSql, windowStartSql } from "../scope";

const social = <T>(ctx: ReaderCtx, fn: (c: PoolClient) => Promise<T>) => withTenants([ctx.tenantId], fn, { modules: ["social"] });

// n7 `social.posts_on_schedule`. $1 tenant, $2 unit, $3 start, $4 end, $5 zone, $6 asOf.
// The slot is the variant's own scheduled_at, else the post's plan-level slot (social_posts.scheduled_at). A variant with
// neither is not on any schedule and is left out. "Already due" is the slot's local date on or before asOf. The 15
// minutes is a documented default, not a ruling.
const SLOT = `COALESCE(v.scheduled_at, p.scheduled_at)`;
const ON_SCHEDULE_SQL = `
  SELECT count(*)::text AS denominator,
         (count(*) FILTER (WHERE v.published_at IS NOT NULL
                             AND v.published_at <= ${SLOT} + interval '15 minutes'))::text AS numerator
    FROM social_post_variants v
    JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
    JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
   WHERE v.tenant_id = $1::uuid
     AND v.deleted_at IS NULL AND p.deleted_at IS NULL
     AND NOT v.native_import
     AND v.status <> 'cancelled'
     AND ${SLOT} >= ${windowStartSql(3, 5)}
     AND ${SLOT} <  ${windowEndSql(4, 5)}
     AND e.client_id IN ${deptClientIdsSql(1, 2)}
     AND (v.published_at IS NOT NULL OR ${localDateSql(SLOT, 5)} <= $6::date)`;

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
// value in BOTH windows. cur covers the inclusive dates [start, end]; prev the same number of days just before start.
// Numerator and denominator are left out: this is a growth rate, not a share.
// $1 tenant, $2 unit, $3 start, $4 end.
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
  const row = await social(
    ctx,
    async (c) =>
      (await c.query<{ cur: string | null; prev: string | null; accounts: string }>(GROWTH_SQL, [ctx.tenantId, ctx.unitId, ctx.start, ctx.end]))
        .rows[0],
  );
  if (!row || Number(row.accounts) === 0 || row.cur === null || row.prev === null) return null;
  const prev = Number(row.prev);
  if (prev === 0) return null;
  return { value: (Number(row.cur) - prev) / prev };
};
