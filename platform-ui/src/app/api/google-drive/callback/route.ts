import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { platformFetch, PlatformError } from "@/lib/platform";
import { consumeDrivePending } from "@/lib/drive-pending";
import { callbackPath, driveErrorToken, type DriveOutcome } from "@/lib/drive";
import { sanitizeReturnTo } from "@/lib/returnTo";

// DW-6i (BFF §42.3, §42.8 deviation 1) — the front-end half of the Google Drive OAuth flow, built on the same pattern as search's
// (`app/api/search/google/callback/route.ts`). The backend's `GET api/google-drive/oauth/callback` answers JSON, not a redirect, and
// Google's own redirect is a bare top-level navigation with no Authorization header. So THIS route is the page registered at Google
// as `GOOGLE_DRIVE_REDIRECT_URI` (`<ERP origin>/api/google-drive/callback`, `DRIVE_CALLBACK_UI_PATH` in lib/drive.ts). It:
//   1. reads code/state/error off its own URL (exactly what Google sent back);
//   2. recovers where the person started from the short-lived cookie `startDriveConnectAction` set; that is the ONLY source of the
//      return target: nothing in this URL's query is ever used as a redirect target, and the cookie value is re-validated as a
//      same-origin path here, at the point the redirect is issued;
//   3. calls the backend callback as an ordinary authenticated request (this browser's own session, the one that began the flow);
//   4. redirects back to the Tools & connections page with a coarse flag `driveOAuth=connected|denied|error`, plus
//      `driveOAuthReason=<token>` only when the backend refused with one of its own known tokens. Never the code, state or a token.
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const reqUrl = new URL(req.url);
  const origin = reqUrl.origin;
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");
  const error = reqUrl.searchParams.get("error");

  const pending = await consumeDrivePending();
  const returnPath = sanitizeReturnTo(pending?.returnPath ?? "/departments");

  const finish = (outcome: DriveOutcome, reason?: string | null) => {
    const url = new URL(returnPath, origin);
    url.searchParams.set("driveOAuth", outcome);
    if (reason) url.searchParams.set("driveOAuthReason", reason);
    return NextResponse.redirect(url);
  };

  const userId = await getSessionUserId();
  if (!userId) return NextResponse.redirect(new URL("/login", origin));

  // The person pressed Cancel at Google: a normal outcome, not a refusal.
  if (error) return finish("denied");
  if (!code || !state) return finish("error", "drive_state_invalid");

  try {
    const result = await platformFetch<{ status?: string }>(callbackPath(code, state), userId);
    if (result?.status === "connected") return finish("connected");
    if (result?.status === "denied") return finish("denied");
    return finish("error");
  } catch (e) {
    if (e instanceof PlatformError) return finish("error", driveErrorToken(e.message, e.reason));
    throw e;
  }
}
