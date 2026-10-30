import "server-only";
// SCP-5e (BFF §63.26): the content bank's readers. One egress (`platformFetch`), every answer a `ReadResult`:
//   ok          the read succeeded, and the body is the shape the contract names;
//   forbidden   a 403: the person has no social read tier, which is not "nothing here";
//   unavailable anything else (a 404 for a client that is gone or a module that is off included): "cannot tell", never an empty bank.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";
import { asCollections, asSavedPage, savedQuery, type SavedCollections, type SavedPage, type SavedView } from "./socialSaved";

const base = (t: string, engagementId: string) => `/api/${encodeURIComponent(t)}/modules/social/engagements/${encodeURIComponent(engagementId)}/saved`;

/** `GET engagements/:engagementId/saved` (`social_post` · `read`): the company's enabled collections in their order, with counts and previews, and whether the caller may add. */
export function getSavedCollections(userId: string, tenantId: string, engagementId: string): Promise<ReadResult<SavedCollections>> {
  return readResult(platformFetch<unknown>(base(tenantId, engagementId), userId).then(asCollections));
}

/** `GET engagements/:engagementId/saved?collection=&pillar=&used=&source=&cursor=`: one collection's items, paged (the hashtag sets are not). */
export function getSavedItems(
  userId: string, tenantId: string, engagementId: string, view: Pick<SavedView, "collection" | "pillar" | "used" | "source" | "cursor">,
): Promise<ReadResult<SavedPage>> {
  const collection = view.collection ?? "";
  return readResult(platformFetch<unknown>(`${base(tenantId, engagementId)}?${savedQuery(view)}`, userId).then((raw) => asSavedPage(raw, collection)));
}
