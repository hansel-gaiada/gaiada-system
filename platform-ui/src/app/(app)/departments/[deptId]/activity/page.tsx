import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { ActivityFeed } from "@/components/departments/ActivityFeed";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Activity — the full-length cross-source feed (F2 `work_activity`). Same
// component Home renders as a compact preview; this tab shows it at full
// length. Skeleton only (P1-06): the F2 backend + reader (P1-04/05) and the
// live wiring (P1-07) land later — items is empty here on purpose.
export default async function DepartmentActivityPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <Card title="Activity">
      <ActivityFeed items={[]} />
    </Card>
  );
}
