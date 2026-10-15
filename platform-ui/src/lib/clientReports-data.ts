import "server-only";
// PV7-04b — the staff reader behind `/clients/[id]/reports` (BFF §55.3).
//
//   GET /api/:t/clients/:clientId/reports -> { reports: StaffClientReport[] }   every status, newest first
//
// Like the billing readers it THROWS on a refusal or a failure: the page wraps it in `readResult()` so a denied or failed
// read renders `<ReadRefusal>` and never an empty list. A reply without a list is a failed read as well.
import { platformFetch } from "./platform";
import type { StaffClientReport } from "./clientReports";

export async function listClientReports(userId: string, tenant: string, clientId: string): Promise<StaffClientReport[]> {
  const r = await platformFetch<{ reports: StaffClientReport[] }>(`/api/${tenant}/clients/${encodeURIComponent(clientId)}/reports`, userId);
  if (!r || !Array.isArray(r.reports)) throw new Error("the reports list came back in an unexpected shape");
  return r.reports;
}
