// M5-W8 — the writer dashboard's four data sources, behind one interface so the service is testable without a database:
//   Umami (A4) · Search Console (our own `search_gsc_performance` rows, SM-25b) · web leads (L4's `agency_leads.attribution`)
//   · decay findings (V4's `search_decay_findings`).
//
// WHY THESE READS ARE NOT GATED BY `resource_search_property` / `agency_lead`: the dashboard's authority is the WebDesk read
// (phase 1 + the pair checks in the service). What leaves here is COUNTS for the pages of the caller's own site, and the
// search tables are reached through `withTenants([tenant], …, { modules: ["search"] })`, where the module scope is a property
// of the TABLE (its third RLS wall), not an authorization (the same posture as `webdesk-brief-store.ts`). A lead's identity
// needs `agency_lead:read`, which no editorial role holds: the lead query below selects ONLY `created_at`, `landing` and
// `form_page`, so there is no id, name, address, phone or note for it to leak, and a test pins the SQL text.
//
// MISSING IS NOT ZERO: every source returns `SourceResult`; a failure becomes a reason on each affected figure.
import { withTenants } from "../../db";
import {
  umamiGet, umamiSettings, UmamiAuthError, UmamiError, UmamiNotConfiguredError, UmamiNotFoundError, UmamiUnreachableError,
  type UmamiGetOpts,
} from "../search/umami-client";
import { normalizePagePath } from "../search/content-decay";
import {
  endOf, gscMinCoverageDays, sourceFail, sourceOk, startOf, topQueriesOf,
  type DashboardWindows, type DecayData, type DecayInfo, type GscAgg, type GscData, type LeadData, type Sourced, type SourceResult,
  type TopQuery, type UmamiData, type UmamiPathViews, type UmamiTimeRow,
} from "./webdesk-writers-dashboard";

export interface PropertyRef { id: string; umamiSiteId: string | null }

export interface SourcesInput {
  tenantId: string;
  /** The WebDesk tenant slug: agency_leads.web_site_slug. */
  tenantSlug: string;
  /** The site's environment domains, production first (null entries already dropped). */
  domains: readonly string[];
  /** Normalised page paths (`pathKey`) of the items on this page. */
  keys: readonly string[];
  windows: DashboardWindows;
  days: number;
}

export interface DashboardSources {
  collect(input: SourcesInput): Promise<Sourced>;
}

// ── the search property of a site ────────────────────────────────────────────────────────────────

export const normDomain = (d: string): string => d.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

export interface PropertyRow { id: string; domain: string; umamiSiteId: string | null; verifiedAt: Date | string | null }

/** The first environment domain (production first) that a property is registered for; a verified property wins a tie. */
export function matchProperty(domains: readonly string[], rows: readonly PropertyRow[]): PropertyRef | null {
  for (const d of domains.map(normDomain)) {
    const hits = rows.filter((r) => normDomain(r.domain) === d).sort((a, b) => Number(!!b.verifiedAt) - Number(!!a.verifiedAt));
    if (hits[0]) return { id: hits[0].id, umamiSiteId: hits[0].umamiSiteId };
  }
  return null;
}

export const PROPERTY_SQL =
  `SELECT id, domain, umami_site_id AS "umamiSiteId", verified_at AS "verifiedAt"
     FROM search_properties
    WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active'`;

async function findProperty(tenantId: string, domains: readonly string[]): Promise<SourceResult<PropertyRef>> {
  if (domains.length === 0) return sourceFail("no_search_property");
  try {
    const rows = await withTenants([tenantId], (c) => c.query<PropertyRow>(PROPERTY_SQL, [tenantId]), { modules: ["search"] });
    const p = matchProperty(domains, rows.rows);
    return p ? sourceOk(p) : sourceFail("no_search_property");
  } catch {
    return sourceFail("search_unavailable");
  }
}

// ── Umami ────────────────────────────────────────────────────────────────────────────────────────

/** Umami `metrics` page cap per call; a window that returns this many rows may be truncated (the decay job's rule). */
export const UMAMI_PATH_LIMIT = 500;

