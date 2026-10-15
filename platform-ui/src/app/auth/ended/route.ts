import { NextResponse, type NextRequest } from "next/server";
import { clearHostCookie, HOST_COOKIES } from "@/lib/cookieNames";
import { SESSION_REVOKED_REASON } from "@/lib/sessionEnded";

// DW-7h (FRONTEND-BFF-CONTRACT §52.4) — where a session IT signed out (or a login IT blocked) lands. platform-nest
// refused the token with 401 `session_revoked`; platformFetch redirected here (lib/sessionEnded.ts), because a Server
// Component cannot delete a cookie and a route handler can.
//
// It clears the ERP session cookie, exactly as `/auth/refresh` does on a failed refresh, and lands on the sign-in PAGE
// with the reason, which says "Your session was ended by IT. Sign in again." Not `/auth/login`: that route has no page;
// it sends the browser straight to Keycloak, so the message would never be seen.
//
// Under `/auth/`, which the proxy lets through with or without a session (src/proxy.ts) and never redirects to
// `/auth/refresh`, so this cannot loop. It only ever REMOVES a cookie and reads nothing.
//
// Only a navigation from this site signs the visitor out. The redirect from platformFetch arrives as `same-origin`, and a
// typed or bookmarked URL as `none`. A link planted on another site (`cross-site`, or `same-site` from a sibling
// subdomain) would otherwise sign people out at will, so it only lands on the home page with the session kept. A browser
// that sends no `Sec-Fetch-Site` at all is believed: the header is what tells us, and without it the safe default for a
// route that only signs out is to do what was asked.
export const runtime = "nodejs";

const SIGN_OUT_FROM = new Set(["same-origin", "none"]);

export function GET(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && !SIGN_OUT_FROM.has(site)) {
    return NextResponse.redirect(new URL("/", req.nextUrl.origin));
  }
  const url = new URL("/login", req.nextUrl.origin);
  url.searchParams.set("reason", SESSION_REVOKED_REASON);
  const res = NextResponse.redirect(url);
  clearHostCookie(res.cookies, HOST_COOKIES.session);
  return res;
}
