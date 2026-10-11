"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Me } from "./platform";
import { readHostCookie, setHostCookie, HOST_COOKIES } from "./cookieNames";

export async function getActiveTenant(me: Me): Promise<string | null> {
  const jar = await cookies();
  const raw = readHostCookie(jar, HOST_COOKIES.tenant);
  if (raw && me.companies.some((c) => c.id === raw)) return raw;
  return me.companies[0]?.id ?? null;
}

// An optional `return` field sends the person somewhere other than the dashboard after switching
// (PV1-06b: the Group page opens a company's own report). Only a same-site path is honoured, one
// leading "/" and not "//" or "/\\", so the field can never become an open redirect.
function safeReturn(raw: FormDataEntryValue | null): string {
  const v = typeof raw === "string" ? raw : "";
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/";
}

export async function switchTenant(formData: FormData): Promise<void> {
  const id = String(formData.get("tenantId") ?? "");
  const jar = await cookies();
  setHostCookie(jar, HOST_COOKIES.tenant, id);
  redirect(safeReturn(formData.get("return")));
}
