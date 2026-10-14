// DW-6i (docs/FRONTEND-BFF-CONTRACT.md §42.5) — the ONE thin Google Drive REST client: `files.get` for a file's name, type and link.
// Server side only. THE ONLY FILE IN core/google-drive THAT TALKS TO THE NETWORK (egress.test.ts pins that), and it sends exactly
// one request shape to exactly one host.
//
// ── WHERE THE SHAPES COME FROM ───────────────────────────────────────────────────────────────────
// Read on 2026-10-14. Every field below is one Google documents; nothing is guessed.
//   * Drive API v3 `files.get` (the request):
//       https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get
//       "GET https://www.googleapis.com/drive/v3/files/{fileId}", path parameter `fileId`.
//     That page does NOT document the `fields` parameter itself; it is documented here:
//       https://developers.google.com/workspace/drive/api/guides/fields-parameter
//       (a comma-separated list; "If you don't specify the fields parameter, the server returns a default set").
//   * The File resource (the response fields we read):
//       https://developers.google.com/workspace/drive/api/reference/rest/v3/files
//       `id` ("The ID of the file."), `name` ("The name of the file. This isn't necessarily unique within a folder."),
//       `mimeType` ("The MIME type of the file."), `webViewLink` ("Output only. A link for opening the file in a relevant
//       Google editor or viewer in a browser.").
//   * Errors:
//       https://developers.google.com/workspace/drive/api/guides/handle-errors
//       401 "The request contains invalid credentials" (reason `authError`: refresh the token); 403 for usage limits or
//       privileges (`rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`, `insufficientFilePermissions`, ...);
//       404 reason `notFound`: "This error occurs when the user doesn't have read access to a file, or the file doesn't exist."
//       The body is `{ error: { code, message, errors: [{ reason, message }] } }`. With the `drive.file` scope a file the person
//       did not pick answers as 404, which is why 404 is the "you cannot reach this file" answer.
//   * OAuth (token endpoint, revoke) is NOT here: it is the shared client (core/google-oauth/token-endpoint-client.ts).
//
// ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────────
//   * No retry and no backoff: one call, one answer; the caller decides (a 401 earns one forced refresh in service.ts).
//   * The access token is never logged, never put in an error message and never returned: DriveApiError carries a kind and an
//     HTTP status only. The URL is built from a fixed host, and the file id is percent-encoded, so it cannot change the host.
//   * The request is refused unless `isDriveApiUrl` accepts it (exact host, https, `/drive/v3/`).
import { config } from "../../config";
import { isDriveApiUrl, isGoogleHost } from "../google-oauth/hosts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A refusal from Drive, reduced to what a caller may branch on. NEVER carries a body, a token or a header. */
export class DriveApiError extends Error {
  constructor(
    readonly kind: "auth" | "not_found" | "unavailable",
    readonly status: number,
  ) {
    super(`google drive: ${kind} (HTTP ${status})`);
    this.name = "DriveApiError";
  }
}

/** The four documented File fields we read, exactly as Google answers them. */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink: string;
}

export const DRIVE_FILE_FIELDS = "id,name,mimeType,webViewLink";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files/";

/** Drive file ids are URL-safe: letters, digits, `_` and `-`. Anything else is not one (and is refused before any request). */
export const isDriveFileId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{5,256}$/.test(s);

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded", "quotaExceeded"]);

function reasonsOf(text: string): string[] {
  try {
    const j = JSON.parse(text) as { error?: { errors?: Array<{ reason?: unknown }> } };
    return (j.error?.errors ?? []).map((e) => (typeof e.reason === "string" ? e.reason : "")).filter(Boolean);
  } catch {
    return [];
  }
}

/** `files.get` for `fileId` with the person's own access token. Throws DriveApiError. */
export async function getDriveFile(accessToken: string, fileId: string, fetchImpl?: FetchLike): Promise<DriveFile> {
  if (!isDriveFileId(fileId)) throw new DriveApiError("not_found", 404);
  const url = `${DRIVE_FILES_URL}${encodeURIComponent(fileId)}?fields=${DRIVE_FILE_FIELDS}`;
  // The belt and braces: the URL is built from constants and an encoded id, and is checked anyway before a token rides on it.
  if (!isDriveApiUrl(url)) throw new DriveApiError("unavailable", 0);

  const doFetch: FetchLike = fetchImpl ?? ((i, init) => fetch(i, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.google.timeoutMs);
  let res: Response;
  let text: string;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: controller.signal,
    });
    text = await res.text();
  } catch {
    // Timeout, DNS or socket failure. `err` is deliberately not interpolated or kept.
    throw new DriveApiError("unavailable", 0);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw new DriveApiError("auth", 401);
  if (res.status === 404) throw new DriveApiError("not_found", 404);
  if (res.status === 403) {
    // Usage limits are Google's trouble, not "you cannot reach this file"; any other 403 is a privilege refusal.
    const rate = reasonsOf(text).some((r) => RATE_REASONS.has(r));
    throw new DriveApiError(rate ? "unavailable" : "not_found", 403);
  }
  if (res.status !== 200) throw new DriveApiError("unavailable", res.status);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DriveApiError("unavailable", 200);
  }
  const { id, name, mimeType, webViewLink } = body;
  if (typeof id !== "string" || typeof name !== "string" || typeof mimeType !== "string" || typeof webViewLink !== "string") {
    throw new DriveApiError("unavailable", 200);
  }
  // The link is shown to people and opened in a new tab: it must be an https link on a Google host, never `javascript:` or
  // anything else Drive (or something impersonating it) might hand back.
  let link: URL;
  try {
    link = new URL(webViewLink);
  } catch {
    throw new DriveApiError("unavailable", 200);
  }
  if (link.protocol !== "https:" || !isGoogleHost(webViewLink)) throw new DriveApiError("unavailable", 200);
  return { id, name, mimeType, webViewLink };
}
