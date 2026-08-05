import { NextResponse, type NextRequest } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { sanitizeReturnTo } from "@/lib/returnTo";

// OIDC Authorization-Code + PKCE initiation. Redirects the browser to Keycloak's auth endpoint
// and stashes the PKCE verifier + state in a short-lived httpOnly cookie for the callback.
//
// UI-01: also carries the caller's `?return=` deep-link target through the round trip. It rides in
// the SAME httpOnly cookie as the verifier/state (never as a URL param to Keycloak, which the
// browser and any intermediary can see/tamper) as a third base64url segment — base64url never
// contains ".", so the existing `.`-delimited cookie shape stays a clean 3-way split with no
// ambiguity. The callback route re-validates it at consumption time; this route only decides what
// gets carried, not what's safe to redirect to.
export const runtime = "nodejs";

const b64url = (buf: Buffer) => buf.toString("base64url");

export function GET(req: NextRequest) {
  const authUrl = process.env.OIDC_AUTH_URL ?? "http://localhost:8080/realms/gaiada/protocol/openid-connect/auth";
  const clientId = process.env.OIDC_CLIENT_ID ?? "gaiada-ui";
  const redirectUri = process.env.OIDC_REDIRECT_URI ?? "http://localhost:3005/auth/callback";

  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("return"));

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const url = new URL(authUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  const res = NextResponse.redirect(url.toString());
  const returnB64 = Buffer.from(returnTo, "utf8").toString("base64url");
  res.cookies.set("oidc_pkce", `${verifier}.${state}.${returnB64}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
