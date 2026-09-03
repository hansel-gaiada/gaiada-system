// The site ↔ monitor bridge: what the estate portfolio can honestly say about a site's health.
//
// PURE, CLIENT-SAFE. Types + the join + state derivation only — no `server-only`, no fetch, so
// `PortfolioPanel` (a client component) can import it. The reads live in `siteMonitoring-data.ts`.
//
// ── WHY THIS IS A JOIN IN THE BFF AND NOT A COLUMN IN THE DATABASE ─────────────────────────────
// Web Dev's portfolio (`webdev_sites`) and the monitoring module (`monitors`) have NO link in
// either direction — no `monitor_id` on a site, no `site_id` on a monitor. The obvious fix is to
// add one, and it is the wrong fix: components in this program are separate projects that share
// contracts over HTTP, and `webdev`/`monitoring` are separately-enabled modules with separate RLS
// module gates. A cross-module foreign key would make the portfolio read require the monitoring
// module to be enabled — and `app_module_allowed()` returns **NULL**, not false, for a module that
// is off, so the AND silently yields zero rows and the whole portfolio would read as empty with no
// error raised anywhere. That exact failure has already happened once on this endpoint.
//
// So the two are joined here, at the BFF, on the thing they ALREADY share: the domain, via the SEO
// module's `search_properties`. That is not a workaround — the portfolio read already left-joins
// `search_properties` on `(tenant_id, domain)` for hosting topology and the consent gate, and the
// monitoring sweep already builds its probe allowlist from the same table. The domain is the spine.
//
// ── "NO MONITOR" AND "COULD NOT ASK" ARE DIFFERENT ANSWERS ─────────────────────────────────────
// `lib/monitoring.ts`'s own `listMonitors` collapses 404/403/405 into `[]`, which is right for the
// monitoring board (an empty board and an absent backend are both "nothing to show") and WRONG
// here: it would print "No monitor" on every row of the portfolio whether nothing is watched or
// nobody asked. That is a confident false claim about coverage. `siteMonitoring-data.ts` therefore
// carries availability explicitly — the same split MON-20 made for `listResults` and for the same
// reason.
import type { Monitor } from "./monitoringShared";
import type { FlatSite } from "./webdeskPortfolio";

/** One `search_properties` row, reduced to what the bridge needs. */
export interface PropertyRef {
  id: string;
  domain: string;
  clientId: string;
}

/** What the portfolio was able to learn about monitoring, as a whole. */
export type MonitoringFeed =
  | { available: true; monitors: Monitor[]; properties: PropertyRef[] }
  /** The module is off for this company, or the caller may not read it. NOT "nothing is watched". */
  | { available: false; reason: "not_enabled" | "refused" };

/** Per-site monitoring state. Five answers, because there are genuinely five. */
export type SiteMonitoring =
  /** Could not ask. Renders as unknown, never as uncovered. */
  | { kind: "unavailable"; reason: "not_enabled" | "refused" }
  /** A monitor is watching this domain. `consented` false is a COMPLIANCE ANOMALY, not a detail. */
  | { kind: "watched"; monitor: Monitor; consented: boolean }
  /** No crawl consent on record, so by rule nothing probes it. Not a gap to be closed by us. */
  | { kind: "no-consent" }
  /** Consented and genuinely unwatched. `clientId` is what makes a monitor creatable. */
  | { kind: "none"; clientId: string | null };

/** Strip what does not identify a host: scheme, credentials, port, path, and a leading `www.`.
 *  `https://www.example.com:443/health` and `example.com` are the same host, and a bridge that
 *  treats them as different reports a monitored site as unmonitored. */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");   // scheme
  v = v.replace(/^[^/@]*@/, "");                   // user:pass@
  v = v.split("/")[0].split("?")[0].split("#")[0]; // path / query / fragment
  v = v.replace(/:\d+$/, "");                      // port
  v = v.replace(/^www\./, "");
  v = v.replace(/\.$/, "");                        // a trailing root dot is legal in DNS
  return v || null;
}

/** The domain a monitor watches.
 *
 *  `propertyId` FIRST, because it is an identity: the monitor and the site both point at the same
 *  `search_properties` row and there is nothing to misread. `target` is the fallback and it is a
 *  DISPLAY string (`"blossomsteakhouse.com:443"`, `"https://aperitif.com/reservations"`), so it is
 *  parsed rather than compared. A heartbeat monitor has neither and watches no domain at all —
 *  null, not a guess. */
export function monitorDomain(m: Monitor, byProperty: Map<string, PropertyRef>): string | null {
  if (m.propertyId) {
    const prop = byProperty.get(m.propertyId);
    if (prop) return hostOf(prop.domain);
    // A propertyId we cannot resolve means the properties read was unavailable or narrower than the
    // monitors read. Fall through to the target rather than dropping the monitor entirely.
  }
  return hostOf(m.target);
}

