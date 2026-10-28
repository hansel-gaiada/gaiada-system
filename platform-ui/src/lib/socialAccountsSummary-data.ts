import "server-only";
// SCP-Sg (BFF §63.10): the client page's reader of one client's accounts read back (`GET engagements/:engagementId/accounts-summary`, social_post · read). A
// `ReadResult`: a refusal or a failure is said in words, never drawn as "0 followers". A 404 is NOT read as empty here: an engagement the page already has in its
// allocation that the server cannot find is "cannot tell".
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asAccountsSummary, type AccountsSummaryView } from "./socialAccountsSummary";

export function getAccountsSummary(userId: string, tenantId: string, engagementId: string): Promise<ReadResult<AccountsSummaryView>> {
  return readResult(
    platformFetch<unknown>(`/api/${encodeURIComponent(tenantId)}/modules/social/engagements/${encodeURIComponent(engagementId)}/accounts-summary`, userId).then(asAccountsSummary),
  );
}