export function parseUmamiPaths(body: unknown): UmamiPathViews {
  const byPath = new Map<string, number>();
  const rows = Array.isArray(body) ? body : [];
  for (const r of rows) {
    const o = r as { x?: unknown; y?: unknown };
    if (typeof o.x !== "string" || typeof o.y !== "number" || !Number.isFinite(o.y)) continue;
    const k = normalizePagePath(o.x);
    if (k) byPath.set(k, (byPath.get(k) ?? 0) + o.y);
  }
  return { covered: rows.length > 0, truncated: rows.length >= UMAMI_PATH_LIMIT, byPath };
}

/** `metrics/expanded?type=path` rows: `{ name, pageviews, visitors, visits, bounces, totaltime }`. null when the body is not that. */
export function parseUmamiTime(body: unknown): Map<string, UmamiTimeRow> | null {
  if (!Array.isArray(body)) return null;
  const out = new Map<string, UmamiTimeRow>();
  for (const r of body) {
    const o = r as { name?: unknown; pageviews?: unknown; visits?: unknown; totaltime?: unknown };
    if (typeof o.name !== "string" || typeof o.pageviews !== "number" || typeof o.visits !== "number" || typeof o.totaltime !== "number") continue;
    const k = normalizePagePath(o.name);
    if (!k) continue;
    const cur = out.get(k) ?? { pageviews: 0, visits: 0, totaltime: 0 };
    out.set(k, { pageviews: cur.pageviews + o.pageviews, visits: cur.visits + o.visits, totaltime: cur.totaltime + o.totaltime });
  }
  return out;
}

function umamiReason(e: unknown): SourceResult<never> {
  if (e instanceof UmamiNotConfiguredError) return sourceFail("umami_not_configured");
  if (e instanceof UmamiAuthError || e instanceof UmamiNotFoundError) return sourceFail("umami_rejected");
  if (e instanceof UmamiUnreachableError || e instanceof UmamiError) return sourceFail("umami_unreachable");
  throw e; // not an Umami failure: a programming error must not read as "analytics is down"
}

/** Views per path for both periods (A4's verified `metrics?type=path`), plus per-path time from `metrics/expanded`, best effort. */
export async function readUmami(siteId: string | null, w: DashboardWindows, opts: UmamiGetOpts = {}): Promise<SourceResult<UmamiData>> {
  const settings = opts.settings === undefined ? umamiSettings() : opts.settings;
  if (!settings) return sourceFail("umami_not_configured");
  if (!siteId) return sourceFail("umami_not_bound");
  const o: UmamiGetOpts = { ...opts, settings };
  const q = (win: { from: string; to: string }) => ({ startAt: startOf(win.from), endAt: endOf(win.to), limit: UMAMI_PATH_LIMIT });
  const soft = (p: Promise<unknown>) => p.then((b) => ({ ok: true as const, b }), (e: unknown) => ({ ok: false as const, e }));
  const [cur, prev, time] = await Promise.all([
    soft(umamiGet(siteId, "metrics", { type: "path", ...q(w.traffic.current) }, o)),
    soft(umamiGet(siteId, "metrics", { type: "path", ...q(w.traffic.previous) }, o)),
    soft(umamiGet(siteId, "metrics/expanded", { type: "path", ...q(w.traffic.current) }, o)),
  ]);
  if (!cur.ok) return umamiReason(cur.e);
  // The earlier period or the per-page time failing costs the trend or the time, never the views: an UmamiError is
  // swallowed here; anything else is a bug and must not be mistaken for "analytics is down".
  const swallow = (e: unknown): null => {
    if (e instanceof UmamiError) return null;
    throw e;
  };
  return sourceOk({
    current: parseUmamiPaths(cur.b),
    previous: prev.ok ? parseUmamiPaths(prev.b) : swallow(prev.e),
    time: time.ok ? parseUmamiTime(time.b) : swallow(time.e),
  });
}

// ── Search Console, from our own rows ────────────────────────────────────────────────────────────

/** The path of a stored page URL with the host, query string and fragment removed (SQL; `normalizePagePath` finishes it in JS). */
const PAGE_PATH_SQL = `split_part(split_part(regexp_replace(page, '^[a-z][a-z0-9+.-]*://[^/]+', '', 'i'), '#', 1), '?', 1)`;

/** The stored spellings of a normalised key: with and without a trailing slash (the host-only URL has an empty path). */
export function candidatePaths(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    out.add(k);
    if (k === "/") out.add("");
    else out.add(`${k}/`);
  }
  return [...out];
}

