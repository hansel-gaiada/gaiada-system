import { NextResponse, type NextRequest } from "next/server";
import { sealSession, encodeSession, SESSION_COOKIE } from "@/lib/session";

// OIDC callback: verify state, exchange the code (with the PKCE verifier) for tokens, resolve the
// platform user (the platform auto-provisions/links by IdP-verified email), then seal an OIDC
// session cookie. On any failure, bounce back to /login with a reason.
export const runtime = "nodejs";

function fail(req: NextRequest, reason: string) {
  const res = NextResponse.redirect(new URL(`/login?error=${reason}`, req.url));
  res.cookies.set("oidc_pkce", "", { maxAge: 0, path: "/" });
  return res;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const [verifier, savedState] = (req.cookies.get("oidc_pkce")?.value ?? "").split(".");
  if (!code || !state || !verifier || state !== savedState) return fail(req, "sso");

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
  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.set(SESSION_COOKIE, sealed, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  res.cookies.set("oidc_pkce", "", { maxAge: 0, path: "/" });
  return res;
}
