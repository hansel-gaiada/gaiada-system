import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { PendingCapability } from "@/components/search/PendingCapability";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// AI Visibility — how often AI answer engines mention and cite this brand (GEO/AEO), and
// how that citation share moves over time. DATA-KEY tier: each sweep is a metered provider
// pull. Owned by SM-16; IA-only until it lands (SM-11).
export default async function DepartmentSeoAiVisibilityPage({ params }: { params: Params }) {
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
      title="AI Visibility"
      glyph="✳"
      tier="data_key"
      summary="How often AI answer engines mention and cite this brand (GEO/AEO), and how that citation share moves over time. Each sweep is a metered provider pull."
      contract="POST /api/:t/modules/search/ai-visibility/pull, GET ai-visibility"
      owner="SM-16"
    />
  );
}
