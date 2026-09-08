import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session-server";
import { sealSession, encodeSession, SESSION_COOKIE } from "@/lib/session";
import { sanitizeReturnTo } from "@/lib/returnTo";

// Silent OIDC access-token refresh (fault register finding 01, 2026-09-08).
//
// ── THE BUG THIS CLOSES ──────────────────────────────────────────────────────────────────────────
// `auth/callback` has always sealed `refreshToken` and `expiresAt` into the session cookie, and
// NOTHING in this app ever read either one. `platformFetch` sent the access token verbatim forever.
// The realm's `accessTokenLifespan` is 3600s, so one hour after signing in every backend call began
// returning 401 - while `middleware.ts` checked only that the cookie EXISTED, so the user was never
// redirected and never logged out. They just got an ERP where every page threw, with no way back
// except finding `/auth/login` by hand. Every user, every hour, every day.
//
// (The 3600s lifetime is itself a symptom: Keycloak's default is 300s, and raising it 12x is what
// you do when refresh is broken. Once this route is proven in production that should come back down
// - a long-lived access token is also a long revocation window.)
//
// ── WHY A ROUTE HANDLER AND NOT `platformFetch` ──────────────────────────────────────────────────
// The obvious fix - refresh inside `platformFetch` when the token is stale - CANNOT WORK. That
// helper is called from ~131 files, overwhelmingly from Server Components during a page render, and
// Next only permits `cookies().set()` in Server Actions, Route Handlers and Middleware. A refresh
// there would obtain a new token and have nowhere to persist it, so the next request would refresh
// again. Route handlers can set cookies; hence this file.
//
// ── WHY MIDDLEWARE REDIRECTS HERE RATHER THAN DOING IT ITSELF ────────────────────────────────────
// Middleware runs on Edge, which cannot load `node:crypto`, so it cannot verify or re-sign the
// session HMAC. It CAN cheaply read the expiry (`lib/session-expiry.ts`) and hand off. That split
// also serialises the refresh: navigations arrive one at a time, so a page's parallel data fetches
// never race to refresh the same token.
//
// ── FAIL-OPEN, NEVER FAIL-LOOP ───────────────────────────────────────────────────────────────────
// Every failure path lands on `/auth/login`, NOT back on the page. If it returned to the page with
// the cookie still stale, middleware would redirect here again - forever. `/auth/login` re-runs the
// full authorization-code flow, which against a live Keycloak SSO session (10h, vs the 1h access
// token) completes without a password prompt and is invisible to the user. So the worst outcome of
// a broken refresh is the behaviour we would have had anyway, plus one redirect.
export const runtime = "nodejs";

function backToLogin(req: NextRequest, returnTo: string, reason: string): NextResponse {
  const url = new URL("/auth/login", req.nextUrl.origin);
  if (returnTo !== "/") url.searchParams.set("return", returnTo);
  const res = NextResponse.redirect(url);
  // Clear the stale session so a failed refresh cannot leave a cookie that keeps triggering this
  // route. Belt to `/auth/login`'s braces: the redirect alone breaks the loop, this removes the
  // cause. `reason` rides on the response for debugging without leaking into the URL.
  res.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  res.headers.set("x-gaiada-refresh", `failed:${reason}`);
  return res;
}

export async function GET(req: NextRequest) {
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("return"));

  // Verifies the HMAC properly (node:crypto) - this is the check middleware could not do. A forged
  // or tampered cookie resolves to null here and gets sent to a real sign-in.
  const session = await getSession();
  if (!session || session.mode !== "oidc") return backToLogin(req, returnTo, "no-oidc-session");
  if (!session.refreshToken) return backToLogin(req, returnTo, "no-refresh-token");

  const tokenUrl =
    process.env.OIDC_TOKEN_URL ?? "http://localhost:8080/realms/gaiada/protocol/openid-connect/token";
  const clientId = process.env.OIDC_CLIENT_ID ?? "gaiada-ui";

  let tok: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    // `gaiada-ui` is a PUBLIC client (PKCE, no secret) - verified in the realm export - so the
    // refresh grant carries only client_id + refresh_token. No credential is read here, which is
    // also why this route is safe to reach without one.
    const tr = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: session.refreshToken,
      }),
      cache: "no-store",
      // Bounded on purpose: this sits in front of a page load, so a hung IdP must not hold the
      // user's navigation open. Falling through to /auth/login is strictly better than hanging.
      signal: AbortSignal.timeout(8_000),
    });
    if (!tr.ok) return backToLogin(req, returnTo, `idp-${tr.status}`);
    tok = (await tr.json()) as typeof tok;
  } catch {
    return backToLogin(req, returnTo, "idp-unreachable");
  }

  if (!tok.access_token) return backToLogin(req, returnTo, "no-access-token");

  const sealed = sealSession(
    encodeSession({
      mode: "oidc",
      userId: session.userId,
      accessToken: tok.access_token,
      // Keycloak returns a fresh refresh_token; keep the old one when it does not (the realm does
      // not enable rotation today, but relying on that would break silently if someone turns
      // `revokeRefreshToken` on).
      refreshToken: tok.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + (tok.expires_in ?? 300) * 1000,
    }),
  );

  const res = NextResponse.redirect(new URL(returnTo, req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, sealed, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  res.headers.set("x-gaiada-refresh", "ok");
  return res;
}
