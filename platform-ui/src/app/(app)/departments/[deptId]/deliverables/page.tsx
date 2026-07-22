import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Deliverables — files/docs this department's work has produced (the
// `deliverable_evidence` view over F2, decision #3 — not built yet).
// Connection-backed like Repositories; skeleton only here (P1-06).
export default async function DepartmentDeliverablesPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <Card title="Deliverables">
      <TeachState
        glyph="▤"
        title="No deliverables yet"
        body="Files and docs produced by this department's work will show up here once a source is connected."
        ctaLabel="Go to Connections"
        ctaHref={`/departments/${deptId}/connections`}
      />
    </Card>
  );
}
