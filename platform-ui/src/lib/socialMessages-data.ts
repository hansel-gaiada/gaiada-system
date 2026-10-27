import "server-only";
// SCP-1j (BFF §63.7): the Messages page's reader and the pipeline's leg of "Needs you". One egress (`platformFetch`).
//   getWaiting       a `ReadResult`: ok / forbidden (a 403: no social read tier, which is not "nothing is waiting") / unavailable (anything else).
//   getSocialNeedsYou  an answer for `lib/queue.ts`, which names a failed source and never drops it. A company with no Social Media module (a 404) and a person
//                     with no read tier (a 403) have no such leg: an empty answer, not a lost source (the queue's own rule for KPI alerts).
import { platformFetch, PlatformError } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asNeedsYouSocial, asWaitingGroups, type NeedsYouSocialItem, type WaitingGroup } from "./socialMessages";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET waiting` (social_post · read): the caller's posts that someone else holds, grouped by holder. */
export function getWaiting(userId: string, tenantId: string): Promise<ReadResult<WaitingGroup[]>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/waiting`, userId).then(asWaitingGroups));
}

/** `GET needs-you`. Throws a `PlatformError` or an `Error` for a failure the queue must name; answers no items for a 403 or a 404. */
export async function getSocialNeedsYou(userId: string, tenantId: string): Promise<{ items: NeedsYouSocialItem[]; partial: string[] }> {
  try {
    return asNeedsYouSocial(await platformFetch<unknown>(`${base(tenantId)}/needs-you`, userId));
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 403 || e.status === 404)) return { items: [], partial: [] };
    throw e;
  }
}
