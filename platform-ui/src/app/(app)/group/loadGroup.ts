import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, type Me } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { guardAdminRoute } from "@/lib/adminGuard";
import { activeCompany, isRootCompany, type MeCompany } from "@/lib/companyContext";
import { getGroupReport, isForbidden, isNotFound } from "@/lib/reports-data";
import type { GroupReport } from "@/lib/groupReport";
import type { ReportPeriodKind } from "@/lib/reports";

// The two Group pages resolve the same four things before they can draw anything, so they share
// this. The page decides what each outcome looks like; this only decides which outcome it is.
//
// None of it is the security boundary: the BFF answers 403 to anyone but the root owner or
// `platform_admin`, and 404 when the id is not a root. The "not a root" branch below only saves a
// request that would 404; it is a courtesy, never the gate.
export type GroupLoad =
  | { kind: "no_company" }
  | { kind: "not_root"; me: Me; active: MeCompany }
  | { kind: "forbidden"; me: Me; active: MeCompany }
  | { kind: "ok"; me: Me; active: MeCompany; report: GroupReport };

export const GROUP_PERIOD_KINDS = ["day", "week", "month"] as const;

/** Only the calendar kinds the page offers; anything else in the URL falls back to the default. */
export function parseGroupPeriod(raw: string | undefined): Exclude<ReportPeriodKind, "custom"> {
  return (GROUP_PERIOD_KINDS as readonly string[]).includes(raw ?? "") ? (raw as Exclude<ReportPeriodKind, "custom">) : "month";
}

export async function loadGroup(periodKind: Exclude<ReportPeriodKind, "custom">, route: "/group" | "/group/reports"): Promise<GroupLoad> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  guardAdminRoute(route, me, tenant); // DW-D20: only a root owner or platform_admin may open the Group pages
  const active = activeCompany(me, tenant);
  if (!active) return { kind: "no_company" };
  if (!isRootCompany(active)) return { kind: "not_root", me, active };

  const today = new Date().toISOString().slice(0, 10);
  try {
    const report = await getGroupReport(active.id, userId, { periodKind, start: today, end: today });
    return { kind: "ok", me, active, report };
  } catch (e) {
    if (isForbidden(e)) return { kind: "forbidden", me, active };
    if (isNotFound(e)) return { kind: "not_root", me, active };
    throw e;
  }
}
