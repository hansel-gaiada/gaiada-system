import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { Card } from "@/components/ui";
import { PageHeader } from "@/components/PageHeader";
import { RequestForm } from "@/components/requests/RequestForm";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { activeCompany } from "@/lib/companyContext";
import { departmentForWorkspace } from "@/lib/workspaceAccess";
import { readOrgRoot, readSharedCampaigns } from "@/lib/campaigns-data";
import { REQUEST_TARGETS, parseTarget, partOptions } from "@/lib/requests";
import "@/components/requests/requests.css";

// DW-5c — New request (plan §7.2, contract §32.4). `?to=creatives` asks Creatives for assets, `?to=web-dev` asks Web Dev
// (the registry's ASK_ACTIONS link here). The target is resolved to the ACTIVE company's department whose workspace is
// that key, with the same name match the shell uses (`departmentForWorkspace` over `workspaceFor`), never a second one.
// A company with no such department gets a plain sentence and no form. The org chart is READ first: a tree that cannot be
// read is "unavailable", never "no Creatives department". The kind follows the target. The campaigns offered are those
// where the RECEIVING department has a part (`GET campaigns?unitId=<receiving dept>`), sent as `campaignPartId`.
export default async function NewRequestPage({ searchParams }: { searchParams: Promise<{ to?: string | string[] }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const crumbs = [{ label: "Requests", href: "/requests" }, { label: "New request" }];
  const header = <PageHeader title="New request" breadcrumbs={crumbs} />;

  const targetKey = parseTarget((await searchParams).to);
  if (!targetKey) {
    return (
      <>
        {header}
        <Card title="Who do you want to ask?">
          <p className="req-empty">Choose a department to ask.</p>
          <div className="req-asks" style={{ marginTop: 12 }}>
            <Link href="/requests/new?to=creatives" className="lux-btn lux-btn--ghost lux-btn--sm">Ask Creatives for assets</Link>
            <Link href="/requests/new?to=web-dev" className="lux-btn lux-btn--ghost lux-btn--sm">Ask Web Dev</Link>
          </div>
        </Card>
      </>
    );
  }
  const target = REQUEST_TARGETS[targetKey];

  const root = await readOrgRoot(me, tenant);
  if (!root) {
    return (
      <>
        {header}
        <ReadRefusal
          subject={`The org chart`}
          kind="unavailable"
          reason={`It could not be read, so ${target.label} could not be found.`}
        />
      </>
    );
  }
  const dept = departmentForWorkspace(root, activeCompany(me, tenant)?.vertical, targetKey);
  if (!dept) {
    return (
      <>
        {header}
        <Card title={`No ${target.label} department`}>
          <p className="req-empty">This company has no {target.label} department yet, so there is nobody to send this request to.</p>
          <p className="req-note" style={{ marginTop: 8 }}><Link href="/requests">Back to your requests</Link></p>
        </Card>
      </>
    );
  }

  // Context for the ask, never a routing rule: failing to read it does not stop the request.
  const campaignsRead = await readSharedCampaigns(userId, tenant, dept.id);
  const campaigns = campaignsRead.kind === "ok" ? partOptions(campaignsRead.data) : null;

  return (
    <>
      {header}
      <Card title={target.kind === "assets" ? `Ask ${target.label} for assets` : `Ask ${target.label}`}>
        <RequestForm kind={target.kind} toUnitId={dept.id} toUnitName={dept.name} campaigns={campaigns} />
      </Card>
    </>
  );
}
