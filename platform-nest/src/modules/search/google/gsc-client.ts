// SM-25b — Search Console Search Analytics: response INTERPRETATION + persistence (design addendum
// §A12; tracker §6ao "owed" / §6x.3 item 5). api-client.ts (SM-25a) already hands back a parsed JSON
// envelope over an authorized, refresh-on-401, quota-bounded socket — this file's job starts there:
// turning `{rows:[{keys,clicks,impressions,ctr,position}]}` into rows worth keeping, and keeping them
// exactly once. Mirrors rank.ts/backlinks.ts's shape (resolve → dispatch/fetch → persist → return an
// outcome the controller echoes), transposed onto the THIRD egress class (§A12.1: client-private, $0,
// per-client OAuth — no dispatchProviderOp, no search_data_cache, ever; see 0061's file header for the
// two prohibitions restated at the schema level).
//
// ── GRAIN + IDEMPOTENCY + FRESHNESS-LAG + SAMPLING: all explained once, in 0061's migration header,
// not re-argued here. This file is what MAKES those promises true, so the short version: dimensions
// are fixed at [date, query, page, device] (never caller-widened — Google's response has no field
// names, only positional `keys[]` aligned to the REQUEST's dimensions array, so widening the dimension
// list here without also widening the parser below would silently mislabel every row); the UNIQUE
// (tenant_id, property_id, row_hash) constraint (0061) is what an UPSERT resolves against, so a
// concurrent re-pull race is a database-level guarantee, not a check-then-insert race in this file;
// `startDate`/`endDate` never reach inside the freshness-lag window (freshness.ts); `simulated` is
// stamped from the owning CONNECTION's issuer-honesty flag, never from anything computed in this file.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { searchConsoleQuery } from "./api-client";
import type { FetchImpl } from "./token-endpoint-client";
import { GoogleConnectionNotLinkedError, GooglePropertyNotBoundError } from "./errors";
import { getGoogleConnection, resolvePropertyConnection } from "./oauth";
import { clampEndDateToFreshnessLag, isoDateDaysAgo, isRowDateWithinWindow } from "./freshness";

// ── policy defaults (local consts, NOT config.ts — see the ticket's file-ownership note: config.ts is
// held by a concurrent agent for SM-61). Same convention as backlinks.ts's LOST_SPIKE_ABSOLUTE/RATIO:
// small, named, documented constants rather than a config seam this ticket has no mandate to add. ────

/** GSC's own documented data-freshness lag (2-3 days; the conservative end is used so a "partial day"
 *  row can never be requested at all — see freshness.ts's file header for why clamping beats flagging).
 *  UNVERIFIED against a real property (SM-41G) — this is the documented figure, not an observed one. */
export const GSC_FRESHNESS_LAG_DAYS = 3;

/** Default lookback window when a caller supplies no `startDate` — a week ending at the lag boundary,
 *  which is small enough that a routine "catch me up" pull stays cheap under GSC_DEFAULT_ROW_LIMIT. */
const GSC_DEFAULT_WINDOW_DAYS = 7;

/** Google's OWN documented per-request row cap for searchAnalytics.query. Never exceeded even if a
 *  caller asks for more — this is a vendor ceiling, not a policy choice. */
export const GSC_MAX_ROW_LIMIT = 25000;

/** The default per-request row cap this module actually uses — deliberately far below Google's own
 *  25 000 ceiling. The ticket's own instruction was "think about row volume before committing to a
 *  grain"; this is the lever that keeps a single pull's cost (rows to parse, rows to upsert, bytes over
 *  the wire) bounded for the common case, while GSC_MAX_ROW_LIMIT remains reachable for a caller who
 *  explicitly wants more. */
export const GSC_DEFAULT_ROW_LIMIT = 5000;

/** Safety cap on PAGES fetched per pull call (each page costs one `rowLimit`-sized request). Bounds
 *  the worst case (a very high-traffic property whose query x page x device combinations exceed one
 *  page) to a fixed number of round trips rather than an unbounded loop — the row-volume containment
 *  the ticket asks for is enforced HERE, not by hoping properties stay small. Hitting the cap while the
 *  last page was still full sets `truncated: true` in the outcome rather than silently under-reporting;
 *  a caller that needs more can re-run with a later startRow via a follow-up pull covering a
 *  narrower/later date range instead of one unbounded request. */
