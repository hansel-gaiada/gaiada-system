"use server";
// DW-4k — step one of exporting a report: create the export job (`POST /api/:t/reports/export`).
//
// Step two is the browser fetching `/api/reports/exports/:jobId`, the route handler that proxies the
// download with the caller's session (the token is server-side, so the browser cannot call the platform).
//
// NOTHING here decides who may export. The platform authorizes the export with the same check as the
// document read (BFF 15a), and re-checks on every download; a refusal comes back as it was sent: the
// platform's own status and sentence, never turned into a success. The company is the caller's ACTIVE
// company (same as every staff page), never a value from the client.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { exportRefusalMessage, isReportExportRequest, jobIdFrom, type ReportExportRequest } from "./reportExport";

export type CreateReportExportResult =
  | { ok: true; jobId: string }
  | { ok: false; status: number; error: string };

export async function createReportExport(request: ReportExportRequest): Promise<CreateReportExportResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, status: 401, error: exportRefusalMessage(401) };

  // A server action's argument is untrusted input whatever its type says; only the six known fields go on.
  if (!isReportExportRequest(request)) return { ok: false, status: 400, error: "That export request is not valid." };

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return { ok: false, status: 400, error: "No active company is selected, so the report cannot be exported. Choose a company from the top bar." };

  const { grain, scopeRef, periodKind, start, end, format } = request;
  try {
    const answer = await platformFetch<unknown>(`/api/${encodeURIComponent(tenant)}/reports/export`, userId, {
      method: "POST",
      body: JSON.stringify({ grain, scopeRef, periodKind, start, end, format }),
    });
    const jobId = jobIdFrom(answer);
    if (!jobId) return { ok: false, status: 502, error: "The platform did not return an export to download. Try again in a moment." };
    return { ok: true, jobId };
  } catch (e) {
    // As sent: the platform's status and its sentence (`forbidden`, `range_too_large`, `pdf export is not
    // configured`, ...). A 4xx/5xx the platform gave no sentence for falls back to words.
    if (e instanceof PlatformError) {
      const sentence = e.message && !/^platform \d+$/.test(e.message) ? e.message : exportRefusalMessage(e.status);
      return { ok: false, status: e.status, error: sentence };
    }
    return { ok: false, status: 502, error: "The platform could not be reached. Try again in a moment." };
  }
}
