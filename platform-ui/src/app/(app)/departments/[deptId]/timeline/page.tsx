import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Timeline — schedule/milestones across the department's owned projects.
// Skeleton only (P1-06): no milestone-aggregation reader exists yet; that
// data wiring is a later ticket.
export default async function DepartmentTimelinePage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <Card title="Timeline">
      <TeachState
        glyph="◷"
        title="Timeline is not wired up yet"
        body="Milestones across this department's owned projects will appear here on a schedule."
      />
    </Card>
  );
}
