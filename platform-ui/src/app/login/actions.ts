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

  // TEMP DEMO MODE — see lib/demoFixtures.ts. Any email logs in as the demo
  // user; no backend call. Inert unless DEMO_MODE=1 is set locally.
  if (process.env.DEMO_MODE === "1") {
    const jar = await cookies();
    jar.set(SESSION_COOKIE, sealSession("demo-hansel"), {
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
