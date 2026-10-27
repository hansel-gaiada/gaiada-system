// M5-W1q2 (owner ruling WSK-D84, approved 2026-10-27) -- the reviewer's byte preview of a QUARANTINED upload.
//
// A staff editor accepts or rejects a freelance writer's upload (media.review). Without this they decide blind. This is the one
// place WebDesk hands the bytes of an unaccepted asset to anyone, so what it may hand over is a closed list and nothing else:
//
//   the asset is on the named site, not deleted, `review_state = 'quarantined'`, `scan_status = 'clean'`, its stored mime is one
//   of the five RASTER types below, and it is at most 10 MiB.
//
// SVG, HTML, PDF, video, an unknown type: never. (An SVG is a document that can run script; a PDF can too; a video is large and
// the reviewer is shown a name for it.) The public serving routes are untouched: MediaService.getPublicAsset still refuses a
// quarantined asset, and this route is on the control plane (mTLS + token), not on /v1.
//
// The same list and the same signature table are restated in the ERP (platform-nest/src/modules/webdev/webdesk-media.service.ts),
// which checks the bytes again before it sends one: neither side trusts the other, and a change here is a change there.
import { ControlProblem } from "./content-problem";

/** The only types a preview is ever served as. */
export const PREVIEW_RASTER_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"] as const;
export type PreviewRasterMime = (typeof PREVIEW_RASTER_MIMES)[number];

/** 10 MiB. A larger raster is refused 413 (the reviewer sees its name and size), never truncated. */
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export function isPreviewRasterMime(mime: string): mime is PreviewRasterMime {
  return (PREVIEW_RASTER_MIMES as readonly string[]).includes(mime);
}

function startsWith(buf: Buffer, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}

/**
 * Do these bytes carry the signature of `mime`? PNG, JPEG, GIF (87a / 89a), WEBP (RIFF....WEBP) and AVIF (an ISO-BMFF `ftyp` box
 * whose major brand is `avif` or `avis`). The upload pipeline's sniffer (media/mime-allowlist.ts) does not know AVIF and takes any
 * `ftyp` for MP4, which is exactly why the preview carries its own table: a mime the row declares but the bytes do not bear is refused.
 */
export function rasterSignatureMatches(buf: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return buf.length >= 6 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a");
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

/** The one 404: unknown, another site, another tenant, accepted, rejected, deleted, not clean. No existence oracle. */
export function previewNotFound(): ControlProblem {
  return new ControlProblem(404, "media-asset-not-found", "Media asset not found", "No such media asset on this site.");
}

/** 415: a quarantined clean asset of a type that is never previewed. Carries the stored mime and nothing else about the asset. */
export function previewUnsupported(mime: string): ControlProblem {
  return new ControlProblem(415, "media-preview-unsupported", "No preview for this type", "Only raster images (png, jpeg, gif, webp, avif) are previewed.", { mime });
}

/** 413: over the cap. */
export function previewTooLarge(): ControlProblem {
  return new ControlProblem(413, "media-preview-too-large", "Too large to preview", `Only images up to ${PREVIEW_MAX_BYTES} bytes are previewed.`);
}
