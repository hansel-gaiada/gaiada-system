import "server-only";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, type Me } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { deptTabs, toolkitFor } from "@/lib/deptToolkits";
import { activeCompany } from "@/lib/companyContext";

/**
 * What every Website-workspace page needs before it reads anything: the signed-in user, the active
 * company (the ERP tenant — NOT the WebDesk tenant slug, which arrives in the route), and proof that
 * this department's toolkit actually advertises the Website → Content tab. The last check is the
 * repo's own idiom (`repositories/page.tsx`): a page behind a tab must 404 for a department whose
 * toolkit does not have it, so a hand-typed URL cannot reach a surface the console does not offer.
 */
export interface WebsiteCtx {
  userId: string;
  me: Me;
  company: string;
  deptId: string;
  /** `/departments/:deptId/website/content` */
  contentBase: string;
  /** `/departments/:deptId/website/media` (WSK-43c) */
  mediaBase: string;
  /** `/departments/:deptId/website/analytics` (M5-A4) */
  analyticsBase: string;
  /** `/departments/:deptId/website/leads` (M5-L6) */
  leadsBase: string;
  /** `/departments/:deptId/website/writers` (M5-W2e) */
  writersBase: string;
}

/** `tab` is the Website tab the page lives under: a page behind a tab 404s for a department whose toolkit does not have it. */
export async function requireWebsiteCtx(deptId: string, tab: "content" | "media" | "analytics" | "leads" | "writers" = "content"): Promise<WebsiteCtx> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const company = await getActiveTenant(me);
  if (!company) notFound();
  const dept = await getDepartment(userId, company, deptId);
  if (!dept) notFound();
  if (!deptTabs(toolkitFor(activeCompany(me, company)?.vertical, dept.name)).some((t) => t.key === tab)) notFound();
  return { userId, me, company, deptId, contentBase: `/departments/${deptId}/website/content`, mediaBase: `/departments/${deptId}/website/media`, analyticsBase: `/departments/${deptId}/website/analytics`, leadsBase: `/departments/${deptId}/website/leads`, writersBase: `/departments/${deptId}/website/writers` };
}
