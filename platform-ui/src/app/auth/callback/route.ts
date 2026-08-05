import { NextResponse, type NextRequest } from "next/server";
import { sealSession, encodeSession, SESSION_COOKIE } from "@/lib/session";
import { sanitizeReturnTo } from "@/lib/returnTo";

// OIDC callback: verify state, exchange the code (with the PKCE verifier) for tokens, resolve the
// platform user (the platform auto-provisions/links by IdP-verified email), then seal an OIDC
// session cookie. On any failure, bounce back to /login with a reason.
//
// UI-01: the third `.`-segment of the `oidc_pkce` cookie (set by /auth/login) carries the
// base64url-encoded deep-link target the user originally requested. Re-validated here via
// `sanitizeReturnTo` at the actual point of redirect — never trust that a value merely because it
// round-tripped through our own httpOnly cookie; consumption-time re-validation is the point.
export const runtime = "nodejs";

// Behind a reverse proxy, `req.url` is built from the server's own bind address, so redirects come
// back as https://<container-id>:3005/ — an address that resolves only inside Docker. The user
// authenticates successfully and is then sent nowhere, which presents as "login is broken".
// PUBLIC_ORIGIN (e.g. https://erp.gaiada.online) pins redirects to the address the browser used.
function origin(req: NextRequest): string {
  return process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || new URL(req.url).origin;
}

function fail(req: NextRequest, reason: string) {
  const res = NextResponse.redirect(new URL(`/login?error=${reason}`, origin(req)));
  res.cookies.set("oidc_pkce", "", { maxAge: 0, path: "/" });
  return res;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const [verifier, savedState, returnB64] = (req.cookies.get("oidc_pkce")?.value ?? "").split(".");
  if (!code || !state || !verifier || state !== savedState) return fail(req, "sso");

  let returnTo = "/";
  if (returnB64) {
    try {
      returnTo = sanitizeReturnTo(Buffer.from(returnB64, "base64url").toString("utf8"));
    } catch {
      returnTo = "/";
    }
  }

  const tokenUrl = process.env.OIDC_TOKEN_URL ?? "http://localhost:8080/realms/gaiada/protocol/openid-connect/token";
  const clientId = process.env.OIDC_CLIENT_ID ?? "gaiada-ui";
  const redirectUri = process.env.OIDC_REDIRECT_URI ?? "http://localhost:3005/auth/callback";

  const tr = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
    cache: "no-store",
  });
  if (!tr.ok) return fail(req, "token");
  const tok = (await tr.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  const accessToken = tok.access_token;
  const expiresAt = Date.now() + (tok.expires_in ?? 300) * 1000;

  // Resolve (and auto-provision/link) the platform user by presenting the IdP token.
  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  const me = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!me.ok) return fail(req, "provision");
  const { userId } = (await me.json()) as { userId: string };
  if (!userId) return fail(req, "provision");

  const sealed = sealSession(
    encodeSession({ mode: "oidc", userId, accessToken, refreshToken: tok.refresh_token ?? "", expiresAt }),
  );
  const res = NextResponse.redirect(new URL(returnTo, origin(req)));
  res.cookies.set(SESSION_COOKIE, sealed, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  res.cookies.set("oidc_pkce", "", { maxAge: 0, path: "/" });
  return res;
}
