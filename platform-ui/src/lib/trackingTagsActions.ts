"use server";
// M5-P4 (WSK-D92) — the LinkedIn partner id's write, as a server action: PUT properties/:id/tracking-tags/linkedin (§28h). Cerbos decides
// (`manage_tags` on the property, then `github_repo . push`); the `can()` check here is only a cosmetic early exit. A refusal comes back as a
// sentence, never a code and never a silent no-op. Nothing is claimed beyond what the server said: the site reads the id at its NEXT rebuild.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { can } from "./rbac";
import {
  TrackingTagsShapeError, adsSavedSentence, checkGoogleAds, checkPartnerId, parseAdsPutResponse, parsePutResponse, savedSentence,
  trackingRefusalSentence, type AdsConversionKey, type GoogleAds, type PutResult,
} from "./trackingTagsModel";

export type SaveTagResult =
  | { ok: true; partnerId: string | null; result: PutResult; message: string }
  | { ok: false; message: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,198}[a-z0-9])?$/;

/**
 * `partnerId`: the text as typed (trimmed and checked here), or `null` to clear. `webdeskTenant` and `site` name the website the property
 * belongs to; the server checks that binding and refuses a mismatch.
 */
export async function saveLinkedinPartnerIdAction(a: { propertyId: string; webdeskTenant: string; site: string; partnerId: string | null }): Promise<SaveTagResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, message: trackingRefusalSentence(401, null) };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { ok: false, message: "No company is selected, so nothing was saved." };
  if (!can(me, "search.tags.manage", company)) return { ok: false, message: trackingRefusalSentence(403, null) };
  if (typeof a?.propertyId !== "string" || !UUID_RE.test(a.propertyId)) return { ok: false, message: trackingRefusalSentence(404, "property_not_found") };
  if (typeof a.webdeskTenant !== "string" || !SLUG_RE.test(a.webdeskTenant) || typeof a.site !== "string" || !UUID_RE.test(a.site)) {
    return { ok: false, message: trackingRefusalSentence(400, "tracking_query_invalid") };
  }
  let partnerId: string | null = null;
  if (a.partnerId !== null) {
    const v = checkPartnerId(typeof a.partnerId === "string" ? a.partnerId : "");
    if (!v.ok) return { ok: false, message: v.message };
    partnerId = v.value;
  }
  try {
    const body = await platformFetch<unknown>(
      `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(a.propertyId)}/tracking-tags/linkedin`,
      userId,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ webdeskTenant: a.webdeskTenant, site: a.site, partnerId }) },
    );
    const out = parsePutResponse(body);
    return { ok: true, partnerId: out.partnerId, result: out.result, message: savedSentence(out.result, out.partnerId, out.repo) };
  } catch (e) {
    if (e instanceof PlatformError) {
      const reason = e.reason ?? (e.body && typeof e.body === "object" && typeof (e.body as { reason?: unknown }).reason === "string" ? (e.body as { reason: string }).reason : null);
      return { ok: false, message: trackingRefusalSentence(e.status, reason) };
    }
    if (e instanceof TrackingTagsShapeError) return { ok: false, message: "The change was sent, but the answer did not match what the ERP expects. Reload the page to see what is stored." };
    return { ok: false, message: trackingRefusalSentence(0, null) };
  }
}

export type SaveAdsResult =
  | { ok: true; googleAds: GoogleAds; result: PutResult; message: string }
  | { ok: false; message: string };

/**
 * M5-P4g: the Google Ads section's write, PUT properties/:id/tracking-tags/google-ads. `ids` and `conversions` are the text as typed (trimmed
 * and checked here with the server's rules); empty ids with no conversions clears. Same guards and same refusals-as-sentences as above.
 */
export async function saveGoogleAdsAction(
  a: { propertyId: string; webdeskTenant: string; site: string; ids: string; conversions: Record<AdsConversionKey, string> },
): Promise<SaveAdsResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, message: trackingRefusalSentence(401, null) };
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) return { ok: false, message: "No company is selected, so nothing was saved." };
  if (!can(me, "search.tags.manage", company)) return { ok: false, message: trackingRefusalSentence(403, null) };
  if (typeof a?.propertyId !== "string" || !UUID_RE.test(a.propertyId)) return { ok: false, message: trackingRefusalSentence(404, "property_not_found") };
  if (typeof a.webdeskTenant !== "string" || !SLUG_RE.test(a.webdeskTenant) || typeof a.site !== "string" || !UUID_RE.test(a.site)) {
    return { ok: false, message: trackingRefusalSentence(400, "tracking_query_invalid") };
  }
  const v = checkGoogleAds({
    ids: typeof a.ids === "string" ? a.ids : "",
    conversions: {
      lead: typeof a.conversions?.lead === "string" ? a.conversions.lead : "",
      whatsapp: typeof a.conversions?.whatsapp === "string" ? a.conversions.whatsapp : "",
      phone: typeof a.conversions?.phone === "string" ? a.conversions.phone : "",
      email: typeof a.conversions?.email === "string" ? a.conversions.email : "",
    },
  });
  if (!v.ok) return { ok: false, message: v.message };
  try {
    const body = await platformFetch<unknown>(
      `/api/${encodeURIComponent(company)}/modules/search/properties/${encodeURIComponent(a.propertyId)}/tracking-tags/google-ads`,
      userId,
      {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ webdeskTenant: a.webdeskTenant, site: a.site, ids: v.ids.length ? v.ids : null, conversions: v.conversions }),
      },
    );
    const out = parseAdsPutResponse(body);
    return { ok: true, googleAds: out.googleAds, result: out.result, message: adsSavedSentence(out.result, out.googleAds, out.repo) };
  } catch (e) {
    if (e instanceof PlatformError) {
      const reason = e.reason ?? (e.body && typeof e.body === "object" && typeof (e.body as { reason?: unknown }).reason === "string" ? (e.body as { reason: string }).reason : null);
      return { ok: false, message: trackingRefusalSentence(e.status, reason) };
    }
    if (e instanceof TrackingTagsShapeError) return { ok: false, message: "The change was sent, but the answer did not match what the ERP expects. Reload the page to see what is stored." };
    return { ok: false, message: trackingRefusalSentence(0, null) };
  }
}
