import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartmentNode } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getOnboarding } from "@/lib/socialOnboarding-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { OnboardingBoard } from "@/components/social/OnboardingBoard";
import "@/components/social/cycles.css";
import "@/components/social/onboarding.css";

type Params = Promise<{ deptId: string }>;

// SCP-5h (BFF §63.29, §63.17): Client onboarding. The clients being onboarded (draft engagements, and clients whose onboarding steps are not all done): the officer, the kickoff, the progress,
// the next step, the checklist by phase, and the links to the client's project and its baseline audit. The steps are PM tasks in the client's own project (the company's PM project template,
// BFF §63.29.1); ticking and moving the kickoff are PM's own routes. HR's workspace has its own "Onboarding", for employees: this one is for clients. The whole team reads it
// (`social_post` · `read`); starting it is the four's, and the server decides every write. A refused read is "no access" and a failed one is "cannot tell", never an empty list.
// The page belongs to the Social Media workspace only.
export default async function SocialOnboardingPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartmentNode(userId, tenant, deptId);
  if (!dept) notFound();
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const onboarding = await getOnboarding(userId, tenant);
  if (onboarding.kind === "forbidden") return <ReadRefusal subject="Client onboarding" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (onboarding.kind === "unavailable") return <ReadRefusal subject="Client onboarding" kind="unavailable" reason={onboarding.reason} />;

  return (
    <Card title="Client onboarding">
      <p className="scp-lede">
        Every new client goes through the company&apos;s checklist. The Social Media head, the GM, the owner or the superadmin starts it, and each step is a task for the people named,
        in the client&apos;s own project.
      </p>
      <OnboardingBoard deptId={deptId} data={onboarding.data} today={todayIsoInDisplayZone()} />
    </Card>
  );
}
