// DW-8h (contract §45.2): the pieces of a file upload that the browser and the server action share.
// No server-only import here, so the Attachments component can use it.

/** The platform's limit for one stored file (files.controller `MAX_BYTES`). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const FILE_TOO_BIG = "Files can be at most 25 MB.";
export const SCRUBBED_NOTICE = "Personal data was removed from the stored copy.";

/** `1.4 MB`, `12 KB`, `300 B`: one decimal for MB and above, none below. */
// `files.byte_size` is a Postgres bigint, which the platform's JSON carries as a STRING ("47"). Taking only numbers made every
// file read "0 B" (seen live on 398), so a numeric string counts too.
export function formatFileSize(bytes: number | string | null | undefined): string {
  const v = typeof bytes === "string" && bytes.trim() !== "" ? Number(bytes) : bytes;
  const n = typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The sentence for a refused add (403, 404, 409). `null` when the status is none of those. */
export function addRefusalText(status: number, entityType: string, message: string): string | null {
  if (status === 403) return entityType === "work_request" ? "Only the people on this request can add files." : "You can't add files here.";
  if (status === 404) return "This item no longer exists.";
  if (status === 409 && message === "target_closed") return "This item is closed, so it takes no new files.";
  return null;
}

/** The panel's sentence for a read that did not return files. */
export function readFailureText(kind: "forbidden" | "unavailable", reason?: string): string {
  if (kind === "forbidden") return "You can't see this item's files.";
  if (reason === "target_not_found") return "This item no longer exists.";
  return "Files can't be read right now.";
}
