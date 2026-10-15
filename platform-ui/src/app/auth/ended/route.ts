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
// `/auth/refresh`, so this cannot loop. It only ever REMOVES a cookie and reads nothing, so reaching it by any other
// way does no more than sign the visitor out.
export const runtime = "nodejs";

export function GET(req: NextRequest) {
  const url = new URL("/login", req.nextUrl.origin);
  url.searchParams.set("reason", SESSION_REVOKED_REASON);
  const res = NextResponse.redirect(url);
  clearHostCookie(res.cookies, HOST_COOKIES.session);
  return res;
}
