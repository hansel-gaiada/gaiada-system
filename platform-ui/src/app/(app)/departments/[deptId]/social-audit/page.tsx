import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartmentNode } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getAudits } from "@/lib/socialAudit-data";
import { parseAuditSubject } from "@/lib/socialAudit";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AuditList } from "@/components/social/AuditList";
import { ProspectAuditForm } from "@/components/social/AuditStart";
import "@/components/social/cycles.css";
import "@/components/social/reports.css";
import "@/components/social/audit.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ subject?: string | string[] }>;

// SCP-5g (BFF §63.28, §63.17): the Social audit list: every open client with its draft's live score (else its latest final's frozen one, else none) and every prospect, worst first, with the score in words and
// numbers, how many of the twelve are scored and the first fix. It is `{D}/social-audit`, never `{D}/audit`, which is SEO's Site Audit in every department. A client's audit is started from its row (its
// officer, the HoD, the GM, the owner or the superadmin); "New prospect audit" is the four's. The whole team reads the list (`social_post` · `read`); a refused read is "no access" and a failed one is
// "cannot tell", never an empty list. The page belongs to the Social Media workspace only.
export default async function SocialAuditPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartmentNode(userId, tenant, deptId);
  if (!dept) notFound();
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const subject = parseAuditSubject(await searchParams);
  const read = await getAudits(userId, tenant, subject);
  if (read.kind === "forbidden") return <ReadRefusal subject="The social audits" kind="forbidden" detail="Reading them needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (read.kind === "unavailable") return <ReadRefusal subject="The social audits" kind="unavailable" reason={read.reason} />;

  return (
    <Card title="Audit">
      <p className="scp-lede">
        A twelve-dimension scorecard for each client and prospect: six scored from the pipeline and six typed for a client, all twelve typed for a prospect. Each dimension is 0 to 5, the overall is out of 100,
        and the three weakest are the fixes. A draft is live; finalizing freezes it as a dated record.
      </p>
      <ProspectAuditForm deptId={deptId} canAdd={read.data.canAddProspect} />
      <AuditList deptId={deptId} rows={read.data.items} subject={subject} />
    </Card>
  );
}
