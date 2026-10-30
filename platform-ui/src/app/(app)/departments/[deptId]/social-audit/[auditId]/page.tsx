import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartmentNode } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getAudit } from "@/lib/socialAudit-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { AuditView } from "@/components/social/AuditView";
import "@/components/social/cycles.css";
import "@/components/social/audit.css";

type Params = Promise<{ deptId: string; auditId: string }>;

// SCP-5g (BFF §63.28, §63.17): one audit's scorecard, in the same area as the list. The read is the server's (`GET audits/:auditId`: the twelve dimensions with their automatic part, evidence or reason and
// the typed scores with notes, the overall, band, fixes and summary, and the `canWrite` and `canFinalize` that decide the controls); the page draws it and `AuditView` carries the form. An audit that does not
// exist is a 404; a refused read is "no access" and a failed one "cannot tell". Once final the page is read-only and shows what was frozen. The clients are read only to name the one a prospect became and to
// offer attaching it; a failed read of them leaves the page whole without the picker.
export default async function SocialAuditDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, auditId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartmentNode(userId, tenant, deptId);
  if (!dept) notFound();
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const read = await getAudit(userId, tenant, auditId);
  if (read.kind === "forbidden") return <ReadRefusal subject="This audit" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  if (read.kind === "unavailable") return <ReadRefusal subject="This audit" kind="unavailable" reason={read.reason} />;
  const audit = read.data;
  if (!audit) notFound();

  const alloc = audit.subject === "prospect" ? await getAllocation(userId, tenant) : null;
  const clients = alloc?.kind === "ok" ? alloc.data.filter((r) => r.status !== "closed" || r.engagementId === audit.engagementId).map((r) => ({ engagementId: r.engagementId, clientName: r.clientName })) : [];

  return (
    <Card>
      {alloc && alloc.kind !== "ok" && <p className="scp-note" role="status">The clients could not be read, so a prospect cannot be attached from here just now.</p>}
      <AuditView key={`${audit.id}:${audit.updatedAt}:${audit.status}`} deptId={deptId} audit={audit} clients={clients} />
    </Card>
  );
}
