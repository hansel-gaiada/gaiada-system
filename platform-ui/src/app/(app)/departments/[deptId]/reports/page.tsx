import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { PendingCapability } from "@/components/search/PendingCapability";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Reports — the client-facing artifact this whole department ultimately produces: a
// monthly snapshot plus an AI-drafted narrative that a human reviews before it goes out.
// Owned by SM-22; this tab is IA-only until that ticket lands (SM-11).
export default async function DepartmentSeoReportsPage({ params }: { params: Params }) {
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
      title="Reports"
      glyph="▤"
      tier="free"
      summary="Monthly client reports: a snapshot plus an AI-drafted narrative that a human reviews, approves and delivers as a client-visible deliverable."
      contract="GET/POST /api/:t/modules/search/reports, POST reports/:id/approve|deliver"
      owner="SM-22"
    />
  );
}
