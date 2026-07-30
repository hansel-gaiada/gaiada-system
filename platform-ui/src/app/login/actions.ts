"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sealSession, SESSION_COOKIE } from "@/lib/session";

// Only allow same-app relative return paths — never an absolute/protocol URL.
function safeReturn(raw: string): string {
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export async function login(_prev: { error: string } | null, formData: FormData): Promise<{ error: string }> {
  const email = String(formData.get("email") ?? "").trim();
  const returnTo = safeReturn(String(formData.get("return") ?? "/"));
  if (!email) return { error: "Enter your email to continue." };

  // TEMP DEMO MODE — see lib/demoFixtures.ts. Select between three demo identities:
  // • "seo-staff@gaiada.com" (or email containing "seo-staff") → search_staff tier, scoped to
  //   dept-3/co-agency only (SM-38 QA-flagged gap: exercises negative-permission rendering —
  //   search.scope.write=false — in the SEO console; see demoFixtures.ts's header note on it)
  // • "gede@gaiada.com" or email containing "ic" → IC tier (Queue+Agenda Home)
  // • any other email → manager tier (Command Center Home)
  // Inert unless DEMO_MODE=1 is set locally. Checked BEFORE the "ic" substring test since neither
  // "seo-staff" nor "seo-staff@gaiada.com" contains "ic", but order still matters for clarity.
  if (process.env.DEMO_MODE === "1") {
    const lower = email.toLowerCase();
    const isSearchStaff = lower === "seo-staff@gaiada.com" || lower.includes("seo-staff");
    const isIC = email === "gede@gaiada.com" || lower.includes("ic");
    const userId = isSearchStaff ? "seo-staff" : isIC ? "gede-ic" : "demo-hansel";
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
