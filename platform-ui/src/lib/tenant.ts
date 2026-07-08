"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Me } from "./platform";

const COOKIE = "gaiada_tenant";

export async function getActiveTenant(me: Me): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw && me.companies.some((c) => c.id === raw)) return raw;
  return me.companies[0]?.id ?? null;
}

export async function switchTenant(formData: FormData): Promise<void> {
  const id = String(formData.get("tenantId") ?? "");
  const jar = await cookies();
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
  });
  redirect("/");
}