export const GSC_DEFAULT_MAX_PAGES = 4;

const GSC_DEVICES = new Set(["DESKTOP", "MOBILE", "TABLET"]);

/** The canonical GSC row shape THIS file depends on — `keys[]` is positional, aligned to the REQUEST's
 *  own `dimensions` array (Google's documented shape: no field names travel in the response). See the
 *  fixture's own header (testing/vendor-sandbox/fixtures/google/gsc-search-analytics.ts) for the same
 *  fact stated from the sandbox's side. */
interface GscQueryResponse {
  rows?: Array<{ keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }>;
  responseAggregationType?: string;
}

/** THE dimension order this file requests and parses — fixed, not caller-configurable, because
 *  widening it here without widening the positional parser below would silently mislabel every field
 *  of every row (see the file header). If a future ticket needs `country` or `searchAppearance`, it
 *  must extend BOTH this array and parseRow together, in the same diff. */
const GSC_DIMENSIONS = ["date", "query", "page", "device"] as const;

function parseRow(keys: string[] | undefined): { date: string; query: string; page: string; device: string } | null {
  const [date, query, page, deviceRaw] = keys ?? [];
  if (!date || query === undefined || page === undefined) return null; // malformed row — see below
  const device = (deviceRaw ?? "DESKTOP").toUpperCase();
  return { date, query, page, device: GSC_DEVICES.has(device) ? device : "DESKTOP" };
}

/** sha256 hex of the canonical tuple — the ONLY thing the 0061 UNIQUE constraint keys on (see its file
 *  header for why: query/page are unbounded-length, a hash keeps the unique index small and fixed-
 *  width regardless of how long a query string or URL gets, exactly like search-audit.ts's
 *  hashReport()). Order and separator are fixed and never change without a new migration — this value
 *  IS the idempotency key on disk. */
export function gscRowHash(propertyId: string, date: string, query: string, page: string, device: string): string {
  return createHash("sha256").update(`${propertyId}|${date}|${query}|${page}|${device}`).digest("hex");
}

export interface PullGscPerformanceParams {
  tenantId: string;
  propertyId: string;
  siteUrl: string;
  /** Omit for "as much as is safe" (the lag boundary itself, `clampedForFreshness: false`). */
  endDate?: string;
  /** Omit for the default `GSC_DEFAULT_WINDOW_DAYS`-day lookback ending at the effective end date. */
  startDate?: string;
  rowLimit?: number;
  maxPages?: number;
  fetchImpl?: FetchImpl;
}

export interface GscPullOutcome {
  propertyId: string;
  status: "pulled";
  startDate: string;
  requestedEndDate: string;
  effectiveEndDate: string;
  /** §A4.7 duty, stated as data: true iff the caller's requested end date reached into the freshness
   *  lag window and was pulled back — never a silent substitution (freshness.ts). */
  clampedForFreshness: boolean;
  freshnessLagDays: number;
  rowsUpserted: number;
  malformedRowsSkipped: number;
  /** SM-64 (§A14 echo-validation, axis: date window) — rows a page returned whose OWN `date` fell
   *  outside `[startDate, effectiveEndDate]`, the range actually requested. Skipped before the UPSERT,
   *  never persisted unflagged and never silently dropped — this counter IS the disclosure. Loss is
   *  bounded deferral: the idempotent UPSERT re-fetches that date once it leaves the lag window. */
  rowsOutsideRangeSkipped: number;
  /** SM-64 (§A14 echo-validation, axis: page-cap echo) — rows an over-full page returned BEYOND
   *  `rowLimit`. Sliced off before the parse loop (offsets past an over-full page are meaningless, so
   *  paging stops rather than continuing) and counted here rather than persisted whole — persisting
   *  "what was asked for", not "everything the vendor sent". */
  rowsOverLimitSkipped: number;
  pagesFetched: number;
  /** True iff GSC_DEFAULT_MAX_PAGES (or the caller's override) was hit while the last page was still
   *  exactly `rowLimit` rows — i.e. more data may exist that this call did not fetch. Never silently
   *  swallowed: a caller reading `truncated: true` with a full row set knows the count is a floor. Also
   *  set (and paging stopped) the moment a single page returns MORE than `rowLimit` rows (SM-64) — past
   *  an over-full page, `startRow = page × rowLimit` offset arithmetic is no longer meaningful. */
  truncated: boolean;
  provider: "google_search_console";
  connectionId: string;
  simulated: boolean;
}

