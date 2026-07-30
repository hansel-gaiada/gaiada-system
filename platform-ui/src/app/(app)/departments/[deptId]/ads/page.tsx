import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { PendingCapability } from "@/components/search/PendingCapability";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Ads Studio — the DUAL-MODE APPLY PICKER: the human picks per approved change proposal whether to
// export it for manual entry (SM-30) or push it by API (SM-19/21), the one affordance this console
// must never build ahead of those tickets (SM-18's own constraint: 'applied' is refused everywhere
// at the app layer). Still pending for that reason — this tab is specifically the apply step.
//
// What SM-47 already built and lives elsewhere: drafting responsive search ads (manual or AI, per
// ad group) and reviewing/approving/dismissing change proposals are real, reachable from a
// campaign's detail page (Planner tab -> open a campaign -> "Ads" and "Change proposals"). Nothing
// there can reach a live account either — 'applied' is refused the same way.
export default async function DepartmentSeoAdsPage({ params }: { params: Params }) {
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
      title="Ads Studio"
      glyph="◨"
      tier="free"
      summary="The dual-mode apply picker for an approved change proposal — export for manual entry, or push by API. Drafting ads and reviewing/approving change proposals are already built — open a campaign from the Planner tab. This tab is specifically the apply step, which stays refused everywhere until it lands."
      contract="POST /api/:t/modules/search/change-proposals/:id/apply (manual + api modes; drafts/review already exist and are consumed from the Planner tab)"
      owner="SM-19 and SM-30"
    />
  );
}
