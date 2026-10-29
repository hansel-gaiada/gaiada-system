// SMM-23 / SCP-5a (docs/FRONTEND-BFF-CONTRACT.md §63.18) — the reads behind a report's frozen snapshot and behind the report items of
// Needs you (§63.7). Every function runs on the caller's `withTenants([tenantId], fn, { modules: ["social"] })` client and declares
// the module scope itself (`declareSocialModuleScope`), so a caller that forgot the option still reads the rows, never zero.
//
// ── WHAT THE SNAPSHOT COUNTS (SCP-5a) ────────────────────────────────────────────────────────────────────────────────────────
//   - the client's daily account rows (`social_metrics_daily`), pulled or simulated;
//   - the engagement's published variants in the period, each with its LATEST metric row, whatever its source (pulled, typed in
//     by hand, or simulated);
//   - the engagement's boosts that ran and started in the period: the CLIENT'S OWN ad spend (PV7-Q3: never our fees);
//   - the engagement's KPI targets.
// SIMULATED ROWS are counted exactly as `GET overview` counts them (overview-data.ts): only while the simulator switch is on
// (`includeSimulated`, the caller's `isSocialSimulationEnabled()`), so a report and the Social Pulse never disagree. With the switch
// off they are left out (a variant's latest metric row is then its latest REAL one). What is simulated:
//   - a daily row whose `source` is 'simulated', or whose account is simulated;
//   - a post marked simulated (`social_posts.simulated`, set only when the simulator published a variant) or a variant the
//     simulator published (`social_post_variants.simulated`), the overview's own rule;
//   - a metric row whose `source` is 'simulated';
//   - a boost marked simulated (the post's own mark, copied at request).
// `simulated` in the answer is true when ANY counted input was simulated: the report row keeps it and the page and PDF carry the
// SIMULATED watermark.
import type { PoolClient } from "pg";
import { declareSocialModuleScope } from "./module-scope";
import { minorUnitSql } from "./pipeline/boosts-data";
import type { BoostSpendInput, DailyMetricInput, KpiTargetInput, PostMetricInput } from "./reports";

export interface ReportInputs {
  daily: DailyMetricInput[];
  posts: PostMetricInput[];
  kpiTargets: KpiTargetInput[];
  boosts: BoostSpendInput[];
  /** Any counted input was simulated. Always false while `includeSimulated` is false. */
  simulated: boolean;
}

