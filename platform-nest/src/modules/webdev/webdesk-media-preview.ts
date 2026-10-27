// M5-W1q2 (owner ruling WSK-D84, approved 2026-10-27) -- the reviewer's byte preview of a quarantined upload, the ERP's rules for the
// bytes themselves. Pure: no I/O, so it is unit-tested without a database (webdesk-media-preview.test.ts).
//
// A freelance writer's upload is untrusted. WebDesk hands its bytes to the ERP only for a quarantined, clean, undeleted RASTER image
// of at most 10 MiB (webdesk/api/src/control/content/media-review-preview.ts), and this file is the ERP's own, second wall: it
// restates the allow-list and the cap, and it checks the MAGIC BYTES itself before one byte is sent to a browser, because a row that
// declares `image/png` over HTML would otherwise be served from the ERP's own origin. Neither side trusts the other. The allow-list
// is the same on both sides and on the page (platform-ui/src/lib/webdeskMediaPreview.ts); a change here is a change there.
//
// WHAT THE BROWSER GETS. Exactly six headers, never anything copied from WebDesk (`previewHeaders`). `Content-Security-Policy:
// sandbox; default-src 'none'` means that even if a type confusion slipped past the signature check, the response, opened as a
// document, could neither run script nor load anything. `nosniff` stops the browser second-guessing the type, `Content-Disposition`
// says `inline` with a fixed name (the uploader's own filename is never echoed into a header), `no-store` keeps an unaccepted
// upload out of every cache, and `Cross-Origin-Resource-Policy: same-origin` lets only the ERP's own pages embed it.

/** The only types a preview is ever served as. */
export const PREVIEW_RASTER_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;
export type PreviewRasterMime = (typeof PREVIEW_RASTER_MIMES)[number];

/** 10 MiB: WebDesk refuses a larger asset 413, and the ERP refuses bytes over it even if WebDesk did not. */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

const EXTENSIONS: Record<PreviewRasterMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

export function isPreviewRasterMime(mime: string): mime is PreviewRasterMime {
  return (PREVIEW_RASTER_MIMES as readonly string[]).includes(mime);
}

/** The media type of a Content-Type header value: the part before any parameter, trimmed and lower-cased; null when absent. */
export function mediaTypeOf(contentType: string | null | undefined): string | null {
  if (typeof contentType !== "string") return null;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return base === "" ? null : base;
}

function startsWith(buf: Buffer, sig: readonly number[]): boolean {
  return buf.length >= sig.length && sig.every((b, i) => buf[i] === b);
}

/**
 * Do these bytes carry the signature of `mime`? PNG, JPEG, GIF (87a or 89a), WEBP (RIFF, four size bytes, WEBP) and AVIF (an ISO-BMFF
 * `ftyp` box whose major brand is `avif` or `avis`). An MP4 (`ftyp` with another brand), a WAV (RIFF....WAVE), an SVG or HTML
 * document, and a mime that is not in the allow-list never match.
 */
export function rasterSignatureMatches(buf: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case "image/gif": {
      const head = buf.subarray(0, 6).toString("latin1");
      return head === "GIF87a" || head === "GIF89a";
    }
    case "image/webp":
      return buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP";
    case "image/avif": {
      if (buf.length < 12 || buf.subarray(4, 8).toString("latin1") !== "ftyp") return false;
      const brand = buf.subarray(8, 12).toString("latin1");
      return brand === "avif" || brand === "avis";
    }
    default:
      return false;
  }
}

/**
 * The six response headers of a preview, exactly, and no others. The file name is fixed (`preview.<ext>`): the uploader's own file name
 * is a string a stranger chose and is never put in a header.
 */
export function previewHeaders(mime: PreviewRasterMime): Record<string, string> {
  return {
    "Content-Type": mime,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Disposition": `inline; filename="preview.${EXTENSIONS[mime]}"`,
    "Cache-Control": "private, no-store",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
