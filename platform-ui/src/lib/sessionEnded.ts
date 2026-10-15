// DW-7h (FRONTEND-BFF-CONTRACT §52.4) — what happens when IT signs a session out or blocks a login. platform-nest
// refuses the token with 401 `{reason: "session_revoked"}`; the person must end up signed out, on the sign-in page,
// told why.
//
// A Server Component cannot delete a cookie, so the refusal REDIRECTS to `/auth/ended` (app/auth/ended/route.ts), a
// route handler that can: it clears the ERP session cookie and lands on `/login?reason=session_revoked`.
//
// ── WHY THE ERROR IS A PlatformError AND A REDIRECT AT ONCE ─────────────────────────────────────────────────────────
// `next/navigation`'s `redirect()` works by throwing, and Next recognises the throw by its `digest` alone
// (`isRedirectError` checks the shape, not the class). platformFetch has ~130 callers, and many catch its errors:
// `.catch(() => [])` on a read, `e instanceof PlatformError ? e.message : …` in an action. A bare redirect error
// thrown into those would be swallowed, or would show "NEXT_REDIRECT" as an error message. So the refusal stays a
// PlatformError (status 401, `reason`, the human message) and CARRIES the digest `redirect()` produced:
//   * uncaught (a page, a layout that rethrows, an action that lets it through), Next performs the redirect;
//   * caught as a PlatformError, the caller shows "Your session was ended by IT. Sign in again.", the right words.
// The digest is taken from Next's own `redirect()` at the moment of the refusal, never written by hand, so it follows
// whatever format and redirect type (push in an action, replace elsewhere) this Next version uses.
import { redirect } from "next/navigation";

export const SESSION_REVOKED_REASON = "session_revoked";
export const SESSION_REVOKED_MESSAGE = "Your session was ended by IT. Sign in again.";
export const SESSION_ENDED_PATH = "/auth/ended";

/** Give `err` the redirect digest for `/auth/ended`, and return it. */
export function withSessionEndedRedirect<E extends Error>(err: E): E {
  try {
    redirect(SESSION_ENDED_PATH);
  } catch (r) {
    const digest = (r as { digest?: unknown }).digest;
    if (typeof digest === "string") Object.assign(err, { digest });
  }
  return err;
}

/** Is this the refusal above? For the few `.catch` sites that must let it through (the app and portal layouts). */
export function isSessionEnded(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && (e as { reason?: unknown }).reason === SESSION_REVOKED_REASON &&
    typeof (e as { digest?: unknown }).digest === "string"
  );
}

/** In a `.catch`: rethrow the session-ended refusal so Next performs its redirect; return otherwise. */
export function rethrowIfSessionEnded(e: unknown): void {
  if (isSessionEnded(e)) throw e;
}