/** Pull + persist Search Console performance for one property, over one explicit date range — the unit
 *  search.controller.ts's `POST engagements/:id/gsc-pull` calls. NOT wired into pull-scheduler.ts (out
 *  of this ticket's file ownership, and the ticket's own framing — "scope-driven ingestion, flows own
 *  zero routes" — describes THIS route being the only entry point, not a background cadence). */
export async function pullGscPerformanceForProperty(p: PullGscPerformanceParams): Promise<GscPullOutcome> {
  const connectionId = await resolvePropertyConnection(p.tenantId, p.propertyId, "google_search_console");
  if (!connectionId) throw new GooglePropertyNotBoundError(p.propertyId, "google_search_console");
  const connection = await getGoogleConnection(p.tenantId, connectionId);
  if (!connection) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  // §A12.2's audience-not-label rule, transposed onto this table (0061's own comment): the CONNECTION's
  // recorded issuer-honesty flag is the stamp, stamped at THIS write, never re-derived from current
  // config or from anything computed in this file.
  const simulated = !connection.issuerIsGoogle;

  const clamp = clampEndDateToFreshnessLag(p.endDate, GSC_FRESHNESS_LAG_DAYS);
  const windowDays = GSC_DEFAULT_WINDOW_DAYS;
  const startDate = p.startDate ?? isoDateDaysAgo(GSC_FRESHNESS_LAG_DAYS + windowDays - 1);
  const rowLimit = Math.min(Math.max(1, p.rowLimit ?? GSC_DEFAULT_ROW_LIMIT), GSC_MAX_ROW_LIMIT);
  const maxPages = Math.max(1, p.maxPages ?? GSC_DEFAULT_MAX_PAGES);

  let pagesFetched = 0;
  let truncated = false;
  const parsedRows: Array<{ date: string; query: string; page: string; device: string; clicks: number; impressions: number; ctr: number | null; position: number | null }> = [];
  let malformedRowsSkipped = 0;
  let rowsOutsideRangeSkipped = 0;
  let rowsOverLimitSkipped = 0;

  for (let page = 0; page < maxPages; page++) {
    const startRow = page * rowLimit;
    const res = await searchConsoleQuery<GscQueryResponse>({
      tenantId: p.tenantId,
      connectionId,
      siteUrl: p.siteUrl,
      startDate,
      endDate: clamp.effectiveEndDate,
      dimensions: [...GSC_DIMENSIONS],
      rowLimit,
      startRow,
      fetchImpl: p.fetchImpl,
    });
    pagesFetched++;
    const rawRows = res.data.rows ?? []; // ABSENT (not []) is Google's own "no data" shape — treated identically
    // SM-64 (§A14, axis: GSC rowLimit echo) — an over-full page is sliced BEFORE the parse loop, never
    // parsed/persisted whole: persist what was asked for, not everything the vendor sent. Offsets past an
    // over-full page are meaningless (`startRow = page × rowLimit` assumed every prior page was exactly
    // `rowLimit`), so paging stops here rather than continuing to a `startRow` that no longer lines up.
    const overLimit = rawRows.length > rowLimit;
    const rows = overLimit ? rawRows.slice(0, rowLimit) : rawRows;
    if (overLimit) {
      rowsOverLimitSkipped += rawRows.length - rowLimit;
      truncated = true;
    }
    for (const r of rows) {
      const parsed = parseRow(r.keys);
      if (!parsed) {
        malformedRowsSkipped++; // a row whose keys don't even carry date/query/page is not a partial
        continue; // fact worth guessing at — skipped, never invented (§4i), and counted so it is visible
      }
      // SM-64 (§A14, axis: date-window echo) — re-verify the RETURNED row's own date against the range
      // actually requested, before it ever reaches the UPSERT. The clamp only governs the outbound
      // request; this is the response-side half (freshness.ts's SM-64 amendment).
      if (!isRowDateWithinWindow(parsed.date, startDate, clamp.effectiveEndDate)) {
        rowsOutsideRangeSkipped++;
        continue;
      }
      parsedRows.push({
        ...parsed,
        clicks: Number.isFinite(r.clicks) ? Number(r.clicks) : 0,
        impressions: Number.isFinite(r.impressions) ? Number(r.impressions) : 0,
        ctr: typeof r.ctr === "number" ? r.ctr : null,
        position: typeof r.position === "number" ? r.position : null,
      });
    }
    if (overLimit) break; // stop paging — see comment above
    if (rows.length < rowLimit) break; // fewer than a full page ⇒ that was everything Google had
    if (page === maxPages - 1) truncated = true; // still full at the safety cap ⇒ more may exist
  }

  const rowsUpserted = await withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      let n = 0;
      for (const row of parsedRows) {
        const rowHash = gscRowHash(p.propertyId, row.date, row.query, row.page, row.device);
        await c.query(
          `INSERT INTO search_gsc_performance
             (id, tenant_id, property_id, connection_id, date, query, page, device,
              clicks, impressions, ctr, position, row_hash, simulated, origin_site, fetched_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now(), now())
           ON CONFLICT (tenant_id, property_id, row_hash) DO UPDATE SET
             clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr,
             position = EXCLUDED.position, connection_id = EXCLUDED.connection_id,
             -- Provenance travels with the payload it now describes, atomically, per 0061's own law —
             -- a live re-pull over a formerly-simulated row overwrites BOTH together, never one alone.
             simulated = EXCLUDED.simulated, fetched_at = now(), updated_at = now()`,
          [
            newId(), p.tenantId, p.propertyId, connectionId, row.date, row.query, row.page, row.device,
            row.clicks, row.impressions, row.ctr, row.position, rowHash, simulated, config.originSite,
          ],
        );
        n++;
      }
      return n;
    },
    { modules: ["search"] },
  );

  return {
    propertyId: p.propertyId, status: "pulled", startDate,
    requestedEndDate: clamp.requestedEndDate, effectiveEndDate: clamp.effectiveEndDate,
    clampedForFreshness: clamp.clamped, freshnessLagDays: GSC_FRESHNESS_LAG_DAYS,
    rowsUpserted, malformedRowsSkipped, rowsOutsideRangeSkipped, rowsOverLimitSkipped, pagesFetched, truncated,
    provider: "google_search_console", connectionId, simulated,
  };
}

