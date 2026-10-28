import "server-only";
// SCP-4b, SCP-4c (BFF §63.11): the boost pages' readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty list.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asBoostBudget, asBoostList, asPortalSpend, type BoostBudget, type BoostList, type PortalSpend } from "./socialBoosts";
import type { Me } from "./platform";
import { readOrgRoot } from "./campaigns-data";
import { isElevated, leadUnits } from "./rbac";
import { resolveMyWorkspaces, workspaceUnitsOf } from "./workspaceAccess";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET boosts?status=&engagementId=&cycleId=&cursor=&limit=` (`social_post` · `read`): the Boosting list, its candidates and its totals. */
export function getBoostList(userId: string, tenantId: string, q: { status?: string | null; engagementId?: string | null; cycleId?: string | null; cursor?: string | null; limit?: number } = {}): Promise<ReadResult<BoostList>> {
  const qs = new URLSearchParams();
  if (q.status) qs.set("status", q.status);
  if (q.engagementId) qs.set("engagementId", q.engagementId);
  if (q.cycleId) qs.set("cycleId", q.cycleId);
  if (q.cursor) qs.set("cursor", q.cursor);
  if (q.limit) qs.set("limit", String(q.limit));
  const tail = qs.toString();
  return readResult(platformFetch<unknown>(`${base(tenantId)}/boosts${tail ? `?${tail}` : ""}`, userId).then(asBoostList));
}

/** `GET cycles/:cycleId/boost-budget` (`social_post` · `read`): the cycle's agreed budget, the pending proposal, committed and remaining, and the history. */
export function getBoostBudget(userId: string, tenantId: string, cycleId: string): Promise<ReadResult<BoostBudget>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/cycles/${encodeURIComponent(cycleId)}/boost-budget`, userId).then(asBoostBudget));
}

/** `GET portal/social/spend` (`portal` · `read`): the client's boost budgets and boosts waiting for them, their history, and whether this contact may decide. */
export function getPortalSpend(userId: string, tenantId: string): Promise<ReadResult<PortalSpend>> {
  return readResult(platformFetch<unknown>(`/api/${encodeURIComponent(tenantId)}/portal/social/spend`, userId).then(asPortalSpend));
}

/**
 * A MIRROR for drawing, never a gate: may this person run a boost on a post? The post's officer, the Social Media head or the GM (a live lead seat on either unit), or the
 * superadmin. NOT the owner: the owner agrees money through `budget` but runs no boost (BFF §63.11). The server decides every write; a wrong guess here only changes which
 * buttons are drawn, and a refusal is said in words.
 */
export async function canRunBoosts(me: Me, tenantId: string, officerId: string | null | undefined, viewerId: string): Promise<boolean> {
  if (officerId && officerId === viewerId) return true;
  if (isElevated(me)) return true;
  const root = await readOrgRoot(me, tenantId);
  const units = workspaceUnitsOf(resolveMyWorkspaces({ me, tenantId, root }));
  const seats = [...(units["social-media"] ?? []), ...(units.gm ?? [])];
  const led = leadUnits(me, tenantId);
  return seats.some((id) => led.includes(id));
}