/** Worst-first, so when several monitors watch one domain the row shows the one that matters.
 *  Mirrors `sortForBoard`'s ordering intent: a real failure outranks a suppressed one. */
const STATUS_RANK: Record<string, number> = {
  down: 0, degraded: 1, unknown: 2, maintenance: 3, up: 4,
};
function worstFirst(a: Monitor, b: Monitor): number {
  const r = (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2);
  if (r !== 0) return r;
  // A disabled monitor is not evidence of health, so an enabled one wins a tie.
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** An index from host -> the monitors watching it, worst-first. Built once per render. */
export function indexMonitorsByDomain(
  monitors: Monitor[],
  properties: PropertyRef[],
): Map<string, Monitor[]> {
  const byProperty = new Map(properties.map((p) => [p.id, p]));
  const out = new Map<string, Monitor[]>();
  for (const m of monitors) {
    const d = monitorDomain(m, byProperty);
    if (!d) continue;   // heartbeat / no target — watches no domain, so it joins to nothing
    const list = out.get(d);
    if (list) list.push(m);
    else out.set(d, [m]);
  }
  for (const list of out.values()) list.sort(worstFirst);
  return out;
}

/** The client a monitor for this site would belong to.
 *
 *  This is the part that unblocks the create path. `/monitoring/new` requires a client — a monitor
 *  belongs to one by design (company → client → property) — and almost every surveyed portfolio row
 *  has `clientId: null`, because attributing them would have been invention. But a CONSENTED domain
 *  has a `search_properties` row by definition (consent IS `verified_at` on that row), and that row
 *  carries a `client_id`. So for exactly the sites a monitor is permitted on, the client is
 *  knowable — from the property, not from a guess. The site's own `clientId` wins when it has one. */
export function monitorClientFor(site: FlatSite, properties: PropertyRef[]): string | null {
  if (site.clientId) return site.clientId;
  const host = hostOf(site.domain);
  const prop = properties.find((p) => hostOf(p.domain) === host);
  return prop ? prop.clientId : null;
}

/** Resolve one site's monitoring state.
 *
 *  ORDER IS LOAD-BEARING. "Is it watched" is asked BEFORE "is it consented", so a domain that is
 *  being probed with no consent on record surfaces as `watched` + `consented: false` — a compliance
 *  anomaly someone has to act on. Checking consent first would file that case under "not probed"
 *  and hide the one state nobody wants to be in. */
export function siteMonitoring(
  site: FlatSite,
  feed: MonitoringFeed,
  index: Map<string, Monitor[]>,
): SiteMonitoring {
  if (!feed.available) return { kind: "unavailable", reason: feed.reason };
  const host = hostOf(site.domain);
  const watching = host ? index.get(host) : undefined;
  if (watching && watching.length > 0) {
    return { kind: "watched", monitor: watching[0], consented: site.crawlConsent };
  }
  if (!site.crawlConsent) return { kind: "no-consent" };
  return { kind: "none", clientId: monitorClientFor(site, feed.properties) };
}

/** Deep link to create a monitor for a site, with what we know already filled in.
 *
 *  The domain always travels. The client travels only when it is KNOWN — never as a blank param,
 *  which would land the operator on a form silently missing its required field. When there is no
 *  client the link is still offered: the form can say what is missing far better than a hidden
 *  button can. */
export function createMonitorHref(site: FlatSite, clientId: string | null): string {
  const qs = new URLSearchParams({ domain: site.domain });
  if (clientId) qs.set("clientId", clientId);
  return `/monitoring/new?${qs.toString()}`;
}

/** Headline coverage figures for the portfolio's KPI row. Every field is a count of a state that
 *  actually exists — there is deliberately no "healthy" figure, because this surface does not
 *  compute health, it reports whose job it is. */
export interface CoverageStats {
  available: boolean;
  watched: number;
  problems: number;
  unwatched: number;
  noConsent: number;
  /** Watched with no consent on record. Should be zero; if it is not, it is the first thing to fix. */
  anomalies: number;
}

export function coverageStats(states: SiteMonitoring[]): CoverageStats {
  const s: CoverageStats = { available: true, watched: 0, problems: 0, unwatched: 0, noConsent: 0, anomalies: 0 };
  for (const st of states) {
    switch (st.kind) {
      case "unavailable": s.available = false; break;
      case "watched": {
        s.watched += 1;
        // "Not up" rather than "is down": degraded and unknown are both "not evidence of health",
        // and a coverage figure that counts only `down` under-reports exactly the states the
        // monitoring module was written to stop hiding. `maintenance` is excluded — suppressed on
        // purpose is not a problem to chase.
        if (st.monitor.status !== "up" && st.monitor.status !== "maintenance") s.problems += 1;
        if (!st.consented) s.anomalies += 1;
        break;
      }
      case "no-consent": s.noConsent += 1; break;
      case "none": s.unwatched += 1; break;
    }
  }
  return s;
}
