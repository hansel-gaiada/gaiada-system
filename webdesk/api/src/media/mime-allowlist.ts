// WSK-07 — MIME/type allowlist. Two independent checks, both must pass:
//   1. The declared content-type is in the allowlist FOR THE TARGET BUCKET.
//   2. The bytes actually uploaded start with the magic-number signature for that same type —
//      never trust a client-declared Content-Type alone (that is exactly how an .html/.svg-with-
//      script file gets served as "image/png" and executes in a browser).
// No new dependency was added for this (no `file-type` package in package.json) — the allowlist
// is small and fixed by design (§07's bucket purposes are narrow: images/PDFs, video, form
// attachments), so a short hand-written signature table is both sufficient and auditable in one
// screen, versus pulling in a general-purpose sniffer for a handful of formats.
import type { BucketName } from "../storage/storage.config";

export type AllowedMime =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "video/mp4"
  | "video/webm"
  | "application/msword"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const BUCKET_ALLOWLIST: Record<BucketName, ReadonlySet<AllowedMime>> = {
  media: new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]),
  video: new Set(["video/mp4", "video/webm"]),
  uploads: new Set([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ]),
  // artifacts has no client-facing upload route in this ticket (platform-internal only) — no
  // allowlist needed here; media.service.ts refuses uploads to it before this is ever consulted.
  artifacts: new Set([]),
};

export function isMimeAllowedForBucket(bucket: BucketName, mime: string): boolean {
  return BUCKET_ALLOWLIST[bucket]?.has(mime as AllowedMime) ?? false;
}

/**
 * Magic-byte sniff. Returns the canonical mime type the BYTES look like, or null if none of the
 * known signatures match. Deliberately does not attempt to detect every format in existence —
 * only the ones this allowlist ever accepts.
 */
export function sniffMime(buffer: Buffer): string | null {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // "GIF8" (87a/89a)
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    buffer.length >= 12 &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // "%PDF-"
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm"; // EBML/Matroska header
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "application/msword"; // legacy OLE
  // .docx (and any OOXML) is a zip container ("PK\x03\x04") — cannot be distinguished from a
  // generic zip by magic bytes alone; accepted here because it is the only zip-shaped type this
  // allowlist ever admits (docx). A real zip-bomb/format check belongs to a deeper content
  // inspection this ticket does not attempt — ClamAV's scan is the actual defense for malicious
  // content inside the container, not this signature check.
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  return null;
}

function startsWith(buffer: Buffer, signature: number[]): boolean {
  if (buffer.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}
