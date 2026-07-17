import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listProjects, listClients } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DeliverableForm } from "@/components/forms/ClientWorkForms";
import { createDeliverableAction } from "@/lib/clientWorkActions";

export default async function NewDeliverablePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const crumbs = [{ label: "Deliverables", href: "/deliverables" }, { label: "New" }];
  if (!tenant || !can(me, "pm.manage", tenant)) {
    return (<><PageHeader eyebrow="Business" title="New deliverable" breadcrumbs={crumbs} /><EmptyNote>You don&apos;t have permission to add deliverables.</EmptyNote></>);
  }
  const [projects, clients] = await Promise.all([listProjects(userId, tenant).catch(() => []), listClients(userId, tenant)]);
  return (
    <>
      <PageHeader eyebrow="Business" title="New deliverable" breadcrumbs={crumbs} />
      <Card>
        <DeliverableForm
          action={createDeliverableAction}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        />
      </Card>
    </>
  );
}