export async function readReportInputs(
  c: PoolClient,
  a: { tenantId: string; engagementId: string; clientId: string; start: string; end: string; includeSimulated: boolean },
): Promise<ReportInputs> {
  await declareSocialModuleScope(c);
  let simulated = false;

  const dailyRes = await c.query<{
    account_id: string; network: string; date: string; followers: number | null; impressions: number | null; reach: number | null;
    engagements: number | null; link_clicks: number | null; video_views: number | null; is_simulated: boolean;
  }>(
    `SELECT m.account_id, a.network, m.date::text AS date, m.followers, m.impressions,
            m.reach, m.engagements, m.link_clicks, m.video_views, (m.source = 'simulated' OR a.simulated) AS is_simulated
       FROM social_metrics_daily m
       JOIN social_accounts a ON a.id = m.account_id AND a.tenant_id = m.tenant_id
      WHERE a.client_id = $1 AND m.date >= $2::date AND m.date <= $3::date AND a.deleted_at IS NULL
        AND ($4::boolean OR NOT (m.source = 'simulated' OR a.simulated))
      ORDER BY m.account_id, m.date`,
    [a.clientId, a.start, a.end, a.includeSimulated],
  );
  const daily: DailyMetricInput[] = dailyRes.rows.map((r) => {
    if (r.is_simulated) simulated = true;
    return {
      accountId: r.account_id, network: r.network, date: r.date,
      followers: r.followers, impressions: r.impressions, reach: r.reach,
      engagements: r.engagements, linkClicks: r.link_clicks, videoViews: r.video_views,
    };
  });

  const publishedRes = await c.query<{
    variant_id: string; network: string; published_at: string | null; impressions: number | null; likes: number | null;
    comments: number | null; shares: number | null; saves: number | null; video_views: number | null; clicks: number | null;
    post_simulated: boolean; metric_simulated: boolean | null;
  }>(
    `SELECT DISTINCT ON (v.id)
            v.id AS variant_id, a.network, v.published_at::text AS published_at,
            pm.impressions, pm.likes, pm.comments, pm.shares, pm.saves, pm.video_views, pm.clicks,
            (p.simulated OR v.simulated) AS post_simulated, (pm.source = 'simulated') AS metric_simulated
       FROM social_post_variants v
       JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
       JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
       LEFT JOIN LATERAL (
         SELECT * FROM social_post_metrics pm2
          WHERE pm2.variant_id = v.id AND ($4::boolean OR pm2.source <> 'simulated')
          ORDER BY pm2.fetched_at DESC LIMIT 1
       ) pm ON true
      WHERE p.engagement_id = $1 AND v.status = 'published' AND v.deleted_at IS NULL
        AND v.published_at >= $2::date AND v.published_at < ($3::date + interval '1 day')
        AND ($4::boolean OR NOT (p.simulated OR v.simulated))`,
    [a.engagementId, a.start, a.end, a.includeSimulated],
  );
  const posts: PostMetricInput[] = publishedRes.rows.map((r) => {
    if (r.post_simulated || r.metric_simulated) simulated = true;
    return {
      variantId: r.variant_id, network: r.network, publishedAt: r.published_at,
      impressions: r.impressions, likes: r.likes, comments: r.comments, shares: r.shares,
      saves: r.saves, videoViews: r.video_views, clicks: r.clicks,
    };
  });

  const kpiTargetsRes = await c.query<{ metric_key: string; target_value: string; direction: string; due_period: string | null }>(
    `SELECT metric_key, target_value, direction, due_period
       FROM social_kpi_targets WHERE engagement_id = $1 AND deleted_at IS NULL`,
    [a.engagementId],
  );
  const kpiTargets: KpiTargetInput[] = kpiTargetsRes.rows.map((r) => ({
    metricKey: r.metric_key, targetValue: Number(r.target_value),
    direction: r.direction as "up" | "down", duePeriod: r.due_period,
  }));

  // The boosts that RAN (started: running, stopped or completed) and started in the period, on the engagement's undeleted posts.
  // `social_boosts` is on the plain wall; the post join is third-walled, which the module scope above covers. Only the client's
  // own spend, reach and clicks are read: these rows hold no fee of ours.
  const boostRes = await c.query<{
    id: string; title: string | null; starts_on: string; days: number; status: string; currency: string; minor_unit: number;
    spend_minor: string | null; paid_reach: number | null; clicks: number | null; simulated: boolean;
  }>(
    `SELECT b.id::text AS id, p.title, b.starts_on::text AS starts_on, b.days, b.status, b.currency::text AS currency,
            ${minorUnitSql("b.currency")} AS minor_unit, b.spend_minor::text AS spend_minor, b.paid_reach, b.clicks, b.simulated
       FROM social_boosts b
       JOIN social_posts p ON p.id = b.post_id AND p.tenant_id = b.tenant_id AND p.deleted_at IS NULL
      WHERE b.tenant_id = $1 AND p.engagement_id = $2 AND b.started_at IS NOT NULL
        AND b.status IN ('running', 'stopped', 'completed')
        AND b.starts_on >= $3::date AND b.starts_on <= $4::date
        AND ($5::boolean OR NOT b.simulated)
      ORDER BY b.starts_on, b.id`,
    [a.tenantId, a.engagementId, a.start, a.end, a.includeSimulated],
  );
  const boosts: BoostSpendInput[] = boostRes.rows.map((r) => {
    if (r.simulated) simulated = true;
    return {
      boostId: r.id, postTitle: r.title ?? "Untitled post", startsOn: r.starts_on, days: Number(r.days), status: r.status,
      currency: r.currency, minorUnit: Number(r.minor_unit), spendMinor: r.spend_minor === null ? null : Number(r.spend_minor),
      paidReach: r.paid_reach, clicks: r.clicks,
    };
  });

  return { daily, posts, kpiTargets, boosts, simulated: a.includeSimulated && simulated };
}

