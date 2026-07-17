import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { can } from "@/lib/rbac";
import { getCompany, listMembers } from "@/lib/entities";
import { getOrgStructure } from "@/lib/org";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { OrgBuilder } from "@/components/org/OrgBuilder";
import { saveOrg } from "./actions";

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
        <PageHeader eyebrow="Organization" title="Org structure" />
        <EmptyNote>That company isn&apos;t available to you.</EmptyNote>
      </>
    );
  }

  const canEdit = can(me, "org.edit", companyId) && me.companies.some((c) => c.id === companyId);
  const [{ structure, source }, members] = await Promise.all([
    getOrgStructure(userId, companyId, company),
    listMembers(userId, companyId).catch(() => []),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Organization"
        title={`${company.name} — Org structure`}
        subtitle={
          canEdit
            ? "Drag a unit onto another to re-parent it. Add, rename, assign people, then save. The right pane previews the live chart."
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
      />
    </>
  );
}