export const GSC_COVERAGE_SQL =
  `SELECT count(DISTINCT date)::int AS days FROM search_gsc_performance
    WHERE property_id = $1 AND simulated = false AND date BETWEEN $2 AND $3`;
export const GSC_PAGES_SQL =
  `SELECT page, sum(clicks)::text AS clicks, sum(impressions)::text AS impressions
     FROM search_gsc_performance
    WHERE property_id = $1 AND simulated = false AND date BETWEEN $2 AND $3 AND ${PAGE_PATH_SQL} = ANY($4::text[])
    GROUP BY page`;
export const GSC_QUERIES_SQL =
  `SELECT page, query, sum(clicks)::text AS clicks, sum(impressions)::text AS impressions
     FROM search_gsc_performance
    WHERE property_id = $1 AND simulated = false AND date BETWEEN $2 AND $3 AND ${PAGE_PATH_SQL} = ANY($4::text[])
    GROUP BY page, query HAVING sum(impressions) >= $5
    LIMIT 5000`;

export async function readGsc(
  tenantId: string, propertyId: string, keys: readonly string[], w: DashboardWindows, days: number,
): Promise<SourceResult<GscData>> {
  if (keys.length === 0) return sourceOk({ currentCovered: true, previousCovered: true, current: new Map(), previous: new Map(), queries: new Map() });
  const want = new Set(keys);
  const cand = candidatePaths(keys);
  const min = gscMinCoverageDays(days);
  try {
    return await withTenants([tenantId], async (c) => {
      const covered = async (win: { from: string; to: string }): Promise<boolean> => {
        const r = await c.query<{ days: number }>(GSC_COVERAGE_SQL, [propertyId, win.from, win.to]);
        return Number(r.rows[0]?.days ?? 0) >= min;
      };
      const agg = async (win: { from: string; to: string }): Promise<Map<string, GscAgg>> => {
        const r = await c.query<{ page: string; clicks: string; impressions: string }>(GSC_PAGES_SQL, [propertyId, win.from, win.to, cand]);
        const m = new Map<string, GscAgg>();
        for (const row of r.rows) {
          const k = normalizePagePath(row.page);
          if (!k || !want.has(k)) continue;
          const cur = m.get(k) ?? { clicks: 0, impressions: 0 };
          cur.clicks += Number(row.clicks);
          cur.impressions += Number(row.impressions);
          m.set(k, cur);
        }
        return m;
      };
      const currentCovered = await covered(w.search.current);
      const previousCovered = await covered(w.search.previous);
      const current = currentCovered ? await agg(w.search.current) : new Map<string, GscAgg>();
      const previous = previousCovered ? await agg(w.search.previous) : new Map<string, GscAgg>();
      const queries = new Map<string, TopQuery[]>();
      if (currentCovered) {
        const r = await c.query<{ page: string; query: string; clicks: string; impressions: string }>(
          GSC_QUERIES_SQL, [propertyId, w.search.current.from, w.search.current.to, cand, 5],
        );
        const by = new Map<string, Map<string, TopQuery>>();
        for (const row of r.rows) {
          const k = normalizePagePath(row.page);
          if (!k || !want.has(k)) continue;
          const perQuery = by.get(k) ?? new Map<string, TopQuery>();
          const cur = perQuery.get(row.query) ?? { query: row.query, clicks: 0, impressions: 0 };
          cur.clicks += Number(row.clicks);
          cur.impressions += Number(row.impressions);
          perQuery.set(row.query, cur);
          by.set(k, perQuery);
        }
        for (const [k, perQuery] of by) queries.set(k, topQueriesOf([...perQuery.values()]));
      }
      return sourceOk({ currentCovered, previousCovered, current, previous, queries });
    }, { modules: ["search"] });
  } catch {
    return sourceFail("search_unavailable");
  }
}

// ── web leads: counts of leads by landing or form page ───────────────────────────────────────────

/**
 * ONLY these three columns leave the table. `attribution->>'landing'` and `'form_page'` are paths (the L2 contract allows no
 * other shape), `created_at` only buckets the row into a period. No id, no name, no address, no note, no consent flag.
 * A removed or erased lead is not counted.
 */
