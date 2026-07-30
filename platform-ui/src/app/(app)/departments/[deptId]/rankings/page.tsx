import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { PendingCapability } from "@/components/search/PendingCapability";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Rankings — tracked keyword positions, ranking drops, and the SERP features each result
// won, over time. DATA-KEY tier: every refresh is a metered provider pull counted against
// this engagement's budget, unlike the crawl/cluster tabs above. Owned by SM-14;
// IA-only until it lands (SM-11).
export default async function DepartmentSeoRankingsPage({ params }: { params: Params }) {
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
      title="Rankings"
      glyph="◈"
      tier="data_key"
      summary="Tracked keyword positions over time, ranking drops, and the SERP features (AI Overview, People Also Ask, snippets) each result won. Every refresh is a metered provider pull counted against this engagement's budget."
      contract="POST /api/:t/modules/search/rankings/pull, GET rankings?keywordId&from&to"
      owner="SM-14"
    />
  );
}