// ── Needs you (§63.7): the report items ─────────────────────────────────────────────────────────────────────────────────────

export interface ReportDueRow {
  engagementId: string;
  clientName: string;
  reportDueDay: number;
  /** The period's monthly report, when one exists (the newest undeleted one that is not delivered). */
  reportId: string | null;
  reportStatus: string | null;
}

/**
 * The officer's engagements (`owner_id` = the caller) with a `report_due_day`, whose monthly report for `period` has not been
 * delivered: the report is due. One row per engagement, whether or not the report row exists yet. The internal sentinel client
 * gets no client report (M5-G0b), so it never falls due.
 */
export async function readReportsDue(c: PoolClient, tenantId: string, officerId: string, period: string): Promise<ReportDueRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{
    engagement_id: string; client_name: string; report_due_day: number; report_id: string | null; report_status: string | null;
  }>(
    `SELECT e.id::text AS engagement_id, cl.name AS client_name, e.report_due_day, r.id::text AS report_id, r.status AS report_status
       FROM social_engagements e
       JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
       LEFT JOIN LATERAL (
         SELECT sr.id, sr.status FROM social_reports sr
          WHERE sr.tenant_id = e.tenant_id AND sr.engagement_id = e.id AND sr.kind = 'monthly' AND sr.period = $3 AND sr.deleted_at IS NULL
          ORDER BY sr.created_at DESC, sr.id LIMIT 1
       ) r ON true
      WHERE e.tenant_id = $1::uuid AND e.owner_id::text = $2 AND e.deleted_at IS NULL AND e.report_due_day IS NOT NULL
        AND e.status IN ('active', 'paused') AND NOT cl.is_internal
        AND NOT EXISTS (SELECT 1 FROM social_reports d
                         WHERE d.tenant_id = e.tenant_id AND d.engagement_id = e.id AND d.kind = 'monthly' AND d.period = $3
                           AND d.status = 'delivered' AND d.deleted_at IS NULL)
      ORDER BY e.id
      LIMIT 200`,
    [tenantId, officerId.toLowerCase(), period],
  );
  return rows.map((r) => ({
    engagementId: r.engagement_id, clientName: r.client_name, reportDueDay: Number(r.report_due_day),
    reportId: r.report_id, reportStatus: r.report_status,
  }));
}

export interface ReportToActRow {
  id: string;
  kind: string;
  period: string | null;
  status: "in_review" | "approved";
  clientName: string;
  reportDueDay: number | null;
  /** When it entered its status: approved_at for a ready report, the last change for one in the HoD check. */
  since: string;
}

/** The company's reports in the HoD check (`in_review`) and ready to send (`approved`), every client's: the seats' queue. */
export async function readReportsToAct(c: PoolClient, tenantId: string, max: number): Promise<ReportToActRow[]> {
  await declareSocialModuleScope(c);
  const { rows } = await c.query<{
    id: string; kind: string; period: string | null; status: "in_review" | "approved"; client_name: string; report_due_day: number | null; since: Date;
  }>(
    `SELECT sr.id::text AS id, sr.kind, sr.period, sr.status, cl.name AS client_name, e.report_due_day,
            CASE WHEN sr.status = 'approved' THEN coalesce(sr.approved_at, sr.updated_at) ELSE sr.updated_at END AS since
       FROM social_reports sr
       JOIN social_engagements e ON e.id = sr.engagement_id AND e.tenant_id = sr.tenant_id AND e.deleted_at IS NULL
       JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
      WHERE sr.tenant_id = $1::uuid AND sr.deleted_at IS NULL AND sr.status IN ('in_review', 'approved')
      ORDER BY since, sr.id
      LIMIT $2`,
    [tenantId, max],
  );
  return rows.map((r) => ({
    id: r.id, kind: r.kind, period: r.period, status: r.status, clientName: r.client_name,
    reportDueDay: r.report_due_day === null ? null : Number(r.report_due_day), since: new Date(r.since).toISOString(),
  }));
}
