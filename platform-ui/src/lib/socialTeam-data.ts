import "server-only";
// SCP-5d (BFF §63.19): the Team dashboard's reader. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names (`partial` and `personRowsLimited` kept as the server sent them);
//   forbidden   a 403 `not_a_social_approver`: the person is not one of the four, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off included): "cannot tell", never an empty dashboard.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asTeamDashboard, type TeamDashboard } from "./socialTeam";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET team?month=YYYY-MM` (social_engagement · plan: the four approvers). */
export function getTeamDashboard(userId: string, tenantId: string, month: string): Promise<ReadResult<TeamDashboard>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/team?month=${encodeURIComponent(month)}`, userId).then(asTeamDashboard));
}
