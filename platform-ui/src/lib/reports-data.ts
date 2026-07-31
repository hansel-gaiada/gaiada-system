import "server-only";
// TR-17 — the typed BFF client for the tracker/reporting read surface (§6.2).
//
// Deliberately a SEPARATE module from lib/reports.ts: that file carries the
// canonical `ReportDocument` contract + pure bucketing helpers and is
// intentionally NOT `"server-only"` (its header comment explains why — the
// chart kit imports it at interaction time from client components). Adding a
// server-only fetcher there would break every chart's runtime import. This
// file is the one place the fetch actually happens.
import { platformFetch, PlatformError } from "./platform";
import type { ReportDocument, ReportGrain, ReportKpi, ReportPeriodKind } from "./reports";

export { PlatformError };

export interface ReportDocumentParams {
  grain: ReportGrain;
  scopeRef: string;
  periodKind: ReportPeriodKind;
  start: string;
  end: string; // always sent; the controller ignores it for non-custom kinds (§6.2)
  servedTenant?: string; // department grain only
}

function buildQuery(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, v);
  return qs.toString();
}

/** THE read (§6.2 `GET /api/:t/reports/document`). Sealed-period storage doesn't exist yet
 *  (TR-14/TR-15 land the periods endpoints) — every read is live-computed, so `header.sealed` is
 *  always `false` from a real backend today; DEMO_MODE exercises the sealed branch so the UI isn't
 *  waiting on that ticket to prove it renders. */
export function getReportDocument(tenantId: string, userId: string, params: ReportDocumentParams): Promise<ReportDocument> {
  const qs = buildQuery({
    grain: params.grain, scopeRef: params.scopeRef, periodKind: params.periodKind,
    start: params.start, end: params.end, servedTenant: params.servedTenant,
  });
  return platformFetch<ReportDocument>(`/api/${tenantId}/reports/document?${qs}`, userId);
}

export interface ReportOverviewScope { scopeRef: string; scopeName: string; kpis: ReportKpi[] }
export interface ReportOverview { periodKind: ReportPeriodKind; start: string; end: string; scopes: ReportOverviewScope[] }

export interface ReportOverviewParams {
  grain: ReportGrain;
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
}

/** Console-landing listing (§6.2 `GET /api/:t/reports/overview`) — used here purely as a SCOPE
 *  PICKER for the project/department grain pages (no single `scopeRef` is known yet). Company
 *  grain never needs it (scopeRef is always the tenant); person grain defaults to self and doesn't
 *  need a picker either, so only project/department pages call this. */
export function getReportOverview(tenantId: string, userId: string, params: ReportOverviewParams): Promise<ReportOverview> {
  const qs = buildQuery({ grain: params.grain, periodKind: params.periodKind, start: params.start, end: params.end });
  return platformFetch<ReportOverview>(`/api/${tenantId}/reports/overview?${qs}`, userId);
}

/** §15 ruling ③: the shared `http-error.filter.ts` flattens every 422 to `{error, field}` — the
 *  `maxDays` the blueprint's prose describes never reaches the wire, so it is mirrored here as a
 *  frontend constant instead (kept in `lib/reports.ts` as `REPORT_MAX_CUSTOM_DAYS`, re-exported by
 *  name here so callers don't have to know which file owns it). */
export function isRangeTooLarge(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 422 && e.message === "range_too_large";
}

export function isForbidden(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 403;
}
