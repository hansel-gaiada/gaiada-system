import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { PendingCapability } from "@/components/search/PendingCapability";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Pacing — month-to-date ad spend against plan, so an account that will overshoot or
// underspend its budget is visible before month end rather than after it. FREE tier: no
// new provider spend, just our own imported metrics. Owned by SM-18 and SM-22; IA-only
// until it lands (SM-11).
export default async function DepartmentSeoPacingPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <PendingCapability
      title="Pacing"
      glyph="◑"
      tier="free"
      summary="Month-to-date ad spend against plan, so an account that will overshoot or underspend its budget is visible before month end rather than after it."
      contract="GET /api/:t/modules/search/sem/pacing, POST sem/metrics-daily/import"
      owner="SM-18 and SM-22"
    />
  );
}
