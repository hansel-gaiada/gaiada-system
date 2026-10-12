import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getClient, listProjects, CLIENT_CONTACT_KEYS, CLIENT_CONTACT_LABELS } from "@/lib/entities";
import { ClientContactsPanel } from "@/components/clients/ClientContactsPanel";
import { ClientWebsiteAccessSection } from "@/components/clients/ClientWebsiteAccessSection";
import { listClientContacts } from "@/lib/clientContacts";
import { Card } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";

type Params = Promise<{ clientId: string }>;

export default async function ClientContactsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const client = await getClient(userId, tenant, clientId);
  if (!client) notFound();
  // W0-5 — the external half of engagement setup (D-3: the client is present BEFORE the first
  // meeting). Both reads degrade to [] rather than throwing, so one missing grant cannot take the
  // whole client page down.
  const contacts = await listClientContacts(userId, tenant, clientId);
  // CC-1: filtered SERVER-side now that `/projects` takes `clientId`. This used to fetch every
  // project in the tenant and narrow in the browser, which stops being a filter past a page of rows.
  const clientProjects = (await listProjects(userId, tenant, clientId).catch(() => []))
    .map((p) => ({ id: p.id, name: p.name }));

  return (
    <>
      {/* CC-D8 — this tab was "Details"; PV3-05 — it is the hub's People area. Status sits in the hub
          header, deliverables and (from PV3-05) meetings on the Projects tab; what is left is the people
          side of the client: owner and contact details, and who on their side can use the portal. */}
      <Card title="Contact details">
        <DescriptionList items={[
          { label: "Owner", value: client.owner_name ?? "No owner" },
          ...CLIENT_CONTACT_KEYS.map((k) => {
            const v = (client.contact as Record<string, unknown> | null)?.[k];
            return { label: CLIENT_CONTACT_LABELS[k], value: typeof v === "string" && v ? v : "—" };
          }),
        ]} />
      </Card>
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
      <ClientWebsiteAccessSection me={me} userId={userId} tenant={tenant} clientId={clientId} clientName={client.name} />
    </>
  );
}
