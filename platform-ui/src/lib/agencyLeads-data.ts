import "server-only";
// AD-11 — thin readers over the AD-4 staff endpoints (agency-leads.controller.ts). Mirrors the
// `readResult`/`ReadRefusal` discipline `webdevChangeRequests-data.ts` documents at its own header:
// a 403 must never fold into an empty list or a null detail (contract rule 3 — "the estate has a
// live defect from exactly that: a portal told staff a kickoff was 'being processed'").
//
// Unlike the webdev change-request queue, the agency-leads LIST route carries no `ModuleEnabledGuard`
// at all (design §3.1: the plain tenant wall, because the primary writer — the token-guarded prospect
// intake endpoint — declares no module scope). So there is no honest "absent" reading for a 404 on
// the list the way `webdevChangeRequests-data.ts`'s `absentAsEmpty` covers a disabled module; any 404
// there would be a real backend defect, and `readResult` already reports that as `unavailable` rather
// than silently emptying the queue.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { LeadDetail, LeadQueueRow, LeadSubmission } from "./agencyLeads";

export async function listAgencyLeadsQueue(userId: string, tenant: string): Promise<ReadResult<LeadQueueRow[]>> {
  return readResult(platformFetch<LeadQueueRow[]>(`/api/${tenant}/agency/leads`, userId));
}

/** Detail is joined to the latest submission server-side. A 404 here is a REAL answer ("no such
 *  lead", or one this tenant cannot see under RLS) — same distinction `webdevChangeRequests-
 *  data.ts::getChangeRequest` draws for its own single-item read — so it degrades to `ok: null`,
 *  never to `forbidden`/`unavailable`. */
export async function getAgencyLeadDetail(userId: string, tenant: string, leadId: string): Promise<ReadResult<LeadDetail | null>> {
  return readResult(platformFetch<LeadDetail>(`/api/${tenant}/agency/leads/${leadId}`, userId), { absentAsEmpty: null });
}

/** Full submission history, newest first. This is a SEPARATE Cerbos resource
 *  (`agency_discovery_submission`, contract rule 6) from the lead itself, so a caller who can read a
 *  lead's queue row is not automatically guaranteed to read its submissions — a 403 here is rendered
 *  on its own, not silently merged into the detail read's outcome.
 *
 *  The backend returns `null` (not `[]`) when the LEAD itself doesn't exist — genuinely distinct from
 *  a lead that exists but has never been submitted against (still `invited`), which returns a real
 *  `[]`. `readResult`'s own doctrine reserves `absentAsEmpty` for a 404 that means "route/module not
 *  served here"; a null body on a 200 is neither of those, so it is handled explicitly below rather
 *  than folded into the generic wrapper. */
export async function listAgencyLeadSubmissions(userId: string, tenant: string, leadId: string): Promise<ReadResult<LeadSubmission[] | null>> {
  return readResult(platformFetch<LeadSubmission[] | null>(`/api/${tenant}/agency/leads/${leadId}/submissions`, userId));
}
