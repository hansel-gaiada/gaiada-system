import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformAuthHeaders } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { isDemoMode } from "@/lib/demoMode";
import { isPlausibleFileId } from "@/lib/fileDownload";
import { isPreviewableMime, mediaTypeOf, previewRefusalMessage, previewResponseHeaders } from "@/lib/webdeskMediaPreview";

// M5-W1q2 (WSK-D84) -- the reviewer's thumbnail of a quarantined upload. `GET /api/webdesk-media-preview/:tenantSlug/:siteId/:assetId` streams the
// platform's `GET /api/:t/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId/review-preview` with the CALLER'S session, the way
// `app/api/creative-assets/[assetId]` does for asset bytes: the browser's <img> cannot carry the platform's bearer token. The platform
// authorizes (Cerbos `webdesk_media_asset:review`, the uploader may not preview their own upload) and checks the type, the file signature and
// the size; this route adds no permission and widens none. The company is the caller's ACTIVE one (`getActiveTenant`), never a value from the
// URL; `tenantSlug` and `siteId` are WebDesk's own identifiers, validated here and checked against that company by the platform's site wall.
//
// TWO DIFFERENCES FROM THE DOWNLOAD ROUTES, both deliberate:
//   * the disposition is `inline` (a thumbnail is drawn in a page), not `attachment`;
//   * the response headers are NOT copied from upstream. Exactly six are set here from an allow-list (`previewResponseHeaders`): the type (one
//     of five raster types, else a refusal), nosniff, a sandbox CSP, `inline` with a fixed name, no-store and same-origin. An upload is a
//     stranger's bytes served from our own origin; a header the upstream chose is not trusted to decide whether the browser may run them.
// A refusal is a failed <img> to the page, which says "Preview unavailable"; the status here only has to be honest.
export const dynamic = "force-dynamic";

const refusalHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const refuse = (status: number, message?: string) =>
  NextResponse.json({ error: message ?? previewRefusalMessage(status) }, { status, headers: refusalHeaders });

export async function GET(_req: Request, ctx: { params: Promise<{ tenantSlug: string; siteId: string; assetId: string }> }): Promise<Response> {
  const { tenantSlug, siteId, assetId } = await ctx.params;
  if (![tenantSlug, siteId, assetId].every(isPlausibleFileId)) return refuse(400);

  const userId = await getSessionUserId();
  if (!userId) return refuse(401);

  // The caller's active company. A failure to LOOK IT UP is a fault (502), never folded into "no company" (400) or into an empty answer.
  let tenant: string | null;
  try {
    tenant = await getActiveTenant(await getMe(userId));
  } catch (e) {
    console.error("[webdesk-media-preview] could not resolve the active company:", (e as { message?: string }).message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }
  if (!tenant) return refuse(400, "No active company is selected, so the upload cannot be looked up. Choose a company from the top bar.");

  // Demo mode holds no upload bytes and has no platform to ask.
  if (isDemoMode()) return refuse(404, "There are no upload previews in demo mode.");

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  const path = `/api/${encodeURIComponent(tenant)}/modules/webdev/content/sites/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(siteId)}/media/${encodeURIComponent(assetId)}/review-preview`;
  let upstream: Response;
  try {
    upstream = await fetch(`${base}${path}`, {
      headers: await platformAuthHeaders(userId),
      cache: "no-store",
      redirect: "manual",
    });
  } catch (e) {
    const err = e as { message?: string; cause?: { code?: string } };
    console.error("[webdesk-media-preview] upstream fetch failed:", err.cause?.code ?? err.message);
    return refuse(502, "The platform could not be reached. Try again in a moment.");
  }

  if (!upstream.ok) {
    // The platform's own refusals are statements about the person or the upload; anything else is a fault of ours.
    const status = [401, 403, 404, 413, 415].includes(upstream.status) ? upstream.status : 502;
    return refuse(status);
  }

  // Only a raster type is passed on. Anything else from upstream is not what the platform promised, so it is not served from our origin.
  const mime = mediaTypeOf(upstream.headers.get("content-type"));
  if (!isPreviewableMime(mime) || upstream.body === null) return refuse(502);
  return new Response(upstream.body, { status: 200, headers: previewResponseHeaders(mime) });
}
