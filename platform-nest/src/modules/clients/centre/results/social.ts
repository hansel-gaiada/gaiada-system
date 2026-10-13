// PV6-02 — the Social media card. One card per social engagement of the client (module `social`).
//
// The numbers come from `buildSocialReportSnapshot` (modules/social/reports.ts), the same pure function the
// client-facing engagement report uses, so a figure on this page and the same figure in a delivered report are
// computed by one piece of code. That function omits a metric nobody ever pulled; this file turns an omission
// into an explicit `null` so the card always lists the same KPIs and the UI can print "no data yet".
//
// Accounts and daily metrics belong to the CLIENT (social_accounts.client_id), not to an engagement, so two
// engagements of one client show the same account figures; "posts published" and the targets are per engagement.
import { buildSocialReportSnapshot, type DailyMetricInput } from "../../../social/reports";
import { isoDate, engagementStatus, kpi, windows, type DateWindow } from "./kpi";
import { areaFor } from "./area-map";
import type { BuildContext, Kpi, ResultsBuilder, ServiceCard } from "./types";

const MODULES = ["social"];
const WINDOW_DAYS = 30;

/** Report metric key -> this card's stable key, label, and the social_kpi_targets key that commits it. */
const KPI_MAP: Array<{ key: string; reportKey: string; label: string; targetKey: string | null }> = [
  { key: "social.followers", reportKey: "followers_total", label: "Followers", targetKey: "followers_total" },
  { key: "social.reach", reportKey: "reach_period", label: "Reach", targetKey: "reach_month" },
  { key: "social.engagements", reportKey: "engagements_period", label: "Engagements", targetKey: null },
  { key: "social.link_clicks", reportKey: "link_clicks_period", label: "Link clicks", targetKey: "link_clicks_month" },
  { key: "social.posts_published", reportKey: "posts_published_period", label: "Posts published", targetKey: "posts_published_month" },
];

interface EngagementRow { id: string; name: string; status: string; since: string | null }
interface DailyRow {
  account_id: string; network: string; date: string; followers: number | null; impressions: number | null;
  reach: number | null; engagements: number | null; link_clicks: number | null; video_views: number | null;
}

function snapshot(daily: DailyMetricInput[], posts: number, w: DateWindow): Map<string, number> {
  const frozen = buildSocialReportSnapshot({
    rangeStart: w.from, rangeEnd: w.to, daily, posts: [], postsPublishedInPeriod: posts, kpiTargets: [],
  });
  return new Map(frozen.kpis.map((k): [string, number] => [k.metricKey, k.value]));
}

