import { NextResponse, type NextRequest } from "next/server";

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
  const isPublic =
    pathname.startsWith("/login") || pathname.startsWith("/step-up") || pathname.startsWith("/auth") ||
    pathname.startsWith("/print");
  const hasSession = Boolean(req.cookies.get("gaiada_session")?.value);
  if (!isPublic && !hasSession) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next|fonts|favicon.ico).*)"] };
