// SM-25b — GA4 Data API `runReport`: response INTERPRETATION + persistence (design addendum §A12;
// tracker §6ao "owed" / §6x.3 item 5). Same shape and same discipline as gsc-client.ts, transposed onto
// GA4's own wire format and its own bounding facts (sampling instead of a hard row cap; a shorter,
// less-certain freshness lag). See 0061's migration header for the grain/idempotency/provenance
// reasoning shared by both tables — restated here only where GA4 genuinely differs.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../../db";
import { config } from "../../../config";
import { ga4RunReport } from "./api-client";
import type { FetchImpl } from "./token-endpoint-client";
import { GoogleConnectionNotLinkedError, GooglePropertyNotBoundError } from "./errors";
import { getGoogleConnection, resolvePropertyConnection } from "./oauth";
import { clampEndDateToFreshnessLag, isoDateDaysAgo, isRowDateWithinWindow } from "./freshness";

/** GA4's intraday data is documented as provisional for roughly the current processing day; this is
 *  deliberately smaller than GSC's 3-day lag (GA4 is closer to real-time reporting) but still nonzero —
 *  a "today" pull would otherwise persist a partial day exactly as GSC's would. UNVERIFIED against a
 *  real property (SM-41G); the documented figure, not an observed one. */
export const GA4_FRESHNESS_LAG_DAYS = 2;

const GA4_DEFAULT_WINDOW_DAYS = 7;

/** Fixed request shape (see gsc-client.ts's identical reasoning for GSC_DIMENSIONS): GA4's response
 *  carries dimension/metric VALUES only, positionally aligned to `dimensionHeaders`/`metricHeaders`,
 *  which echo back exactly what THIS file requested — widening one array without the other silently
 *  mislabels every row. `sessionDefaultChannelGroup` is GA4's own short, bounded default-channel-group
 *  taxonomy (0061's own reasoning for why this table needs no content-hash idempotency key). */
const GA4_DIMENSIONS = ["date", "sessionDefaultChannelGroup"] as const;
const GA4_METRICS = ["sessions", "engagedSessions", "conversions", "totalRevenue"] as const;

interface Ga4RunReportResponse {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type?: string }>;
  rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }>;
  rowCount?: number;
  metadata?: { currencyCode?: string; timeZone?: string; samplingMetadatas?: Array<{ samplesReadCount?: string; samplingSpaceSize?: string }> };
}

/** GA4 renders EVERY metric value as a string over the wire (ga4-run-report.ts fixture's own
 *  documented shape) — `Number(...)` on an absent/malformed value must never silently become NaN
 *  persisted to a numeric column, so this always falls back to 0 rather than propagate a NaN. */
