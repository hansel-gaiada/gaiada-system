import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { getClient, listMembers } from "@/lib/entities";
import { updateClientAction } from "@/lib/clientWorkActions";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { EditClientForm } from "@/components/forms/ClientWorkForms";

// Edit the CRM client row: name, status, owner and contact details. This is the rename flow CC-D5
// refers to. Rendered inside the hub layout, so the header and tabs stay; no tab is active.
// CC-D10: gated on `client.write` (any staff member, as resource_client.yaml allows); Cerbos `client`
// update is still the real authority on the PATCH.
const USUAL_STATUSES = ["active", "prospect", "archived"];

export default async function EditClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();
  if (!can(me, "client.write", tenant)) return <EmptyNote>You don&apos;t have permission to edit clients.</EmptyNote>;

  const [client, members] = await Promise.all([
    getClient(userId, tenant, clientId),
    // The owner picker degrades to "No owner" only if the directory read fails, never the whole form.
    listMembers(userId, tenant).catch(() => []),
  ]);
  if (!client) notFound();
  const status = client.status || "active";
  const statusOptions = USUAL_STATUSES.includes(status) ? USUAL_STATUSES : [status, ...USUAL_STATUSES];
  const owners = members.map((m) => ({ id: m.user_id, name: m.name || m.email }));
  // The current owner stays selectable even if they are no longer in the directory list, so saving
  // an unrelated field never silently clears the owner.
  if (client.owner_user_id && !owners.some((o) => o.id === client.owner_user_id)) {
    owners.unshift({ id: client.owner_user_id, name: client.owner_name ?? "Current owner" });
  }

  return (
    <Card title="Edit client">
      <EditClientForm
        action={updateClientAction.bind(null, clientId)}
        name={client.name}
        status={status}
        statusOptions={statusOptions}
        contact={(client.contact as Record<string, unknown> | null) ?? {}}
        ownerUserId={client.owner_user_id ?? null}
        owners={owners}
      />
    </Card>
  );
}
