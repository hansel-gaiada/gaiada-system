"use server";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant, switchTenant } from "@/lib/tenant";
import { activeCompany, isRootCompany } from "@/lib/companyContext";

// `/reports/company` reads the ACTIVE company (the tenant cookie), so opening another company's
// Company Report means switching to it first. This reuses the top-bar switcher's own server action,
// `switchTenant`, so there is one place that writes the cookie, and passes its `return` field so the
// switch lands on the report instead of the dashboard.
//
// The target must be a company of the ACTIVE root. Not a security boundary (the report route and the
// BFF gate the read); it only refuses to switch somewhere this page never offered.
export async function openCompanyReport(formData: FormData): Promise<void> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const active = activeCompany(me, await getActiveTenant(me));
  const target = me.companies.find((c) => c.id === String(formData.get("tenantId") ?? ""));
  if (!active || !isRootCompany(active) || !target || target.rootCompanyId !== active.id) redirect("/group/reports");

  formData.set("return", "/reports/company");
  await switchTenant(formData);
}
