import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { canReadGmConsole, isGmDept } from "@/lib/gm";
import { GmAccessDenied } from "./GmAccessDenied";

// The two checks every GM tab page runs, in one place (GM-02).
//
// Factored out because there are five of them and the checks must not drift apart: a tab that
// forgets the capability check is a company-grain leak, and a tab that forgets the toolkit check
// renders GM content under a department that never declared it (the `[deptId]` tab routes are
// GENERIC — every department's console can address every tab path, which is why every bespoke tab
// in this tree already tests its own toolkit membership).
//
// Order matters: toolkit membership is checked FIRST. A Web Dev member hitting `/departments/
// d-webdev/decisions` should be told the tab is not part of that console — not told they lack an
// executive capability, which would imply the tab would otherwise be there.

export type GmTabContext =
  | { ok: true; userId: string; tenantId: string; deptId: string }
  | { ok: false; reason: "not-gm" | "denied" };

export async function resolveGmTab(deptId: string): Promise<GmTabContext> {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  if (!isGmDept(dept.name)) return { ok: false, reason: "not-gm" };
  if (!canReadGmConsole(me, tenant)) return { ok: false, reason: "denied" };
  return { ok: true, userId, tenantId: tenant, deptId };
}

/** Renders the refusal for a non-ok context. `title` is the tab's own name so the card still reads
 *  as the surface the user asked for, rather than an anonymous error. */
export function GmTabRefusal({ reason, title }: { reason: "not-gm" | "denied"; title: string }) {
  if (reason === "denied") return <GmAccessDenied />;
  return (
    <Card title={title}>
      <EmptyNote>{title} is part of the GM console and isn&apos;t configured for this department.</EmptyNote>
    </Card>
  );
}
