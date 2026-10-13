// PV6-02 — the Paid search card (module `search`): only for a client with a LIVE campaign.
//
// ── NO MONEY GOES OUT EXCEPT THE CLIENT'S OWN CONVERSION VALUE (PV6-Q2) ─────────────────────────────────────
// The card carries clicks, conversions and conversion value. It carries NO spend, cost, budget, bid or CPA figure:
// those are the agency's media-planning numbers and stay in the department screens. Conversion value is the
// client's own revenue attributed to the ads, in major units; it is reported only when every row it sums is in
// ONE known currency (two currencies cannot be added, and a missing currency cannot be assumed), else null.
// The test asserts the key set of the whole card so a cost field cannot be added by accident.
import { areaFor } from "./area-map";
import { engagementStatus, kpi, num, windows } from "./kpi";
import type { BuildContext, Kpi, ResultsBuilder, ServiceCard } from "./types";

const MODULES = ["search"];
const WINDOW_DAYS = 30;

/** Minor-unit exponent for an ISO currency code (2 for USD, 0 for JPY, 3 for KWD). Unknown code => 2. */
export function minorExponent(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

interface Agg { n: string; latest: string | null; clicks: string; conversions: string; conv_value_minor: string; currencies: string[] | null; null_currency_rows: string }

const AGG_SQL = `
  SELECT count(*) AS n, max(m.date)::text AS latest, COALESCE(sum(m.clicks), 0) AS clicks, COALESCE(sum(m.conversions), 0) AS conversions,
         COALESCE(sum(m.conv_value_minor), 0) AS conv_value_minor,
         array_agg(DISTINCT m.currency) FILTER (WHERE m.currency IS NOT NULL) AS currencies,
         count(*) FILTER (WHERE m.currency IS NULL AND m.conv_value_minor <> 0) AS null_currency_rows
    FROM search_campaign_metrics_daily m
   WHERE m.campaign_id = ANY($1::uuid[]) AND m.simulated = false
     AND m.date >= $2::date AND m.date <= $3::date`;

function conversionValue(a: Agg | undefined): { value: number | null; currency: string | null } {
  if (!a || Number(a.n) === 0) return { value: null, currency: null };
  const cur = a.currencies ?? [];
  if (cur.length !== 1 || Number(a.null_currency_rows) > 0) return { value: null, currency: null };
  const minor = num(a.conv_value_minor);
  if (minor === null) return { value: null, currency: null };
  return { value: minor / 10 ** minorExponent(cur[0]), currency: cur[0] };
}

export const searchAdsBuilder: ResultsBuilder = {
  service: "search_ads",
  requires: ["search"],
  async build(ctx: BuildContext): Promise<ServiceCard[]> {
    const { current, previous } = windows(ctx.now, WINDOW_DAYS);

    return ctx.read(MODULES, async (c) => {
      const campaigns = await c.query<{ id: string; engagement_id: string; engagement_name: string; engagement_status: string; name: string; platform: string; since: string | null }>(
        `SELECT sc.id, sc.engagement_id, se.name AS engagement_name, se.status AS engagement_status, sc.name, sc.platform,
                COALESCE(se.starts_on, se.created_at::date)::text AS since
           FROM search_campaigns sc
           JOIN search_engagements se ON se.id = sc.engagement_id AND se.tenant_id = sc.tenant_id
          WHERE se.client_id = $1 AND sc.status = 'live' AND sc.deleted_at IS NULL AND se.deleted_at IS NULL
          ORDER BY se.created_at, se.id, sc.created_at, sc.id`,
        [ctx.clientId],
      );
      const byEngagement = new Map<string, typeof campaigns.rows>();
      for (const row of campaigns.rows) byEngagement.set(row.engagement_id, [...(byEngagement.get(row.engagement_id) ?? []), row]);

      const cards: ServiceCard[] = [];
      for (const rows of byEngagement.values()) {
        const ids = rows.map((r) => r.id);
        const cur = (await c.query<Agg>(AGG_SQL, [ids, current.from, current.to])).rows[0];
        const prev = (await c.query<Agg>(AGG_SQL, [ids, previous.from, previous.to])).rows[0];
        const hasCur = Number(cur?.n ?? 0) > 0;
        const hasPrev = Number(prev?.n ?? 0) > 0;
        const asOf = cur?.latest ?? null;
        const valueCur = conversionValue(cur);
        const valuePrev = conversionValue(prev);
        const currency = valueCur.currency ?? valuePrev.currency;

        const kpis: Kpi[] = [
          kpi("search_ads.clicks", "Ad clicks", "count", hasCur ? num(cur.clicks) : null, {
            period: current, previous: hasPrev ? num(prev.clicks) : null, asOf,
          }),
          kpi("search_ads.conversions", "Conversions", "count", hasCur ? num(cur.conversions) : null, {
            period: current, previous: hasPrev ? num(prev.conversions) : null, asOf,
          }),
          kpi("search_ads.conversion_value", currency ? `Conversion value (${currency})` : "Conversion value", "count", valueCur.value, {
            period: current, previous: valuePrev.value, asOf,
          }),
        ];
        const head = rows[0];
        cards.push({
          service: "search_ads",
          areaId: areaFor("search_ads"),
          title: byEngagement.size > 1 ? `Paid search: ${head.engagement_name}` : "Paid search",
          status: engagementStatus(head.engagement_status),
          since: head.since,
          items: rows.map((r) => ({ label: r.name, detail: r.platform === "microsoft_ads" ? "Microsoft Ads" : "Google Ads" })),
          kpis,
          clientVisible: true,
        });
      }
      return cards;
    });
  },
};
