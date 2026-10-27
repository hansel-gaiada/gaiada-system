import "server-only";
// SCP-1k (BFF §63.5, §63.10, §63.4): the client page's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 when the Social Media module is off for the company included): "cannot tell", never an empty grid.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asBrandBook, type BrandBook } from "./socialBrandBook";
import { asCalendarItems, asCycleView, type CalendarItem, type CycleView } from "./socialClient";
import { asFeedPreview, type FeedPreviewView } from "./socialFeedPreview";

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

/** `GET cycles/:cycleId/health` (social_post · read): the cycle's posts with status, phase, holder, format, `isExtra` and health. */
export function getCycleView(userId: string, tenantId: string, cycleId: string): Promise<ReadResult<CycleView>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/cycles/${encodeURIComponent(cycleId)}/health`, userId).then(asCycleView));
}

/** `GET calendar?from=&to=&engagementId=` (social_post · read, at most 62 days): the client's scheduled pipeline posts. */
export function getClientCalendar(userId: string, tenantId: string, q: { from: string; to: string; engagementId: string }): Promise<ReadResult<CalendarItem[]>> {
  const qs = new URLSearchParams({ from: q.from, to: q.to, engagementId: q.engagementId });
  return readResult(platformFetch<unknown>(`${base(tenantId)}/calendar?${qs.toString()}`, userId).then(asCalendarItems));
}

/** `GET engagements/:engagementId/feed-preview` (social_post · read, SCP-3d): the client's grid, newest date first, live posts locked. */
export function getFeedPreview(userId: string, tenantId: string, engagementId: string): Promise<ReadResult<FeedPreviewView>> {
  return readResult(platformFetch<unknown>(`${base(tenantId)}/engagements/${encodeURIComponent(engagementId)}/feed-preview`, userId).then(asFeedPreview));
}

/** `GET brand-profiles/:clientId` (social_engagement · read). A client with no profile yet is a real answer: `ok` with a null book. */
export function getClientBrandBook(userId: string, tenantId: string, clientId: string): Promise<ReadResult<BrandBook | null>> {
  return readResult(
    platformFetch<unknown>(`${base(tenantId)}/brand-profiles/${encodeURIComponent(clientId)}`, userId).then((raw): BrandBook | null => asBrandBook(raw)),
    { absentAsEmpty: null },
  );
}

/** The PM project a client's engagement is tied to (`GET engagements/:engagementId`, `projectId`), or null for an engagement with none. */
export function getEngagementProjectId(userId: string, tenantId: string, engagementId: string): Promise<ReadResult<string | null>> {
  return readResult(
    platformFetch<unknown>(`${base(tenantId)}/engagements/${encodeURIComponent(engagementId)}`, userId).then((raw): string | null => {
      const id = raw !== null && typeof raw === "object" ? (raw as { projectId?: unknown }).projectId : null;
      return typeof id === "string" && id ? id : null;
    }),
    { absentAsEmpty: null },
  );
}