export const LEADS_SQL =
  `SELECT created_at, attribution->>'landing' AS landing, attribution->>'form_page' AS form_page
     FROM agency_leads
    WHERE tenant_id = $1 AND source = 'web' AND web_site_slug = $2
      AND deleted_at IS NULL AND erased_at IS NULL AND attribution IS NOT NULL
      AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
    ORDER BY created_at DESC
    LIMIT 20000`;

export async function readLeads(tenantId: string, tenantSlug: string, keys: readonly string[], w: DashboardWindows): Promise<SourceResult<LeadData>> {
  const want = new Set(keys);
  const from = new Date(startOf(w.traffic.previous.from)).toISOString();
  const to = new Date(endOf(w.traffic.current.to) + 1).toISOString();
  const curStart = startOf(w.traffic.current.from);
  try {
    // No `modules` option: agency_leads is a core table (the same read as agency-web-leads.service.ts#listWebLeads).
    const r = await withTenants([tenantId], (c) =>
      c.query<{ created_at: Date | string; landing: string | null; form_page: string | null }>(LEADS_SQL, [tenantId, tenantSlug, from, to]));
    const current = new Map<string, number>();
    const previous = new Map<string, number>();
    for (const row of r.rows) {
      const at = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
      const bucket = at >= curStart ? current : previous;
      // one lead counts once per page, even when its landing page and its form page are the same page
      const pages = new Set<string>();
      for (const raw of [row.landing, row.form_page]) {
        const k = typeof raw === "string" ? normalizePagePath(raw) : null;
        if (k && want.has(k)) pages.add(k);
      }
      for (const k of pages) bucket.set(k, (bucket.get(k) ?? 0) + 1);
    }
    return sourceOk({ current, previous });
  } catch {
    return sourceFail("leads_unavailable");
  }
}

// ── decay findings ───────────────────────────────────────────────────────────────────────────────

export const DECAY_SQL =
  `SELECT id, page_path, status, reason, detected_at, brief_id
     FROM search_decay_findings
    WHERE property_id = $1 AND status IN ('open','acknowledged','refresh_brief_filed') AND page_path = ANY($2::text[])`;

/** The detector is dark unless the server runs it (V4: `SEARCH_DECAY_ENABLED` exactly "1"). */
export const decayJobEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SEARCH_DECAY_ENABLED === "1";

export async function readDecay(tenantId: string, propertyId: string, keys: readonly string[], enabled: boolean): Promise<SourceResult<DecayData>> {
  if (keys.length === 0) return sourceOk({ enabled, byPath: new Map() });
  try {
    const r = await withTenants([tenantId], (c) =>
      c.query<{ id: string; page_path: string; status: string; reason: string; detected_at: Date | string; brief_id: string | null }>(DECAY_SQL, [propertyId, [...keys]]),
      { modules: ["search"] });
    const byPath = new Map<string, DecayInfo>();
    for (const row of r.rows) {
      byPath.set(row.page_path, {
        findingId: row.id, status: row.status, reason: row.reason,
        detectedAt: new Date(row.detected_at).toISOString(), briefId: row.brief_id,
      });
    }
    return sourceOk({ enabled, byPath });
  } catch {
    return sourceFail("decay_unavailable");
  }
}

// ── the real thing ───────────────────────────────────────────────────────────────────────────────

export interface DbSourcesOptions {
  /** Umami client overrides (tests): settings and a fake fetch. Default = env settings + the global fetch. */
  umami?: UmamiGetOpts;
  decayEnabled?: () => boolean;
}

export class DbDashboardSources implements DashboardSources {
  constructor(private readonly opts: DbSourcesOptions = {}) {}

  async collect(i: SourcesInput): Promise<Sourced> {
    const property = await findProperty(i.tenantId, i.domains);
    const [umami, gsc, leads, decay] = await Promise.all([
      property.ok ? readUmami(property.data.umamiSiteId, i.windows, this.opts.umami ?? {}) : property,
      property.ok ? readGsc(i.tenantId, property.data.id, i.keys, i.windows, i.days) : property,
      readLeads(i.tenantId, i.tenantSlug, i.keys, i.windows),
      property.ok ? readDecay(i.tenantId, property.data.id, i.keys, (this.opts.decayEnabled ?? decayJobEnabled)()) : property,
    ]);
    return { umami, gsc, leads, decay };
  }
}
