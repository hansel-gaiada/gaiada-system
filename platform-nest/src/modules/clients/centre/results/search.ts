// PV6-02 — the SEO card. One card per search engagement of the client (module `search`).
//
// ── SIMULATED ROWS NEVER REACH A CLIENT ─────────────────────────────────────────────────────────────────────
// search_rank_snapshots, search_gsc_performance and search_ai_visibility carry `simulated` (0048, 0061). Every
// read below filters `simulated = false`, whatever the instance's provider mode is: an internal rollup may show a
// demo instance its own simulated history, a client never sees a synthetic figure. (Drop a filter and
// centre-results.db.test.ts goes red.)
//
// ── UNKNOWN IS NULL ────────────────────────────────────────────────────────────────────────────────────────
// A window with no GSC rows gives `null` clicks, not 0. A property with no tracked ranking has no top-10 figure,
// not "0 keywords in the top 10". The top-10 count itself is the one shared helper (search/rank-top10.ts).
import { rankTop10 } from "../../../search/rank-top10";
import { areaFor } from "./area-map";
import { engagementStatus, isoDate, kpi, num, round, windows } from "./kpi";
import type { BuildContext, Kpi, ResultsBuilder, ServiceCard } from "./types";

const MODULES = ["search"];
const WINDOW_DAYS = 28;

/** search_kpi_targets.metric_key -> this card's KPI key. Keys not listed are not shown on the client's card. */
const TARGET_KEYS: Record<string, string> = {
  top10_keywords: "search.top10_keywords",
  organic_clicks: "search.organic_clicks",
  ai_citations: "search.ai_citations",
};

interface EngagementRow { id: string; name: string; status: string; property_id: string; since: string | null; domain: string }

