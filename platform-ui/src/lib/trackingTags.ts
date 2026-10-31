import "server-only";
// M5-P4 (WSK-D92) — Website -> Analytics -> Tracking tags: the server read. GET properties/:id/tracking-tags (§28h). The value is public (it ends
// up in the site's HTML), so every search reader may call it; whether the viewer may CHANGE it comes back as `canManage`. A failure is a
// state with words, never an empty value: "Not set" is drawn only for an answer that said so.
import { platformFetch, PlatformError } from "./platform";
import type { Read } from "./visitors";
import {
  TrackingTagsShapeError, parseFoundSite, parseTrackingTags, siteLookupSentence, trackingReadSentence, type TrackingSiteRef, type TrackingTagsView,
} from "./trackingTagsModel";

export async function readTrackingTags(
  userId: string, company: string, propertyId: string, webdeskTenant: string, siteId: string,
): Promise<Read<TrackingTagsView>> {
  const qs = new URLSearchParams({ webdeskTenant, site: siteId }).toString();
  try {
    const body = await platformFetch<unknown>(
      `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}/tracking-tags?${qs}`,
      userId,
    );
    return { state: "ok", data: parseTrackingTags(body) };
  } catch (e) {
    if (e instanceof TrackingTagsShapeError) return { state: "unavailable", message: `The tracking tags answer did not match the contract (${e.message}). This is a defect, not an empty value.` };
    if (e instanceof PlatformError) return { state: "unavailable", message: trackingReadSentence(e.status, e.reason ?? null) };
    return { state: "unavailable", message: "The tracking tags could not be read just now. Try again in a moment." };
  }
}

/** The site lookup's answer: a site or `null` (ok), a refusal to see the property (forbidden), or a sentence (unavailable). Never an empty guess. */
export type FoundSite =
  | { kind: "ok"; data: { site: TrackingSiteRef | null } }
  | { kind: "forbidden"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * M5-P4g: which WebDesk site is this property's. GET properties/:id/tracking-tags/site (§28h.2): `search_property . read` only, resolved on the
 * server from the company's own sites, so a search manager with no Web Dev role gets the answer. The engagement page uses it.
 */
export async function findTrackingSite(userId: string, company: string, propertyId: string): Promise<FoundSite> {
  try {
    const body = await platformFetch<unknown>(
      `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(propertyId)}/tracking-tags/site`,
      userId,
    );
    return { kind: "ok", data: parseFoundSite(body) };
  } catch (e) {
    if (e instanceof TrackingTagsShapeError) return { kind: "unavailable", message: `The site lookup answer did not match the contract (${e.message}). This is a defect, not "no website".` };
    if (e instanceof PlatformError) {
      const reason = e.reason ?? null;
      const message = siteLookupSentence(e.status, reason);
      return e.status === 403 ? { kind: "forbidden", message } : { kind: "unavailable", message };
    }
    return { kind: "unavailable", message: siteLookupSentence(0, null) };
  }
}
