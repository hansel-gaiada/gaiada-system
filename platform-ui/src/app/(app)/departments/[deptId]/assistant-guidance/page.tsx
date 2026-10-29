import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { unitPathOf } from "@/lib/rbac";
import { readOrgRoot } from "@/lib/campaigns-data";
import { getAssistantPreamble } from "@/lib/assistantGuidance-data";
import { GUIDANCE_FORBIDDEN, GUIDANCE_NOT_FOUND, mayEditPreamble } from "@/lib/assistantGuidance";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { GuidanceEditor } from "@/components/assistant/GuidanceEditor";
import "@/components/assistant/guidance.css";

type Params = Promise<{ deptId: string }>;

const TITLE = "Department guidance";
const HINT = "A short text the AI Assistant reads whenever someone asks it something from this department. It starts from a default; the department's head can replace it with the department's own.";

// AIP-13b (BFF §65, owner ruling AIP-D10): what the AI Assistant is told about this department. The department's head (and a company admin and
// the owner) edit it. The page reads the server's §65.1 view (the custom text, the default, the exact block the assistant reads, who changed it
// last, and whether the company uses department guidance at all) and hands it to the editor. The form is a mirror (`mayEditPreamble`); the
// server decides every read and write.
//
// Honest by construction: a refusal, a missing department and a failed read are each said as such in the editor's place, never an empty form.
export default async function DepartmentAssistantGuidancePage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const [read, root] = await Promise.all([getAssistantPreamble(userId, tenant, deptId), readOrgRoot(me, tenant)]);

  if (read.kind === "forbidden") {
    return <Card title={TITLE} hint={HINT}><p className="ag-gone" data-state="forbidden">{GUIDANCE_FORBIDDEN}</p></Card>;
  }
  if (read.kind === "not_found") {
    return <Card title={TITLE} hint={HINT}><p className="ag-gone" data-state="not-found">{GUIDANCE_NOT_FOUND}</p></Card>;
  }
  if (read.kind === "unavailable") {
    return <ReadRefusal subject="The department guidance" kind="unavailable" reason={read.reason} />;
  }

  // A head's grant is unit-scoped, so company-wide `can()` never counts it: ask over the unit's path in the org tree (when the tree cannot be
  // read only a company-wide holder, the admin tier and the owner, passes).
  const canEdit = mayEditPreamble(me, tenant, root ? unitPathOf(root, deptId) : []);

  return (
    <Card title={TITLE} hint={HINT}>
      <GuidanceEditor tenantId={tenant} view={read.data} canEdit={canEdit} />
    </Card>
  );
}