export const searchBuilder: ResultsBuilder = {
  service: "search",
  requires: ["search"],
  async build(ctx: BuildContext): Promise<ServiceCard[]> {
    const { current, previous } = windows(ctx.now, WINDOW_DAYS);
    // The top-10 "previous" is the standing as it was when the current window began.
    const prevAsOf = new Date(`${current.from}T00:00:00Z`);

    return ctx.read(MODULES, async (c) => {
      const engagements = await c.query<EngagementRow>(
        `SELECT se.id, se.name, se.status, se.property_id, COALESCE(se.starts_on, se.created_at::date)::text AS since, sp.domain
           FROM search_engagements se
           JOIN search_properties sp ON sp.id = se.property_id AND sp.tenant_id = se.tenant_id
          WHERE se.client_id = $1 AND se.deleted_at IS NULL AND sp.deleted_at IS NULL
          ORDER BY se.created_at, se.id`,
        [ctx.clientId],
      );

      const cards: ServiceCard[] = [];
      for (const e of engagements.rows) {
        const targets = await c.query<{ metric_key: string; target_value: string }>(
          `SELECT metric_key, target_value FROM search_kpi_targets WHERE engagement_id = $1 AND deleted_at IS NULL
            ORDER BY created_at, id`,
          [e.id],
        );
        const targetFor = new Map<string, number>();
        for (const t of targets.rows) {
          const key = TARGET_KEYS[t.metric_key];
          if (key) targetFor.set(key, Number(t.target_value)); // newest wins (ordered oldest first)
        }

        // ── keywords in the top 10 (real snapshots only) ──
        const nowTop = await rankTop10(c, { propertyId: e.property_id, simulated: false });
        const thenTop = await rankTop10(c, { propertyId: e.property_id, simulated: false, asOf: prevAsOf });

        // ── Search Console: clicks, impressions, average position (real rows only) ──
        const gsc = await c.query<{ n: string; clicks: string; impressions: string; pos_weighted: string | null; pos_impr: string; latest: string | null }>(
          `SELECT count(*) AS n, COALESCE(sum(clicks), 0) AS clicks, COALESCE(sum(impressions), 0) AS impressions,
                  sum(position * impressions) FILTER (WHERE position IS NOT NULL) AS pos_weighted,
                  COALESCE(sum(impressions) FILTER (WHERE position IS NOT NULL), 0) AS pos_impr,
                  max(date)::text AS latest
             FROM search_gsc_performance
            WHERE property_id = $1 AND simulated = false AND date >= $2::date AND date <= $3::date`,
          [e.property_id, current.from, current.to],
        );
        const gscPrev = await c.query<{ n: string; clicks: string; impressions: string; pos_weighted: string | null; pos_impr: string }>(
          `SELECT count(*) AS n, COALESCE(sum(clicks), 0) AS clicks, COALESCE(sum(impressions), 0) AS impressions,
                  sum(position * impressions) FILTER (WHERE position IS NOT NULL) AS pos_weighted,
                  COALESCE(sum(impressions) FILTER (WHERE position IS NOT NULL), 0) AS pos_impr
             FROM search_gsc_performance
            WHERE property_id = $1 AND simulated = false AND date >= $2::date AND date <= $3::date`,
          [e.property_id, previous.from, previous.to],
        );

        // ── AI citations: snapshots in the window where the property was cited (real rows only) ──
        const ai = await c.query<{ n: string; cited: string; latest: string | null }>(
          `SELECT count(*) AS n, count(*) FILTER (WHERE cited) AS cited, max(captured_at)::date::text AS latest
             FROM search_ai_visibility
            WHERE property_id = $1 AND simulated = false
              AND captured_at >= $2::date AND captured_at < ($3::date + interval '1 day')`,
          [e.property_id, current.from, current.to],
        );
        const aiPrev = await c.query<{ n: string; cited: string }>(
          `SELECT count(*) AS n, count(*) FILTER (WHERE cited) AS cited
             FROM search_ai_visibility
            WHERE property_id = $1 AND simulated = false
              AND captured_at >= $2::date AND captured_at < ($3::date + interval '1 day')`,
          [e.property_id, previous.from, previous.to],
        );

        const g = gsc.rows[0];
        const gp = gscPrev.rows[0];
        const hasGsc = Number(g?.n ?? 0) > 0;
        const hasGscPrev = Number(gp?.n ?? 0) > 0;
        const weightedPos = (row: { pos_weighted: string | null; pos_impr: string } | undefined): number | null => {
          const impr = num(row?.pos_impr);
          const w = num(row?.pos_weighted);
          return impr !== null && impr > 0 && w !== null ? round(w / impr, 1) : null;
        };
        const hasAi = Number(ai.rows[0]?.n ?? 0) > 0;
        const hasAiPrev = Number(aiPrev.rows[0]?.n ?? 0) > 0;
        const gscAsOf = isoDate(g?.latest ?? null);

        const kpis: Kpi[] = [
          kpi("search.top10_keywords", "Keywords in the top 10", "count", nowTop.tracked > 0 ? nowTop.top10 : null, {
            previous: thenTop.tracked > 0 ? thenTop.top10 : null,
            target: targetFor.get("search.top10_keywords") ?? null,
            asOf: isoDate(nowTop.latestCapturedAt),
          }),
          kpi("search.organic_clicks", "Organic clicks", "count", hasGsc ? num(g.clicks) : null, {
            period: current, previous: hasGscPrev ? num(gp.clicks) : null,
            target: targetFor.get("search.organic_clicks") ?? null, asOf: gscAsOf,
          }),
          kpi("search.impressions", "Impressions", "count", hasGsc ? num(g.impressions) : null, {
            period: current, previous: hasGscPrev ? num(gp.impressions) : null, asOf: gscAsOf,
          }),
          kpi("search.avg_position", "Average position", "position", hasGsc ? weightedPos(g) : null, {
            period: current, previous: hasGscPrev ? weightedPos(gp) : null, asOf: gscAsOf,
          }),
          kpi("search.ai_citations", "AI citations", "count", hasAi ? num(ai.rows[0].cited) : null, {
            period: current, previous: hasAiPrev ? num(aiPrev.rows[0].cited) : null,
            target: targetFor.get("search.ai_citations") ?? null, asOf: isoDate(ai.rows[0]?.latest ?? null),
          }),
        ];

        cards.push({
          service: "search",
          areaId: areaFor("search"),
          title: engagements.rows.length > 1 ? e.name : "SEO",
          status: engagementStatus(e.status),
          since: e.since,
          items: [{ label: e.domain, detail: null }],
          kpis,
          clientVisible: true,
        });
      }
      return cards;
    });
  },
};
