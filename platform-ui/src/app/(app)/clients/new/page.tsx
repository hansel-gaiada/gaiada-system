import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ClientForm } from "@/components/forms/ClientWorkForms";
import { createClientAction } from "@/lib/clientWorkActions";
import { listMembers } from "@/lib/entities";

export default async function NewClientPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const crumbs = [{ label: "Clients", href: "/clients" }, { label: "New" }];
  // CC-D10: `client.write` (member+), matching resource_client.yaml — was `pm.manage` (manager+).
  if (!tenant || !can(me, "client.write", tenant)) {
    return (<><PageHeader eyebrow="Business" title="New client" breadcrumbs={crumbs} /><EmptyNote>You don&apos;t have permission to add clients.</EmptyNote></>);
  }
  // The owner picker degrades to "No owner" only if the directory read fails, never the form.
  const owners = (await listMembers(userId, tenant).catch(() => [])).map((m) => ({ id: m.user_id, name: m.name || m.email }));
  return (
    <>
      <PageHeader eyebrow="Business" title="New client" breadcrumbs={crumbs} />
      <Card><ClientForm action={createClientAction} owners={owners} /></Card>
    </>
  );
}
