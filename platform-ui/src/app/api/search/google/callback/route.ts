import { NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session-server";
import { getActiveTenant } from "@/lib/tenant";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { consumeGoogleOAuthPending } from "@/lib/searchMarketingActions";
import type { GoogleConnectionView } from "@/lib/searchMarketingShared";

// SM-25a's front-end half — search-google-oauth.controller.ts's own header note names this
// requirement explicitly: "the URL registered as Google's redirect_uri therefore points at a fixed,
// tenant-agnostic page the FRONT END owns... which calls this endpoint as an ordinary authenticated
// BFF request... passing `provider` from its own client-side flow context (Google's redirect never
// carries it)." This route IS that page — the only thing `GOOGLE_OAUTH_REDIRECT_URI` should ever be
// set to.
//
// Google's own redirect is a bare top-level browser navigation: no Authorization header, no way to
// carry a custom query param it did not itself define. So this route:
//   1. Reads code/state/error/error_description off ITS OWN url (exactly what Google sent back).
//   2. Recovers `provider` (and where to send the operator next) from the short-lived cookie
//      `startGoogleAuthorization` stashed before redirecting to the issuer (searchMarketingActions.ts).
//   3. Calls platform-nest's tenant-agnostic `GET api/search/google/oauth/callback` as an ordinary
//      authenticated BFF request (this browser's own session — the same one that started the flow),
//      passing `provider` itself.
//   4. Redirects the browser back to the Connections tab it started from, carrying a coarse
//      success/denied/error flag in the query string for the page to render a one-line status —
//      never the raw code/state/tokens, which never reach this response's own redirect target.
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const reqUrl = new URL(req.url);
  const origin = reqUrl.origin;
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");
  const error = reqUrl.searchParams.get("error");
  const errorDescription = reqUrl.searchParams.get("error_description");

  const pending = await consumeGoogleOAuthPending();
  const returnPath = pending?.returnPath ?? "/departments";

  const finish = (status: string, detail?: string) => {
    const url = new URL(returnPath, origin);
    url.searchParams.set("googleOAuth", status);
    if (detail) url.searchParams.set("googleOAuthDetail", detail);
    return NextResponse.redirect(url);
  };

  const userId = await getSessionUserId();
  if (!userId) return NextResponse.redirect(new URL("/login", origin));

  if (error) {
    // The user declined consent at the issuer — a normal, non-throwing OAuth outcome, not a refusal
    // of this route. Reported so the Connections tab can say "connection not completed", not an error.
    return finish("denied", errorDescription ?? error);
  }
  if (!code || !state) {
    return finish("error", "missing code or state — the flow may have expired; try connecting again");
  }
  if (!pending) {
    // Cookie missing/expired/malformed — the callback has nothing to tell platform-nest which
    // provider this is for, and platform-nest's own state TTL (10 min, same as this cookie's) has
    // almost certainly already expired the state row too. Reported honestly rather than guessed at.
    return finish("error", "the connection attempt expired — try connecting again");
  }

  const me = await getMe(userId).catch(() => null);
  const tenant = me ? await getActiveTenant(me) : null;
  if (!tenant) return finish("error", "no active company selected");

  try {
    const result = await platformFetch<GoogleConnectionView | { status: "denied"; error: string; errorDescription: string | null }>(
      `/api/search/google/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}&provider=${encodeURIComponent(pending.provider)}`,
      userId,
    );
    // GoogleConnectionView also has a `status: string` field (its own link state, e.g. "linked"),
    // so narrowing on `status === "denied"` alone is not a safe discriminant — `error` only exists
    // on the denied shape.
    if ("error" in result) {
      return finish("denied", result.errorDescription ?? result.error);
    }
    return finish("connected");
  } catch (e) {
    if (e instanceof PlatformError) return finish("error", e.message);
    throw e;
  }
}
