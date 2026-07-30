import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { PendingCapability } from "@/components/search/PendingCapability";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Content Briefs — AI-drafted briefs grounded in this property's own crawl and keyword
// data through the knowledge store, so a brief cites evidence we already hold rather than
// inventing it. FREE tier: no external provider spend. Owned by SM-10; IA-only until it
// lands (SM-11).
export default async function DepartmentSeoBriefsPage({ params }: { params: Params }) {
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
      title="Content Briefs"
      glyph="✎"
      tier="free"
      summary="AI-drafted content briefs grounded in this property's own crawl and keyword data through the knowledge store, so a brief cites evidence we already hold rather than inventing it."
      contract="GET/POST /api/:t/modules/search/briefs, POST briefs/:id/draft"
      owner="SM-10"
    />
  );
}
