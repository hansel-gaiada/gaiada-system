import { NextResponse, type NextRequest } from "next/server";
import { sanitizeReturnTo } from "@/lib/returnTo";
import { peekSessionExpiry, needsRefresh } from "@/lib/session-expiry";

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

  // ── SILENT TOKEN REFRESH (finding 01, 2026-09-08) ──────────────────────────────────────────────
  // The access token expires an hour after sign-in and nothing renewed it, so every backend call
  // started 401-ing while this middleware — which only ever checked that the cookie EXISTED — kept
  // waving the request through. The user was never logged out, just broken. See
  // `app/auth/refresh/route.ts` for why the renewal lives in a route handler and not here.
  //
  // STRICTLY ADDITIVE AND FAIL-OPEN. Everything below can only ADD a redirect to /auth/refresh; any
  // uncertainty (dev-mode session, malformed cookie, unreadable expiry, thrown error) falls through
  // to `NextResponse.next()`, i.e. exactly the behaviour that shipped before this block existed.
  // This code runs on every request in the app, so its failure mode must be "does nothing", never
  // "breaks the site".
  //
  // GET ONLY, AND THAT IS LOAD-BEARING. A 307 on a POST replays the body at the new location; on a
  // Server Action that would re-submit the user's write to a route that is not expecting it. Writes
  // therefore ride the existing token — safe in practice because the navigation that rendered the
  // form refreshed first, and REFRESH_SKEW_MS leaves a 2-minute margin behind it.
  try {
    // Excluded, each for its own reason — none of these is cosmetic:
    //   /auth/*  — the refresh route itself. Redirecting it to itself is an infinite loop.
    //   /api/*   — these answer JSON and Server-Sent Events. A 307 to an HTML page is not a
    //              contract these callers can honour: a client `fetch()` would parse a redirect
    //              body as JSON, and the portal/assistant SSE streams would be torn off mid-flight.
    //              They ride the existing token; the next navigation refreshes it.
    //   /print   — the report-renderer sidecar calls it with a one-shot jobToken and NO cookies at
    //              all, by design. It would fall out below anyway (no cookie -> null expiry), but
    //              a PDF render must never be able to end up at a login page.
    const exempt =
      pathname.startsWith("/auth/") || pathname.startsWith("/api/") || pathname.startsWith("/print");
    if (req.method === "GET" && !exempt) {
      const expiresAt = peekSessionExpiry(req.cookies.get("gaiada_session")?.value);
      if (needsRefresh(expiresAt)) {
        const target = sanitizeReturnTo(`${pathname}${req.nextUrl.search}`);
        const refreshUrl = new URL("/auth/refresh", req.url);
        refreshUrl.searchParams.set("return", target);
        return NextResponse.redirect(refreshUrl);
      }
    }
  } catch {
    // Deliberately swallowed. A refresh that does not happen is yesterday's behaviour; a middleware
    // that throws is every page down.
  }

  return NextResponse.next();
}

// `office-sprites` joins `fonts` here for the same reason fonts were excluded: they are static
// public assets, not routes. /office is authenticated so the sprites were never actually exposed
// by gating them, but every one of the 24 files was running the edge middleware on each request —
// pure overhead on a path that has no session to check, and it also puts a redirect in front of
// an asset that should just be cacheable.
// `office-env` (the 135-file Waha environment pack, 2026-08-24) joins them for the same reason,
// and it is worth recording that it did NOT join them when the pack landed: the assets were
// committed, deployed, and served 307-to-login to every unauthenticated request while
// `office-sprites` beside them served 200. In a browser they still worked — the session cookie
// rides along — so nothing looked broken; the cost was 135 files running the edge middleware on
// every request and a redirect standing in front of something that should simply be cacheable.
// The comment above already said this. Adding assets means adding them here.
export const config = { matcher: ["/((?!_next|fonts|office-sprites|office-env|office-chars|favicon.ico).*)"] };
