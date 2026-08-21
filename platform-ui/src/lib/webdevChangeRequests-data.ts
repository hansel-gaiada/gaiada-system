import "server-only";
// MI-05 — thin readers over the MI-03 staff endpoints (webdev-change-requests.controller.ts).
// AGN-3: was "same degrade convention as lib/pipeline.ts's safe()" — 404 AND 403 both to []/null.
// That convention conflated three answers: the module is not enabled here, Cerbos denied this
// reader, and the backend failed. Only the first is honestly an empty tab.
//
// MI-05's negative control is unaffected: it asserts that a member-tier viewer does not see triage
// ACTIONS, and that an ALLOWED-but-empty queue shows its teach-state. Both still hold — what changes
// is that a DENIED viewer is now told they were denied instead of being shown "no requests yet",
// which was the one reading of an empty tab that was never true.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import type { ChangeRequestDetail, ChangeRequestRow } from "./webdevChangeRequests";

export async function listChangeRequests(
  userId: string,
  tenant: string,
  opts: { status?: string; clientId?: string; projectId?: string; kind?: string } = {},
): Promise<ReadResult<ChangeRequestRow[]>> {
  const q = new URLSearchParams();
  if (opts.status) q.set("status", opts.status);
  if (opts.clientId) q.set("clientId", opts.clientId);
  if (opts.projectId) q.set("projectId", opts.projectId);
  if (opts.kind) q.set("kind", opts.kind);
  const qs = q.toString();
  // `absentAsEmpty` covers the honest absence: a company without the webdev module 404s here, and
  // "this tab does not apply to you" is genuinely an empty queue.
  return readResult(
    platformFetch<ChangeRequestRow[]>(`/api/${tenant}/webdev/change-requests${qs ? `?${qs}` : ""}`, userId),
    { absentAsEmpty: [] },
  );
}

export async function getChangeRequest(
  userId: string,
  tenant: string,
  id: string,
): Promise<ReadResult<ChangeRequestDetail | null>> {
  // 404 on one request is a real answer ("no such request"); a 403 is not.
  return readResult(platformFetch<ChangeRequestDetail>(`/api/${tenant}/webdev/change-requests/${id}`, userId), {
    absentAsEmpty: null,
  });
}
