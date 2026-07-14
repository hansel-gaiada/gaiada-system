import { NextResponse, type NextRequest } from "next/server";

// Edge runtime can't use node:crypto — presence check only here; every page
// verifies the HMAC server-side via getSessionUserId() before using the id.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // /step-up is reachable pre-full-session (WA/Telegram users land here for
  // sensitive actions), so it's public like /login.
  const isPublic = pathname.startsWith("/login") || pathname.startsWith("/step-up");
  const hasSession = Boolean(req.cookies.get("gaiada_session")?.value);
  if (!isPublic && !hasSession) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next|fonts|favicon.ico).*)"] };
