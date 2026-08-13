import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { Card } from "@/components/ui";
import { BackendPending } from "@/components/BackendPending";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Analytics (SMM-11 route, SMM-21 backend) — reach/engagement/delivery metrics per network. The
// route exists so the "Publish" craft group's toolkit entry doesn't 404, but `pullMetrics` /
// `social_metrics_daily` / `social_post_metrics` (SMM-21) are still 0.0.0. Honest BackendPending
// shell rather than a chart rendering all-zero — the same "unknown is not zero" discipline this
// module's quota warnings already hold to.
export default async function DepartmentSocialAnalyticsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  return (
    <Card title="Analytics">
      <BackendPending
        what="Per-network reach, engagement and delivery metrics haven't shipped yet."
        contract="modules/social — SMM-21 (pullMetrics, social_metrics_daily, social_post_metrics)"
      />
    </Card>
  );
}
