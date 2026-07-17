import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getClient, listDeliverables } from "@/lib/entities";
import { deleteClientForm } from "@/lib/clientWorkActions";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDate } from "@/lib/format";

type Params = Promise<{ clientId: string }>;

export default async function ClientDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const client = await getClient(userId, tenant, clientId);
  if (!client) notFound();
  const deliverables = (await listDeliverables(userId, tenant)).filter((d) => d.client_id === clientId);
  const canManage = can(me, "pm.manage", tenant);
  const del = deleteClientForm.bind(null, clientId);

  return (
    <>
      <PageHeader
        eyebrow="Client"
        title={client.name}
        breadcrumbs={[{ label: "Clients", href: "/clients" }, { label: client.name }]}
        actions={canManage ? <form action={del}><button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Delete</button></form> : undefined}
      />
      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Card title="Details">
          <DescriptionList items={[
            { label: "Status", value: <StatusBadge label={client.status} /> },
            { label: "Email", value: (client.contact as { email?: string })?.email ?? "—" },
          ]} />
        </Card>
        <Card title={`Deliverables${deliverables.length ? ` · ${deliverables.length}` : ""}`}>
          {deliverables.length === 0 ? (
            <EmptyNote>No deliverables for this client.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[{ label: "Deliverable" }, { label: "Status" }, { label: "Due", align: "right" }]}
              rows={deliverables.map((d) => [d.name, <StatusBadge key="s" label={d.status} />, formatDate(d.due_date)])}
              tcols="2fr 1fr 1fr"
            />
          )}
        </Card>
      </div>
    </>
  );
}
