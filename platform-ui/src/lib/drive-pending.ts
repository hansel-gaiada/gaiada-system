import "server-only";
// DW-6i UI: the Drive OAuth flow's return path, kept in a short-lived httpOnly cookie (the way search's flow keeps its own).
// Google's redirect back to `/api/google-drive/callback` is a bare navigation carrying only `code`/`state`/`error`, so the page the
// person started from has to be remembered here. 10-minute TTL matches the backend's own state TTL. The value is validated on the
// way in and again on the way out (`parseDrivePending`), so it can never name another site.
import { cookies } from "next/headers";
import { HOST_COOKIES, clearHostCookie, readHostCookie, setHostCookie } from "./cookieNames";
import { parseDrivePending, type DrivePending } from "./drive";
import { sanitizeReturnTo } from "./returnTo";

export async function setDrivePending(returnPath: string): Promise<void> {
  const jar = await cookies();
  setHostCookie(jar, HOST_COOKIES.driveOAuthPending, JSON.stringify({ returnPath: sanitizeReturnTo(returnPath) }), { maxAge: 600 });
}

/** Reads and clears the pending cookie. Missing or malformed is `null`; the caller falls back to a safe default path. */
export async function consumeDrivePending(): Promise<DrivePending | null> {
  const jar = await cookies();
  const raw = readHostCookie(jar, HOST_COOKIES.driveOAuthPending);
  clearHostCookie(jar, HOST_COOKIES.driveOAuthPending);
  return parseDrivePending(raw);
}