function metricNumber(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export interface PullGa4MetricsParams {
  tenantId: string;
  propertyId: string;
  /** GA4 numeric property id, WITHOUT the "properties/" prefix (api-client.ts's own convention). */
  ga4PropertyId: string;
  endDate?: string;
  startDate?: string;
  fetchImpl?: FetchImpl;
}

export interface Ga4PullOutcome {
  propertyId: string;
  status: "pulled";
  startDate: string;
  requestedEndDate: string;
  effectiveEndDate: string;
  clampedForFreshness: boolean;
  freshnessLagDays: number;
  rowsUpserted: number;
  malformedRowsSkipped: number;
  /** SM-64 (§A14 echo-validation, axis: date window) — rows whose OWN `date` (after the `YYYYMMDD →
   *  ISO` normalization) fell outside `[startDate, effectiveEndDate]`, the range actually requested.
   *  Skipped before the UPSERT, counted, never persisted unflagged. Orthogonal to `sampled` below:
   *  `sampled` is an ESTIMATION fact (figures extrapolated from a subset of sessions); this is a
   *  COMPLETENESS fact (the day had not finished settling) — an unsampled row dated today is
   *  `sampled: false` and still fully misleading, which is exactly why this check does not defer to it. */
  rowsOutsideRangeSkipped: number;
  /** §A12.2/module standing rule (0061's file header): true iff GA4's response carried
   *  `metadata.samplingMetadatas` — a REPORT-level fact, denormalized onto every row this pull wrote.
   *  Never silently averaged away; a reader of this outcome (or of the persisted rows' own `sampled`
   *  column) knows this pull's sessions/conversions figures are an ESTIMATE, not an exact count. */
  sampled: boolean;
  provider: "google_analytics";
  connectionId: string;
  simulated: boolean;
}

/** Pull + persist GA4 sessions/conversions for one property, over one explicit date range — the unit
 *  search.controller.ts's `POST engagements/:id/ga4-pull` calls. Same "not wired into the scheduler"
 *  posture as gsc-client.ts's pull, for the identical reason. */
export async function pullGa4MetricsForProperty(p: PullGa4MetricsParams): Promise<Ga4PullOutcome> {
  const connectionId = await resolvePropertyConnection(p.tenantId, p.propertyId, "google_analytics");
  if (!connectionId) throw new GooglePropertyNotBoundError(p.propertyId, "google_analytics");
  const connection = await getGoogleConnection(p.tenantId, connectionId);
  if (!connection) throw new GoogleConnectionNotLinkedError(connectionId, "not_found");
  const simulated = !connection.issuerIsGoogle;

  const clamp = clampEndDateToFreshnessLag(p.endDate, GA4_FRESHNESS_LAG_DAYS);
  const startDate = p.startDate ?? isoDateDaysAgo(GA4_FRESHNESS_LAG_DAYS + GA4_DEFAULT_WINDOW_DAYS - 1);

  const res = await ga4RunReport<Ga4RunReportResponse>({
    tenantId: p.tenantId,
    connectionId,
    propertyId: p.ga4PropertyId,
    body: {
      dateRanges: [{ startDate, endDate: clamp.effectiveEndDate }],
      dimensions: GA4_DIMENSIONS.map((name) => ({ name })),
      metrics: GA4_METRICS.map((name) => ({ name })),
    },
    fetchImpl: p.fetchImpl,
  });

  const sampled = Array.isArray(res.data.metadata?.samplingMetadatas) && res.data.metadata!.samplingMetadatas!.length > 0;
  const dimHeaders = res.data.dimensionHeaders?.map((h) => h.name) ?? [];
  const dateIdx = dimHeaders.indexOf("date");
  const channelIdx = dimHeaders.indexOf("sessionDefaultChannelGroup");
  const metricHeaders = res.data.metricHeaders?.map((h) => h.name) ?? [];
  const idxOf = (name: string) => metricHeaders.indexOf(name);

  let malformedRowsSkipped = 0;
  let rowsOutsideRangeSkipped = 0;
  const parsedRows: Array<{ date: string; channelGroup: string; sessions: number; engagedSessions: number; conversions: number; totalRevenue: number | null }> = [];
  for (const row of res.data.rows ?? []) { // ABSENT (not []) is GA4's own "no data" shape
    const dims = row.dimensionValues ?? [];
    const date = dateIdx >= 0 ? dims[dateIdx]?.value : undefined;
    if (!date) {
      malformedRowsSkipped++; // a row with no date dimension is not a fact worth guessing at (§4i)
      continue;
    }
    // GA4's date dimension is documented as `YYYYMMDD` with no separators — normalized to ISO so it
    // matches search_gsc_performance's `date` column shape and any date-range SQL predicate. Like
    // every other wire-shape fact in this file, this is the DOCUMENTED shape, not one observed
    // against a real property (SM-41G); the `date.length === 8` guard means an already-ISO or
    // otherwise-shaped value passes through unchanged rather than being mangled by a wrong assumption.
    const normalizedDate = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
    // SM-64 (§A14, axis: date-window echo) — re-verify the RETURNED row's own date, AFTER normalization,
    // against the range actually requested, before it ever reaches the UPSERT. Orthogonal to `sampled`
    // (see the outcome field's own comment): a row can be unsampled and still outside this window.
    if (!isRowDateWithinWindow(normalizedDate, startDate, clamp.effectiveEndDate)) {
      rowsOutsideRangeSkipped++;
      continue;
    }
    const channelGroup = (channelIdx >= 0 ? dims[channelIdx]?.value : undefined) || "(not set)";
    const metrics = row.metricValues ?? [];
    const totalRevenueIdx = idxOf("totalRevenue");
    parsedRows.push({
      date: normalizedDate,
      channelGroup,
      sessions: metricNumber(metrics[idxOf("sessions")]?.value),
      engagedSessions: metricNumber(metrics[idxOf("engagedSessions")]?.value),
      conversions: metricNumber(metrics[idxOf("conversions")]?.value),
      // Absent metric header (a property with no revenue/ecommerce events may not report this one) is
      // NULL, never 0 — "no revenue configured" and "zero revenue this period" are different facts.
      totalRevenue: totalRevenueIdx >= 0 ? metricNumber(metrics[totalRevenueIdx]?.value) : null,
    });
  }

  const rowsUpserted = await withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      let n = 0;
      for (const row of parsedRows) {
        await c.query(
          `INSERT INTO search_ga4_metrics
             (id, tenant_id, property_id, connection_id, date, channel_group,
              sessions, engaged_sessions, conversions, total_revenue, sampled, simulated, origin_site, fetched_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
           ON CONFLICT (tenant_id, property_id, date, channel_group) DO UPDATE SET
             sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
             conversions = EXCLUDED.conversions, total_revenue = EXCLUDED.total_revenue,
             connection_id = EXCLUDED.connection_id,
             -- Same atomic-together law as gsc-client.ts: sampled + simulated travel with the payload
             -- they describe, in the SAME statement, never one alone.
             sampled = EXCLUDED.sampled, simulated = EXCLUDED.simulated, fetched_at = now(), updated_at = now()`,
          [
            newId(), p.tenantId, p.propertyId, connectionId, row.date, row.channelGroup,
            row.sessions, row.engagedSessions, row.conversions, row.totalRevenue, sampled, simulated,
            config.originSite,
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
    clampedForFreshness: clamp.clamped, freshnessLagDays: GA4_FRESHNESS_LAG_DAYS,
    rowsUpserted, malformedRowsSkipped, rowsOutsideRangeSkipped, sampled,
    provider: "google_analytics", connectionId, simulated,
  };
}
