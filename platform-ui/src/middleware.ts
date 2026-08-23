import { NextResponse, type NextRequest } from "next/server";
import { sanitizeReturnTo } from "@/lib/returnTo";

// Edge runtime can't use node:crypto — presence check only here; every page
// verifies the HMAC server-side via getSessionUserId() before using the id.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // /step-up is reachable pre-full-session (WA/Telegram users land here for
  // sensitive actions), so it's public like /login.
  // /print is the TR-20 print route (§6.3): the `report-renderer` sidecar hits it with a one-shot
  // `jobToken` and NO cookies at all, by construction — that's the whole point of the sidecar never
  // seeing a browser session. Gating it behind `hasSession` would 302 every render to /login and the
  // route's own token check (`reports-print-data.ts::getPrintPayload`) is what actually authorizes
  // the request, not this middleware.
  // /invite is the W0-5 client-portal magic link. It MUST be public: the person arriving has no
  // account yet — creating one is the entire purpose of the page — so gating it on `hasSession` would
  // 302 every invited client to /login and the flow could never complete. As with /print, the route's
  // own credential is what authorizes it: a single-use, HMAC-signed, email-bound, expiring invite
  // token verified server-side (platform-nest client-invites.ts), not this middleware.
  const isPublic =
    pathname.startsWith("/login") || pathname.startsWith("/step-up") || pathname.startsWith("/auth") ||
    pathname.startsWith("/print") || pathname.startsWith("/invite");
  const hasSession = Boolean(req.cookies.get("gaiada_session")?.value);
  if (!isPublic && !hasSession) {
    // UI-01: preserve the originally-requested deep link through the login/reauth round trip
    // (e.g. a mailed approval link with no session must not dead-end at "/" after sign-in). The
    // value we're building here is inherently path+search off req.nextUrl, but it still passes
    // through the shared validator for consistency with every other write site and to cap length.
    const target = sanitizeReturnTo(`${pathname}${req.nextUrl.search}`);
    const loginUrl = new URL("/login", req.url);
    if (target !== "/") loginUrl.searchParams.set("return", target);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

// `office-sprites` joins `fonts` here for the same reason fonts were excluded: they are static
// public assets, not routes. /office is authenticated so the sprites were never actually exposed
// by gating them, but every one of the 24 files was running the edge middleware on each request —
// pure overhead on a path that has no session to check, and it also puts a redirect in front of
// an asset that should just be cacheable.
export const config = { matcher: ["/((?!_next|fonts|office-sprites|favicon.ico).*)"] };
