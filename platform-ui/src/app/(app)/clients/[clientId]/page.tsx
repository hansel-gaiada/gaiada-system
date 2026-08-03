import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getClient, listDeliverables, listProjects } from "@/lib/entities";
import { deleteClientForm } from "@/lib/clientWorkActions";
import { listRecordings, STATUS_LABEL, formatDuration } from "@/lib/meetings";
import { RecordControls } from "@/components/meetings/RecordControls";
import { ClientContactsPanel } from "@/components/clients/ClientContactsPanel";
import { listClientContacts } from "@/lib/clientContacts";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { formatDate, formatDateTime } from "@/lib/format";
import Link from "next/link";

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
  // WD-07 (Web Dev Phase 1 §12) — recordings scoped to this client, plus RecordControls with
  // clientId pre-filled: the client-workspace half of the capture-edge context plumbing.
  const meetings = await listRecordings(userId, tenant, { clientId });
  // W0-5 — the external half of engagement setup (D-3: the client is present BEFORE the first
  // meeting). Both reads degrade to [] rather than throwing, so one missing grant cannot take the
  // whole client page down.
  const contacts = await listClientContacts(userId, tenant, clientId);
  const clientProjects = (await listProjects(userId, tenant).catch(() => []))
    .filter((p) => p.client_id === clientId)
    .map((p) => ({ id: p.id, name: p.name }));
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
      <div style={{ marginTop: 20 }}>
        <Card title={`Client access${contacts.length ? ` · ${contacts.length}` : ""}`}>
          <ClientContactsPanel
            clientId={clientId}
            clientName={client.name}
            contacts={contacts}
            projects={clientProjects}
          />
        </Card>
      </div>
      <div style={{ marginTop: 20 }}>
        <Card title={`Meetings${meetings.length ? ` · ${meetings.length}` : ""}`}>
          <RecordControls clientId={clientId} />
          {meetings.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <HairlineTable
                columns={[{ label: "Meeting" }, { label: "Status" }, { label: "Length" }, { label: "Recorded", align: "right" }]}
                rows={meetings.map((r) => [
                  <Link key="t" href={`/meetings/${r.id}`} style={{ color: "inherit", fontWeight: 600 }}>{r.title ?? r.meeting_id}</Link>,
                  <StatusBadge key="s" label={STATUS_LABEL[r.status] ?? r.status} />,
                  formatDuration(r.duration_sec),
                  formatDateTime(r.created_at),
                ])}
                tcols="2fr 1fr .8fr 1fr"
              />
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
