"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
// SESSION_COOKIE is exported from lib/session (not session-server, which is
// the request-context half) — mirrors src/app/login/actions.ts.
import { SESSION_COOKIE } from "@/lib/session";

export async function logout(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  redirect("/login");
}
