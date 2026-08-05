import { NextResponse, type NextRequest } from "next/server";
import { sealSession, SESSION_COOKIE } from "@/lib/session";

// MAIL-10 (design §9) — the landing page a clicked magic-link email opens. Consumes the token
// against platform-nest's single-use `POST /auth/magic-link/consume`, then mints EXACTLY the same
// cookie shape dev-login uses (`sealSession(userId)` — a plain userId payload, not the OIDC-wrapped
// `encodeSession(...)` form auth/callback/route.ts produces): a magic link is a login convenience,
// not an IdP session, so it deliberately rides the "dev" cookie shape regardless of AUTH_MODE.
//
// M11 restated at the one place a browser actually lands on this flow: this route NEVER decides
// anything on the ERP's behalf — it only turns a valid, single-use token into a session cookie and
// redirects to "/". There is no approval affordance here and there must never be one.
export const runtime = "nodejs";

function origin(req: NextRequest): string {
  return process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || new URL(req.url).origin;
}

function fail(req: NextRequest, reason: string) {
  return NextResponse.redirect(new URL(`/login?error=${reason}`, origin(req)));
}

export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token");
  if (!token) return fail(req, "magic");

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  // Forwarded purely for the backend's audit trail (consume is not rate-limited the way mint is);
  // harmless if the upstream proxy hasn't set it.
  const forwardedFor = req.headers.get("x-forwarded-for") ?? "";

  let res: Response;
  try {
    res = await fetch(`${base}/auth/magic-link/consume`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}`,
        ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
      },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
  } catch {
    return fail(req, "magic");
  }
  if (!res.ok) return fail(req, "magic");

  const { userId } = (await res.json()) as { userId?: string };
  if (!userId) return fail(req, "magic");

  const out = NextResponse.redirect(new URL("/", origin(req)));
  out.cookies.set(SESSION_COOKIE, sealSession(userId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  return out;
}
