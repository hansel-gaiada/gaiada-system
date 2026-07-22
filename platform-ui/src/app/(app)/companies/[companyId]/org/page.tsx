import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { can } from "@/lib/rbac";
import { getCompany, listMembers, listCompanies } from "@/lib/entities";
import { getOrgStructure } from "@/lib/org";
import { listAssignments, SERVICE_ASSIGNMENTS_ENABLED, SERVICE_MODULE_OPTIONS } from "@/lib/serviceAssignments";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { OrgBuilder } from "@/components/org/OrgBuilder";
import { ServicedFunctionsPanel } from "@/components/org/ServicedFunctionsPanel";
import {
  saveOrg, dryRunConnectServiceAction, proposeConnectServiceAction, listNodeAssignmentsAction,
  revokeAssignmentAction, suspendAssignmentAction, resumeAssignmentAction,
} from "./actions";

type Params = Promise<{ companyId: string }>;

export default async function OrgPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const { companyId } = await params;

  const company = await getCompany(userId, companyId, companyId);
  if (!company) {
    return (
      <>
        <PageHeader eyebrow="Organization" title="Org structure" breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: "Org structure" }]} />
        <EmptyNote>That company isn&apos;t available to you.</EmptyNote>
      </>
    );
  }

  const canEdit = can(me, "org.edit", companyId) && me.companies.some((c) => c.id === companyId);
  const [{ structure, source }, members, allCompanies, servedByOthers] = await Promise.all([
    getOrgStructure(userId, companyId, company),
    listMembers(userId, companyId).catch(() => []),
    listCompanies(userId).catch(() => []),
    listAssignments(userId, companyId, { direction: "served" }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title={`${company.name} — Org structure`}
        breadcrumbs={[{ label: "Companies", href: "/companies" }, { label: company.name, href: `/companies/${companyId}` }, { label: "Org structure" }]}
        subtitle={
          canEdit
            ? "Edit right on the chart: click a unit to rename/assign, drag it onto another to re-parent, or ＋ to add below. The detailed list editor is underneath. Save when done."
            : "The organization chart for this company. Editing is limited to owners and administrators."
        }
      />
      <OrgBuilder
        companyId={companyId}
        initial={structure.root}
        canEdit={canEdit}
        members={members.map((m) => ({ id: m.user_id, name: m.name }))}
        source={source}
        updatedAt={structure.updatedAt ?? null}
        save={saveOrg}
        service={{
          // ORG-13 (A9 + A4): gated on both the flag AND the same org.edit
          // capability the rest of the editor uses — cosmetic only, the
          // backend's Cerbos propose gate is the real boundary.
          enabled: SERVICE_ASSIGNMENTS_ENABLED && canEdit,
          companies: allCompanies.filter((c) => c.id !== companyId).map((c) => ({ id: c.id, name: c.name })),
          modules: SERVICE_MODULE_OPTIONS,
          actions: {
            dryRun: dryRunConnectServiceAction.bind(null, companyId),
            propose: proposeConnectServiceAction.bind(null, companyId),
            listForUnit: listNodeAssignmentsAction.bind(null, companyId),
            revoke: revokeAssignmentAction.bind(null, companyId),
          },
        }}
      />

      <ServicedFunctionsPanel
        envelope={servedByOthers}
        onSuspend={suspendAssignmentAction.bind(null, companyId)}
        onResume={resumeAssignmentAction.bind(null, companyId)}
        onRevoke={revokeAssignmentAction.bind(null, companyId)}
      />
    </>
  );
}
