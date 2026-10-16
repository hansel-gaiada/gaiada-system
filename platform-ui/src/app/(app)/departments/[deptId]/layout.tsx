import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getDepartmentNode } from "@/lib/departments";
import { toolkitFor, visibleGroups } from "@/lib/deptToolkits";
import { activeCompany } from "@/lib/companyContext";
import { canReadGmConsole, isGmDept } from "@/lib/gm";
import { PageHeader } from "@/components/PageHeader";
import { HideOnOverview } from "@/components/overview/HideOnOverview";
import { DeptTabs } from "@/components/shell/DeptTabs";
import { DeptShellFrame } from "@/components/departments/DeptShellFrame";
import { SourceOfferNotice } from "@/components/social/SourceOfferNotice";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Department console shell. Owns the header + the two-level tab nav (DeptTabs:
// primary group strip + a secondary sub-tab strip for the active group). Each
// child tab page renders only its own body inside `.dept-shell__main`
// (DeptShellFrame). The groups come from the department's toolkit — bespoke
// departments get the Home · Work · <craft> · Connections spine; departments
// without a bespoke toolkit get Home only, same shell either way.
//
// There is no My-work rail here any more (DW-D4, DW-D38): "Needs you" and today's work are the
// Overview's blocks. `projectQueueForCompany` (lib/queue.ts) stays for the Decisions page.
export default async function DepartmentConsoleLayout({ children, params }: { children: React.ReactNode; params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  // The header and toolkit need only the department's identity: the light org-structure read, not `getDepartment` (every tenant PM
  // task plus a status read per project). An unknown department is a 404 exactly as before.
  const dept = await getDepartmentNode(userId, tenant, deptId);
  if (!dept) notFound();

  const toolkit = toolkitFor(activeCompany(me, tenant)?.vertical, dept.name);
  // M5-V3-i: a tab that names a capability (`requires`) is offered only to holders of it (e.g. Website -> Visitors needs `read_visitors`).
  const groups = visibleGroups(toolkit.groups, (t) => !!t.requires && can(me, t.requires, tenant));
  const canEditOrg = can(me, "org.edit", tenant);

  return (
    <>
      {/* DW-3a: in the workspace shell the Overview draws its own header, so this one steps aside on that
          page only. DW-3i: the GM's page draws the company Overview too, for anyone who may open the cockpit; a person the cockpit
          refuses sees the refusal with no Overview, so the header stays for them. */}
      <HideOnOverview overviewPath={`/departments/${encodeURIComponent(deptId)}`} enabled={!isGmDept(dept.name) || canReadGmConsole(me, tenant)}>
        <PageHeader
          eyebrow="Department workspace"
          title={dept.name}
          subtitle={toolkit.mission}
          breadcrumbs={[{ label: "Organization", href: "/organization" }, { label: "Departments", href: "/departments" }, { label: dept.name }]}
          actions={canEditOrg ? <Link href={`/companies/${tenant}/org`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit structure</Link> : undefined}
        />
      </HideOnOverview>
      <DeptTabs groups={groups} deptId={deptId} />
      <DeptShellFrame groups={groups} deptId={deptId}>
        {children}
      </DeptShellFrame>
      {/* AGPL-3.0 §13 source-offer (docs/plans/smm-tracker.md's "open items" table). Gated on the
          RESOLVED toolkit, not on `deptId` or `dept.name` directly, so it survives whatever id/name
          the org structure assigns — the same robustness `toolkitFor` already gives every other
          consumer of this value. Every other department's pages never call Postiz; only this one
          does, so only this one carries the notice. */}
      {toolkit.slug === "social-media" && <SourceOfferNotice />}
    </>
  );
}
