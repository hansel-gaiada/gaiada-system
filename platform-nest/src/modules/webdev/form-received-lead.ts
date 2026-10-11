// M5-L4 — the minimal hook: when the ERP records a Zone B `form.received` fact, file the submission as a lead.
// The event is ids-only and is NOT trusted as data; `createLeadFromWebSubmission` fetches the authoritative
// submission from WebDesk (`forms.submission.get`) over the authenticated control client.
//
// Company binding (what this uses, on main today): the route's `:tenantId` IS the company (a Zone B event for
// a WebDesk tenant is posted to its `company_ref`; `validateZoneBEvent` refuses a body tenantId that differs),
// and the service re-proves the binding with `tenant.list?companyRef=` before it fetches or inserts. It does
// NOT depend on the `webdesk_site_clients` table (release 356, not on main).
//
// OFF by default (`AGENCY_WEB_LEADS_ENABLED=1` to enable; owner ruling: each phase waits for counsel).
// Fire-and-forget at the call site: the answer to the event POST never depends on this. Runs on a REPLAY too
// (the insert is idempotent), which is the retry path when WebDesk was briefly unreachable the first time.
// Logs carry the submission id and a typed outcome token only; never a field value.
import { Logger } from "@nestjs/common";
import {
  createLeadFromWebSubmission, webLeadsEnabled, type WebLeadsDeps,
} from "../../core/agency-web-leads.service";

const logger = new Logger("FormReceivedLead");

export async function maybeFileLeadFromFormReceived(
  tenantId: string,
  event: { kind: string; originSite: string; data: Record<string, unknown> },
  deps?: WebLeadsDeps,
): Promise<void> {
  if (event.kind !== "form.received" || !webLeadsEnabled()) return;
  const { siteSlug, submissionId } = event.data;
  if (typeof siteSlug !== "string" || typeof submissionId !== "string") return;
  try {
    const r = await createLeadFromWebSubmission({ tenantId, siteSlug, submissionId, originSite: event.originSite }, deps);
    logger.log(`submission ${submissionId}: ${r.outcome}`);
  } catch (err) {
    // Name + HTTP status only: an error message could in principle quote a response body.
    const status = (err as { getStatus?: () => number })?.getStatus?.();
    logger.warn(`submission ${submissionId}: lead not filed (${(err as Error)?.name ?? "error"}${status ? ` ${status}` : ""})`);
  }
}
