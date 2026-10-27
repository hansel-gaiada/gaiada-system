import "server-only";
import { redirect } from "next/navigation";
import { getSessionUserId } from "./session-server";
import { getMe, type Me } from "./platform";
import { rethrowIfSessionEnded } from "./sessionEnded";
import { getActiveTenant } from "./tenant";
import { isContributor } from "./rbac";
import { contributorFenceReason, type FenceReason } from "./contributorRouting";

// M5-W1f — what every page of the `(contributor)` shell needs first: the session, the caller's `/me` and the active company.
//
//   ok      a contributor (`me.kind === "contributor"`) with an active, unexpired engagement company
//   fenced  `/api/me` itself answered 403 `contributor_route_forbidden`: only a contributor is ever refused that way, and the usual reason is
//           `assurance_high_required` (no real second factor yet, W1g). The shell then shows the two-step notice and reads nothing else.
//
// Anything else is not for this shell: a person who is not a contributor is sent to "/" (the staff workspace, which itself sends a client to
// the portal), and a missing or unreadable session goes to /login, as the portal layout does.
export type ContributorCtx =
  | { kind: "ok"; userId: string; me: Me; company: string | null }
  | { kind: "fenced"; reason: FenceReason };

export async function contributorCtx(): Promise<ContributorCtx> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  let me: Me;
  try {
    me = await getMe(userId);
  } catch (e) {
    const reason = contributorFenceReason(e);
    if (reason) return { kind: "fenced", reason };
    rethrowIfSessionEnded(e);
    redirect("/login");
  }
  if (!isContributor(me)) redirect("/");
  // `me.companies` for a contributor is its live engagements and nothing else (PERMISSION §27.6), so the first one is a real anchor.
  return { kind: "ok", userId, me, company: await getActiveTenant(me) };
}