export interface GscTopQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

/** Aggregate the ALREADY-PERSISTED search_gsc_performance rows for one property + date range into a
 *  per-query total — never a fresh Google call (this reads OUR OWN table, exactly like every other
 *  "top N" surface in this module). §A4.7 disposition: this IS an aggregate (sums clicks/impressions
 *  across rows, and averages `position` weighted by impressions), so per the exec-rollup precedent
 *  (search/index.ts's search.rank.top10 comment) it is FILTERED to real data by default rather than
 *  badged per-row — blending simulated demo rows into a "top queries" total that feeds a real
 *  keyword-import decision would be the §4d class this module keeps closing. `includeSimulated: true`
 *  is the explicit, named override for a dev/demo view — never the default. */
export async function topGscQueries(args: {
  tenantId: string;
  propertyId: string;
  startDate: string;
  endDate: string;
  limit?: number;
  includeSimulated?: boolean;
}): Promise<GscTopQuery[]> {
  const limit = Math.min(Math.max(1, args.limit ?? 100), 1000);
  const rows = await withTenants(
    [args.tenantId],
    (c) =>
      c.query<{ query: string; clicks: string; impressions: string; ctr: number | null; position: number | null }>(
        `SELECT query,
                SUM(clicks)::bigint AS clicks,
                SUM(impressions)::bigint AS impressions,
                CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::numeric / SUM(impressions) ELSE NULL END AS ctr,
                CASE WHEN SUM(impressions) > 0
                     THEN SUM(position * impressions) / SUM(impressions)
                     ELSE NULL END AS position
           FROM search_gsc_performance
          WHERE property_id = $1 AND date >= $2 AND date <= $3
            AND ($4::boolean OR simulated = false)
          GROUP BY query
          ORDER BY SUM(clicks) DESC, SUM(impressions) DESC
          LIMIT $5`,
        [args.propertyId, args.startDate, args.endDate, args.includeSimulated === true, limit],
      ),
    { modules: ["search"] },
  );
  return rows.rows.map((r) => ({
    query: r.query, clicks: Number(r.clicks), impressions: Number(r.impressions),
    ctr: r.ctr === null ? null : Number(r.ctr), position: r.position === null ? null : Number(r.position),
  }));
}
