import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { PendingCapability } from "@/components/search/PendingCapability";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Search Terms — sweeps over LIVE ad-account search-term data (what the account itself served the
// ad against), which needs SM-20's search-term sync — not built, no bridge exists yet. Still
// pending for THAT reason.
//
// What SM-47 already built and lives elsewhere: negative-keyword review/creation and the AI
// classify-a-pasted-term-list flow (`POST campaigns/:id/negatives/propose`) are real, reachable from
// a campaign's detail page (Planner tab -> open a campaign -> "Negative keywords"). This tab stays
// pending because a live search-term SWEEP specifically needs data this console cannot read yet.
export default async function DepartmentSeoSearchTermsPage({ params }: { params: Params }) {
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
      title="Search Terms"
      glyph="⌕"
      tier="free"
      summary="Sweeps over LIVE ad-account search-term data (what actually triggered an ad). Negative-keyword review and AI classification of a pasted term list are already built — open a campaign from the Planner tab. This tab needs the live search-term sync specifically."
      contract="GET /api/:t/modules/search/sem/search-terms (a live sync feed — negatives/propose already exists and is consumed from the Planner tab)"
      owner="SM-20"
    />
  );
}
