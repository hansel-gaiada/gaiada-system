// PV6-02 — the Site analytics card. One card per search property of the client that has GA4 or Umami bound
// (module `search`).
//
// Sessions, engaged sessions and conversions come from `search_ga4_metrics` (real rows only: `simulated = false`).
// A property with no GA4 rows falls back to Umami's visits for SESSIONS ONLY (Umami has no engaged-session or
// conversion figure that means the same thing), and only when the server has Umami configured. When Umami is not
// configured the Umami half is SKIPPED, never reported as zero. Umami's small-cell suppression ("<5") becomes null.
//
// A property bound to GA4 shows its card even before the first pull (KPIs null), because "connected, no data yet" is
// a true statement; a property bound only to Umami on a server without Umami shows nothing, because there is nothing
// true to say about it.
import { readSummary } from "../../../search/umami-reads";
import { umamiSettings } from "../../../search/umami-client";
import { areaFor } from "./area-map";
import { isoDate, kpi, num, windows, type DateWindow } from "./kpi";
import type { BuildContext, Kpi, ResultsBuilder, ServiceCard } from "./types";

const MODULES = ["search"];
const WINDOW_DAYS = 30;

/** Umami visits for a window: a number, or null when the cell is suppressed ("<5"). Injected in tests. */
export type UmamiVisits = (siteId: string, w: DateWindow) => Promise<number | null>;

/** The real reader, or null when Umami is not configured on this server (the Umami half is then skipped). */
export function defaultUmamiVisits(): UmamiVisits | null {
  const settings = umamiSettings();
  if (!settings) return null;
  return async (siteId, w) => {
    const startAt = Date.parse(`${w.from}T00:00:00.000Z`);
    const endAt = Date.parse(`${w.to}T23:59:59.999Z`);
    const s = await readSummary({ siteId, startAt, endAt, opts: { settings } });
    return typeof s.visits === "number" ? s.visits : null;
  };
}

interface PropertyRow { id: string; domain: string; status: string; umami_site_id: string | null; ga4_connection_id: string | null; since: string }
interface Ga4Agg { n: string; sessions: string; engaged: string; conversions: string; latest: string | null }

const GA4_SQL = `
  SELECT count(*) AS n, COALESCE(sum(sessions), 0) AS sessions, COALESCE(sum(engaged_sessions), 0) AS engaged,
         COALESCE(sum(conversions), 0) AS conversions, max(date)::text AS latest
    FROM search_ga4_metrics
   WHERE property_id = $1 AND simulated = false AND date >= $2::date AND date <= $3::date`;

export function makeAnalyticsBuilder(umami: () => UmamiVisits | null = defaultUmamiVisits): ResultsBuilder {
  return {
    service: "analytics",
    requires: ["search"],
    async build(ctx: BuildContext): Promise<ServiceCard[]> {
      const { current, previous } = windows(ctx.now, WINDOW_DAYS);
      const readUmami = umami();

      const rows = await ctx.read(MODULES, async (c) => {
        const props = await c.query<PropertyRow>(
          `SELECT id, domain, status, umami_site_id, ga4_connection_id, created_at::date::text AS since
             FROM search_properties
            WHERE client_id = $1 AND deleted_at IS NULL AND (ga4_connection_id IS NOT NULL OR umami_site_id IS NOT NULL)
            ORDER BY created_at, id`,
          [ctx.clientId],
        );
        const out: Array<{ p: PropertyRow; cur: Ga4Agg; prev: Ga4Agg }> = [];
        for (const p of props.rows) {
          const cur = (await c.query<Ga4Agg>(GA4_SQL, [p.id, current.from, current.to])).rows[0];
          const prev = (await c.query<Ga4Agg>(GA4_SQL, [p.id, previous.from, previous.to])).rows[0];
          out.push({ p, cur, prev });
        }
        return out;
      });

      const cards: ServiceCard[] = [];
      for (const { p, cur, prev } of rows) {
        const hasGa4 = Number(cur.n) > 0;
        const hasGa4Prev = Number(prev.n) > 0;
        const ga4Bound = p.ga4_connection_id !== null || hasGa4 || hasGa4Prev;
        const umamiBound = p.umami_site_id !== null && readUmami !== null;
        if (!ga4Bound && !umamiBound) continue; // Umami-only on a server without Umami: nothing true to say

        let sessions = hasGa4 ? num(cur.sessions) : null;
        let sessionsPrev = hasGa4Prev ? num(prev.sessions) : null;
        let sessionsAsOf = isoDate(cur.latest);
        const sources: string[] = [];
        if (ga4Bound) sources.push("Google Analytics");
        if (!hasGa4 && !hasGa4Prev && umamiBound && p.umami_site_id && readUmami) {
          // A failure here is the builder's failure (the composer lists the service as unavailable): a silent
          // empty card would read as "no visitors".
          sessions = await readUmami(p.umami_site_id, current);
          sessionsPrev = await readUmami(p.umami_site_id, previous);
          sessionsAsOf = sessions !== null ? ctx.now.toISOString().slice(0, 10) : null;
          sources.push("Umami");
        }

        const kpis: Kpi[] = [
          kpi("analytics.sessions", "Sessions", "count", sessions, { period: current, previous: sessionsPrev, asOf: sessionsAsOf }),
          kpi("analytics.engaged_sessions", "Engaged sessions", "count", hasGa4 ? num(cur.engaged) : null, {
            period: current, previous: hasGa4Prev ? num(prev.engaged) : null, asOf: isoDate(cur.latest),
          }),
          kpi("analytics.conversions", "Conversions", "count", hasGa4 ? num(cur.conversions) : null, {
            period: current, previous: hasGa4Prev ? num(prev.conversions) : null, asOf: isoDate(cur.latest),
          }),
        ];
        cards.push({
          service: "analytics",
          areaId: areaFor("analytics"),
          title: rows.length > 1 ? `Site analytics: ${p.domain}` : "Site analytics",
          status: p.status === "paused" ? "paused" : p.status === "archived" ? "ended" : "active",
          since: p.since,
          items: [{ label: p.domain, detail: sources.join(" and ") || null }],
          kpis,
          clientVisible: true,
        });
      }
      return cards;
    },
  };
}

export const analyticsBuilder: ResultsBuilder = makeAnalyticsBuilder();
