// M5-W1q2 (owner ruling WSK-D84, approved 2026-10-27) -- the reviewer's preview of a quarantined upload: the pure parts the Next route
// (`app/api/webdesk-media-preview/...`) and the review desk's thumbnails share. Client-safe: no server-only imports.
//
// The BFF route `GET …/sites/:tenantSlug/:siteId/media/:assetId/review-preview` (FRONTEND-BFF-CONTRACT §27, "The reviewer's byte preview")
// answers the bytes of ONE quarantined raster image after the SAME Cerbos `review` questions as the decision, and nothing else. A browser
// <img> cannot carry the platform's token, so the Next route streams it with the caller's session. What this file fixes:
//   * which types are ever shown (five raster types: the same list as the platform's and WebDesk's). An SVG, an HTML file, a PDF, a video
//     or anything else is shown by NAME ONLY: "No preview for <mime>";
//   * the six response headers the route sends, re-set from this allow-list. NOTHING is copied from the upstream response, because the
//     bytes come from a stranger and the headers decide whether the browser may run them: a sandbox CSP, nosniff, inline with a fixed name,
//     no-store, same-origin only. The file name is fixed by the type; the uploader's own file name never reaches a header.

export const PREVIEW_RASTER_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;
export type PreviewRasterMime = (typeof PREVIEW_RASTER_MIMES)[number];

const EXTENSIONS: Record<PreviewRasterMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

/** True for exactly the five raster types a preview is ever drawn for. */
export function isPreviewableMime(mime: string | null | undefined): mime is PreviewRasterMime {
  return typeof mime === "string" && (PREVIEW_RASTER_MIMES as readonly string[]).includes(mime);
}

/** The media type of a Content-Type header value (before any parameter, trimmed, lower-cased), or null. */
export function mediaTypeOf(contentType: string | null | undefined): string | null {
  if (typeof contentType !== "string") return null;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "" ? null : base;
}

/** Where the thumbnail's <img> loads from. Every segment is encoded; the route validates each one again. */
export function previewHref(scope: { tenantSlug: string; siteId: string }, assetId: string): string {
  return `/api/webdesk-media-preview/${encodeURIComponent(scope.tenantSlug)}/${encodeURIComponent(scope.siteId)}/${encodeURIComponent(assetId)}`;
}

/**
 * The six headers of a preview response, exactly and nothing else (the same six as the platform's: platform-nest `previewHeaders`).
 * Keys are lower-case here; a `Response` normalises them anyway.
 */
export function previewResponseHeaders(mime: PreviewRasterMime): Record<string, string> {
  return {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "content-disposition": `inline; filename="preview.${EXTENSIONS[mime]}"`,
    "cache-control": "private, no-store",
    "cross-origin-resource-policy": "same-origin",
  };
}

/** What the row says for an upload that is not a raster image. Never a thumbnail, never a link to the file. */
export function noPreviewCopy(mime: string): string {
  return `No preview for ${mime}`;
}

/** What the row says when the image could not be loaded (refused, too large, or the service is down). */
export const PREVIEW_UNAVAILABLE_COPY = "Preview unavailable";

/** What the person reads in the one place a refusal is shown as text (opened in a tab, or read from a failed image). */
export function previewRefusalMessage(status: number): string {
  if (status === 401) return "Your session has expired. Sign in again.";
  if (status === 403) return "You do not have permission to preview this upload. Only a reviewer other than the person who sent it can.";
  if (status === 404) return "This upload is not waiting for review, or no longer exists.";
  if (status === 413) return "This image is too large to preview.";
  if (status === 415) return "Only raster images (png, jpeg, gif, webp, avif) are previewed.";
  if (status === 400) return "That is not a valid preview link.";
  return "The preview is not available right now.";
}
