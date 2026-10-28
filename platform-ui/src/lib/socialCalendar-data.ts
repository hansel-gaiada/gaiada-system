import "server-only";
// SCP-3e (BFF §63.10, §59.1): the Social Media calendar's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person may not read it, which is not "nothing here";
//   unavailable anything else (a 404 when the module is off for the company included): "cannot tell", never an empty grid.
// The department calendar's reader (`getDeptCalendar`), the allocation's (`getAllocation`) and the cycle table's (`getCycleTable`) are the existing ones.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asComposerEntries, asDayItems, type ComposerEntry, type DayItem } from "./socialCalendar";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET calendar?from=&to=&engagementId=` (social_post · read, at most 62 days): every client's scheduled pipeline posts, or one client's with `engagementId`. */
export function getSocialCalendar(
  userId: string, tenantId: string, q: { from: string; to: string; engagementId?: string | null },
): Promise<ReadResult<DayItem[]>> {
  const qs = new URLSearchParams({ from: q.from, to: q.to, ...(q.engagementId ? { engagementId: q.engagementId } : {}) });
  return readResult(platformFetch<unknown>(`${base(tenantId)}/calendar?${qs.toString()}`, userId).then(asDayItems));
}

/** `GET posts` (social_post · read): the Composer's own posts with a date. The list is the server's most recent 500 posts, pipeline posts among them, and the
 *  Composer's are the ones with no pipeline status. */
export function getComposerPosts(userId: string, tenantId: string, engagementId?: string | null): Promise<ReadResult<ComposerEntry[]>> {
  const qs = engagementId ? `?engagementId=${encodeURIComponent(engagementId)}` : "";
  return readResult(platformFetch<unknown>(`${base(tenantId)}/posts${qs}`, userId).then(asComposerEntries));
}
