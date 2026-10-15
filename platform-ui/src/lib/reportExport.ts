// DW-4k — the pure parts of exporting a report document (client-safe: no server-only imports).
//
// The backend (`POST /api/:t/reports/export`, BFF contract 15a) builds exactly one file for exactly one
// `ReportDocument` and stores it as a job; `GET .../exports/:jobId/download` returns the bytes and re-runs
// the document-read authorization every time. The browser cannot call either (the session token is
// server-side), so a server action creates the job and `app/api/reports/exports/[jobId]/route.ts` proxies
// the download. This module holds what the action, the route and the control all agree on.
import type { ReportGrain, ReportHeader, ReportPeriodKind } from "./reports";

export type ReportExportFormat = "pdf" | "xlsx" | "csv";

export const REPORT_EXPORT_FORMATS: readonly ReportExportFormat[] = ["pdf", "xlsx", "csv"];

const GRAINS: readonly string[] = ["person", "project", "department", "company"];
const PERIOD_KINDS: readonly string[] = ["day", "week", "month", "quarter", "semester", "year", "custom"];

export function isReportExportFormat(v: unknown): v is ReportExportFormat {
  return typeof v === "string" && (REPORT_EXPORT_FORMATS as readonly string[]).includes(v);
}

/** What the export action sends to the platform. Always the document the page shows, never anything typed. */
export interface ReportExportRequest {
  grain: ReportGrain;
  scopeRef: string;
  periodKind: ReportPeriodKind;
  start: string;
  end: string;
  format: ReportExportFormat;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape check for the action's input (a server action's arguments are untrusted, whatever the types say). */
export function isReportExportRequest(v: unknown): v is ReportExportRequest {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.grain === "string" && GRAINS.includes(r.grain) &&
    typeof r.scopeRef === "string" && r.scopeRef.length > 0 && r.scopeRef.length <= 200 &&
    typeof r.periodKind === "string" && PERIOD_KINDS.includes(r.periodKind) &&
    typeof r.start === "string" && DATE_RE.test(r.start) &&
    typeof r.end === "string" && DATE_RE.test(r.end) &&
    isReportExportFormat(r.format)
  );
}

/** The export request for the document a page rendered: same grain, scope and period as its header. */
export function exportRequestFor(header: ReportHeader, format: ReportExportFormat): ReportExportRequest {
  return {
    grain: header.grain,
    scopeRef: header.scopeRef,
    periodKind: header.periodKind,
    start: header.periodStart,
    end: header.periodEnd,
    format,
  };
}

/** The job id from the create answer. The controller answers `{jobId}` (BFF 15a documents `{id, status,
 *  filename}`); both are read, and anything that is not a plausible token is refused. */
export function jobIdFrom(answer: unknown): string | null {
  if (!answer || typeof answer !== "object") return null;
  const a = answer as { jobId?: unknown; id?: unknown };
  const id = typeof a.jobId === "string" ? a.jobId : typeof a.id === "string" ? a.id : null;
  return id && isPlausibleJobId(id) ? id : null;
}

/** A job id is a uuid. Anything else (a `..`, a slash, a query) never reaches the platform. */
export function isPlausibleJobId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Where the browser fetches an export's bytes. */
export function exportDownloadHref(jobId: string): string {
  return `/api/reports/exports/${encodeURIComponent(jobId)}`;
}

/** Words for a refusal the platform did not explain itself. The platform's own sentence wins where it sent one. */
export function exportRefusalMessage(status: number): string {
  if (status === 401) return "Your session has expired. Sign in again, then export the report once more.";
  if (status === 403) return "You do not have permission to export this report. It is only available to people who can read it.";
  if (status === 404) return "This export cannot be found. It may have been removed; export the report again.";
  if (status === 400) return "That is not a valid export link.";
  if (status === 422) return "This report cannot be exported for that period.";
  return "The platform could not produce the file just now. Try again in a moment.";
}

/** The file name a `Content-Disposition` header carries (RFC 5987 `filename*` first), or null. */
export function filenameFromDisposition(disposition: string | null | undefined): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(disposition) ?? /filename\s*=\s*([^;]+)/i.exec(disposition);
  return plain ? plain[1].trim() || null : null;
}

/** The note beside the Export control. The artifact of an unsealed or custom period is marked on the file
 *  itself (`AD HOC · UNSEALED`); saying so before the click means nobody files it as the record by mistake. */
export const UNSEALED_EXPORT_NOTE = 'This period is not sealed, so the file is marked "AD HOC · UNSEALED".';

/** Why a served-company slice is not exported: `POST reports/export` carries no `servedTenant`. */
export const SERVED_SLICE_EXPORT_NOTE =
  "Export is not available for a served-company slice. Open the whole department report to export it.";
