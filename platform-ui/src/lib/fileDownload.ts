// PV3-08 follow-up — staff file downloads (a contract's PDF, a payment's proof of payment).
//
// The platform serves a file's bytes at `GET /api/:t/files/:id/content` (platform-nest files.controller.ts),
// authorizing on the file AND on the entity it hangs off (a contract's or a payment's Cerbos `read`). The
// browser cannot call it (the session token is server-side), so `app/api/files/[fileId]/route.ts` proxies it
// with the caller's own session. This module holds the pure parts both that route and the billing rows use.
// Client-safe: no server-only imports.

/** Where a staff browser fetches a file's bytes. The id is encoded; the route validates it again. */
export function fileDownloadHref(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}`;
}

/** A file id is a uuid / short token. Anything else (a `..`, a slash, a query) never reaches the platform. */
export function isPlausibleFileId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** What the person reads when the platform refuses or cannot serve the file. Always words, never a bare
 *  status code and never a 500: the link is opened in a tab, and a tab that shows "platform 403" reads as a bug. */
export function fileRefusalMessage(status: number): string {
  if (status === 401) return "Your session has expired. Sign in again, then open the file once more.";
  if (status === 403) return "You do not have permission to download this file. It is only available to people who can read the record it belongs to.";
  if (status === 404) return "This file cannot be found. It may have been removed, or it is a reference with no stored copy.";
  if (status === 400) return "That is not a valid file link.";
  return "The platform could not serve this file just now. Try again in a moment.";
}

/** The response headers every staff file download carries. Not negotiable, and the reason they exist:
 *  a stored file is user-controlled content served from our own origin.
 *   - `attachment`: the browser saves it and never renders it in a page of ours (no stored XSS from an
 *     uploaded .html / .svg). The platform's own filename (RFC 5987-encoded) is kept when it sent one.
 *   - `nosniff`: the browser must not second-guess the content type into something executable.
 *   - `sandbox` CSP: if it is ever rendered anyway, it runs with no powers.
 *   - `private, no-store`: a contract is not cached by a shared proxy or kept on disk by the browser. */
export function downloadHeaders(upstream: Headers): Record<string, string> {
  const disposition = upstream.get("content-disposition");
  const h: Record<string, string> = {
    "content-type": upstream.get("content-type") || "application/octet-stream",
    "content-disposition": disposition && /^\s*attachment\b/i.test(disposition) ? disposition : 'attachment; filename="download"',
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "private, no-store",
  };
  const len = upstream.get("content-length");
  if (len) h["content-length"] = len;
  return h;
}
