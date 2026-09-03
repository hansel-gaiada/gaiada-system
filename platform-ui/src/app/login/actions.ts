"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sealSession, SESSION_COOKIE } from "@/lib/session";
import { demoIdentityFor } from "@/lib/demoIdentity";
import { sanitizeReturnTo } from "@/lib/returnTo";
import { isDemoMode } from "@/lib/demoMode";

export async function login(_prev: { error: string } | null, formData: FormData): Promise<{ error: string }> {
  const email = String(formData.get("email") ?? "").trim();
  // Re-validated here at the point of actually issuing the redirect (consumption time), not just
  // trusted because the hidden field was populated from an already-sanitized value — see UI-01.
  const returnTo = sanitizeReturnTo(String(formData.get("return") ?? "/"));
  if (!email) return { error: "Enter your email to continue." };

  // TEMP DEMO MODE — see lib/demoFixtures.ts. Select between three demo identities:
  // • "seo-staff@gaiada.com" (or email containing "seo-staff") → search_staff tier, scoped to
  //   dept-3/co-agency only (SM-38 QA-flagged gap: exercises negative-permission rendering —
  //   search.scope.write=false — in the SEO console; see demoFixtures.ts's header note on it)
  // • "gede@gaiada.com" or email containing "ic" → IC tier (Queue+Agenda Home)
  // • any other email → manager tier (Command Center Home)
  // Inert unless DEMO_MODE=1 is set locally. Checked BEFORE the "ic" substring test since neither
  // "seo-staff" nor "seo-staff@gaiada.com" contains "ic", but order still matters for clarity.
  if (isDemoMode()) {
    // Tier resolution lives in `lib/demoIdentity.ts` because this module is `"use server"` and may
    // export only async functions — a pure helper cannot live here, and the ordering it encodes is
    // load-bearing enough to need tests (see demoIdentity.test.ts).
    const userId = demoIdentityFor(email);
    const jar = await cookies();
    jar.set(SESSION_COOKIE, sealSession(userId), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
    });
    redirect(returnTo);
  }

  const base = process.env.PLATFORM_URL ?? "http://localhost:3004";
  const res = await fetch(`${base}/dev/user-by-email?email=${encodeURIComponent(email)}`, {
    headers: { authorization: `Bearer ${process.env.PLATFORM_SERVICE_TOKEN ?? ""}` },
    cache: "no-store",
  });
  if (!res.ok) return { error: "We couldn't find that account. Check the address and try again." };
  const { id } = (await res.json()) as { id: string };
  const jar = await cookies();
  jar.set(SESSION_COOKIE, sealSession(id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  redirect(returnTo);
}