export const socialBuilder: ResultsBuilder = {
  service: "social",
  requires: ["social"],
  async build(ctx: BuildContext): Promise<ServiceCard[]> {
    const { current, previous } = windows(ctx.now, WINDOW_DAYS);

    const data = await ctx.read(MODULES, async (c) => {
      const engagements = await c.query<EngagementRow>(
        `SELECT id, name, status, COALESCE(starts_on, created_at::date)::text AS since
           FROM social_engagements
          WHERE client_id = $1 AND deleted_at IS NULL
          ORDER BY created_at, id`,
        [ctx.clientId],
      );
      if (engagements.rows.length === 0) return null;

      // Connected accounts only: a pending, errored or disconnected account is an internal matter, not a result.
      const accounts = await c.query<{ network: string; handle: string }>(
        `SELECT network, handle FROM social_accounts
          WHERE client_id = $1 AND deleted_at IS NULL AND status IN ('connected','expiring')
          ORDER BY network, handle`,
        [ctx.clientId],
      );

      const daily = await c.query<DailyRow>(
        `SELECT m.account_id, a.network, m.date::text AS date, m.followers, m.impressions, m.reach,
                m.engagements, m.link_clicks, m.video_views
           FROM social_metrics_daily m
           JOIN social_accounts a ON a.id = m.account_id AND a.tenant_id = m.tenant_id
          WHERE a.client_id = $1 AND a.deleted_at IS NULL
            AND m.date >= $2::date AND m.date <= $3::date
          ORDER BY m.account_id, m.date`,
        [ctx.clientId, previous.from, current.to],
      );

      const perEngagement = new Map<string, { posts: { cur: number; prev: number }; targets: Map<string, number> }>();
      for (const e of engagements.rows) {
        const posts = await c.query<{ cur: string; prev: string }>(
          `SELECT count(DISTINCT v.id) FILTER (WHERE v.published_at >= $2::date AND v.published_at < ($3::date + interval '1 day')) AS cur,
                  count(DISTINCT v.id) FILTER (WHERE v.published_at >= $4::date AND v.published_at < ($5::date + interval '1 day')) AS prev
             FROM social_post_variants v
             JOIN social_posts p ON p.id = v.post_id AND p.tenant_id = v.tenant_id
            WHERE p.engagement_id = $1 AND v.status = 'published' AND v.deleted_at IS NULL`,
          [e.id, current.from, current.to, previous.from, previous.to],
        );
        const targets = await c.query<{ metric_key: string; target_value: string }>(
          `SELECT metric_key, target_value FROM social_kpi_targets WHERE engagement_id = $1 AND deleted_at IS NULL
            ORDER BY created_at, id`,
          [e.id],
        );
        perEngagement.set(e.id, {
          posts: { cur: Number(posts.rows[0]?.cur ?? 0), prev: Number(posts.rows[0]?.prev ?? 0) },
          // the newest target per metric wins (rows are ordered oldest first)
          targets: new Map(targets.rows.map((t): [string, number] => [t.metric_key, Number(t.target_value)])),
        });
      }
      return { engagements: engagements.rows, accounts: accounts.rows, daily: daily.rows, perEngagement };
    });
    if (!data) return [];

    const toInput = (r: DailyRow): DailyMetricInput => ({
      accountId: r.account_id, network: r.network, date: r.date, followers: r.followers, impressions: r.impressions,
      reach: r.reach, engagements: r.engagements, linkClicks: r.link_clicks, videoViews: r.video_views,
    });
    const inWindow = (w: DateWindow) => data.daily.filter((r) => r.date >= w.from && r.date <= w.to).map(toInput);
    const curDaily = inWindow(current);
    const prevDaily = inWindow(previous);
    // The newest day that carries ANY pulled figure: the metrics' "as of".
    const asOf = isoDate(
      curDaily
        .filter((d) => [d.followers, d.impressions, d.reach, d.engagements, d.linkClicks, d.videoViews].some((v) => v !== null))
        .map((d) => d.date).sort().at(-1) ?? null,
    );

    return data.engagements.map((e): ServiceCard => {
      const mine = data.perEngagement.get(e.id)!;
      const cur = snapshot(curDaily, mine.posts.cur, current);
      const prev = snapshot(prevDaily, mine.posts.prev, previous);
      const kpis: Kpi[] = KPI_MAP.map((m) => {
        // Posts published is a count of OUR OWN rows, so a real 0 is a real answer. Every pulled metric is unknown (null)
        // until something was pulled, which `buildSocialReportSnapshot` already encodes by omitting it.
        const isPosts = m.key === "social.posts_published";
        return kpi(m.key, m.label, "count", cur.get(m.reportKey) ?? null, {
          period: current,
          previous: prev.get(m.reportKey) ?? null,
          target: m.targetKey !== null ? (mine.targets.get(m.targetKey) ?? null) : null,
          asOf: isPosts ? ctx.now.toISOString().slice(0, 10) : asOf,
        });
      });
      return {
        service: "social",
        areaId: areaFor("social"),
        title: data.engagements.length > 1 ? e.name : "Social media",
        status: engagementStatus(e.status),
        since: e.since,
        items: data.accounts.map((a) => ({ label: a.handle, detail: a.network })),
        kpis,
        clientVisible: true,
      };
    });
  },
};
