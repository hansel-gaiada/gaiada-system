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
import type { GroupReport } from "./groupReport";

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

export interface GroupReportParams {
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
}

/** PV1-06b — the group report (§PV-D19, `GET /api/:rootId/reports/group`). `rootId` is the ACTIVE
 *  company and must be a root: the server answers 403 to anyone but the root owner or
 *  `platform_admin`, and 404 when `rootId` is not a root. Callers branch on `isForbidden` and
 *  `isNotFound` below; neither is a crash. */
export function getGroupReport(rootId: string, userId: string, params: GroupReportParams): Promise<GroupReport> {
  const qs = buildQuery({ periodKind: params.periodKind, start: params.start, end: params.end });
  return platformFetch<GroupReport>(`/api/${rootId}/reports/group?${qs}`, userId);
}

/** `activity` exists only on a roster read (`unit` set, BFF §37): `false` means no fact rows in the
 *  range, and `kpis` is then `[]` (never zeros). Without `unit` the field is absent. */
export interface ReportOverviewScope { scopeRef: string; scopeName: string; kpis: ReportKpi[]; activity?: boolean }
/** `unit` is echoed only when the request carried one. */
export interface ReportOverview { periodKind: ReportPeriodKind; start: string; end: string; unit?: string; scopes: ReportOverviewScope[] }

export interface ReportOverviewParams {
  grain: ReportGrain;
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
  /** Person grain only (BFF §37): the org node id of a unit, whose WHOLE roster is returned. */
  unit?: string;
}

/** Console-landing listing (§6.2 `GET /api/:t/reports/overview`) — used here purely as a SCOPE
 *  PICKER for the project/department grain pages (no single `scopeRef` is known yet). Company
 *  grain never needs it (scopeRef is always the tenant); person grain defaults to self and doesn't
 *  need a picker either, so only project/department pages call this. */
export function getReportOverview(tenantId: string, userId: string, params: ReportOverviewParams): Promise<ReportOverview> {
  const qs = buildQuery({ grain: params.grain, periodKind: params.periodKind, start: params.start, end: params.end, unit: params.unit });
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

export function isNotFound(e: unknown): e is PlatformError {
  return e instanceof PlatformError && e.status === 404;
}
