import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { isDemoMode } from "@/lib/demoMode";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getSocialSettings } from "@/lib/socialCycles-data";
import { getAllocation, getOfficerCandidates } from "@/lib/socialAllocation-data";
import { IMPORT_REFUSAL_REASON } from "@/lib/sheetImport";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ImportSteps, SheetImport, TemplateButton } from "@/components/social/SheetImport";
import "@/components/social/cycles.css";
import "@/components/social/sheet-import.css";

type Params = Promise<{ deptId: string }>;

// SCP-6a (BFF §63.23; plan §8 SCP-6, SCP-D10): "Import from your sheet", the Social Media team's one-off move from the sheet: the allocation, or a month's plan.
// Linked from the Settings page; it sits in the `settings` row's area (the row's `canLeadSocial` gate shows it to the four approvers).
//
// The three routes it calls (`import/parse`, `import/allocation`, `import/plan`) are `social_engagement` · `plan`, the four approvers' alone, so a person who
// opens it by address without the right reads the explanation and why they cannot import; the gate hides the wizard, never grants anything, and the server's
// 403 `not_a_social_approver` is the boundary. `canPlan` is the server's own answer on `GET settings`. In DEMO_MODE there is no writer: the page explains the
// steps, offers the CSV templates and says importing needs the live ERP.
export default async function SocialImportPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // The import belongs to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const back = (
    <p className="scp-note" style={{ marginTop: 0 }}>
      <Link href={`/departments/${encodeURIComponent(deptId)}/settings`}>Back to Settings</Link>
    </p>
  );

  if (isDemoMode()) {
    return (
      <Card title="Import from your sheet">
        {back}
        <div className="scp-sections">
          <p className="scp-note scp-note--reason" role="status">
            Importing needs the live ERP: this demo has no writer, so nothing can be imported here. The steps and the CSV templates are shown so you can prepare the sheet.
          </p>
          <ImportSteps />
          <div className="scp-actions">
            <TemplateButton kind="allocation" label="Download the allocation CSV template" />
            <TemplateButton kind="plan" label="Download the plan CSV template" />
          </div>
        </div>
      </Card>
    );
  }

  const [settings, allocation, members] = await Promise.all([
    getSocialSettings(userId, tenant), getAllocation(userId, tenant), getOfficerCandidates(userId, tenant),
  ]);
  if (settings.kind === "forbidden") {
    return <ReadRefusal subject="the Social Media settings" kind="forbidden" detail="Reading them needs a Social Media read tier (the social_staff role, or a manager)." />;
  }
  if (settings.kind === "unavailable") return <ReadRefusal subject="The Social Media settings" kind="unavailable" reason={settings.reason} />;

  if (!settings.data.canPlan) {
    return (
      <Card title="Import from your sheet">
        {back}
        <div className="scp-sections">
          <p className="scp-note scp-note--reason" role="status">{IMPORT_REFUSAL_REASON} You can read what it does here.</p>
          <ImportSteps />
        </div>
      </Card>
    );
  }

  const thisMonth = todayIsoInDisplayZone().slice(0, 7);
  const engagements = allocation.kind === "ok" ? allocation.data.map((r) => ({ id: r.engagementId, name: r.clientName })) : [];
  const officers = members.kind === "ok" ? members.data.map((m) => ({ id: m.user_id, name: m.name })) : [];
  return (
    <Card title="Import from your sheet">
      {back}
      <p className="scp-lede">
        Moving from the sheet? Bring the allocation, or a month&rsquo;s plan, over in six steps. Nothing is written until you have seen every row&rsquo;s outcome and
        chosen to import. A client is never created here: its engagement is opened in the ERP first.
      </p>
      {allocation.kind !== "ok" && (
        <p className="scp-note" role="status">The client list could not be read, so a name the ERP cannot match offers only its own suggestions.</p>
      )}
      <SheetImport deptId={deptId} thisMonth={thisMonth} engagements={engagements} officers={officers} officersKnown={members.kind === "ok"} />
    </Card>
  );
}
