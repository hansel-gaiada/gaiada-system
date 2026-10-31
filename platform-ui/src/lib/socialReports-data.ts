import "server-only";
// SCP-5a (BFF §63.18), SCP-5 W5-A4 (§63.24): the report pages' readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty list.
// A single report that does not exist is a real answer, so it is `ok` with `null`, never a refusal.
import { platformFetch, PlatformError } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asReportDetail, asReportList, type SocialReportDetail, type SocialReportRow } from "./socialReports";
import { asRunList, type RunListItem } from "./socialReportRuns";
import { asReportRules, type ReportRules } from "./socialReportKinds";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET reports?engagementId=&status=&period=&kind=` (`social_report` · `read`): the reports, newest first, at most 500. */
export function getSocialReports(userId: string, tenantId: string, q: { engagementId?: string | null; status?: string | null; period?: string | null; kind?: string | null } = {}): Promise<ReadResult<SocialReportRow[]>> {
  const qs = new URLSearchParams();
  if (q.kind) qs.set("kind", q.kind);
  if (q.engagementId) qs.set("engagementId", q.engagementId);
  if (q.status) qs.set("status", q.status);
  if (q.period) qs.set("period", q.period);
  const tail = qs.toString();
  return readResult(platformFetch<unknown>(`${base(tenantId)}/reports${tail ? `?${tail}` : ""}`, userId).then(asReportList));
}

/** `GET reports/:id`: the report with its notes, plan, `simulated`, the server's `canApprove` and `canDeliver`, and the document. A 404 is `ok` with `null` ("no such report"). */
export async function getSocialReport(userId: string, tenantId: string, reportId: string): Promise<ReadResult<SocialReportDetail | null>> {
  try {
    return { kind: "ok", data: asReportDetail(await platformFetch<unknown>(`${base(tenantId)}/reports/${encodeURIComponent(reportId)}`, userId)) };
  } catch (err) {
    if (err instanceof PlatformError && (err.status === 404 || (err.status === 400 && /_invalid$/.test(err.message)))) return { kind: "ok", data: null };
    return readResult(Promise.reject(err));
  }
}

/** `GET reports/generate`: the last 30 days' runs (the company's for the four, one's own for anyone else). */
export function getReportRuns(userId: string, tenantId: string): Promise<ReadResult<RunListItem[]>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/reports/generate`, userId).then(asRunList));
}

/** `GET rules` (`social_post` · `read`): the company's rules, of which the report pages read which kinds are on, how each is drafted, the fiscal year and the ideas' metric rule. */
export function getReportRules(userId: string, tenantId: string): Promise<ReadResult<ReportRules>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/rules`, userId).then(asReportRules));
}
