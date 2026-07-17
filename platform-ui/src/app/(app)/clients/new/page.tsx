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

export default async function NewClientPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const crumbs = [{ label: "Clients", href: "/clients" }, { label: "New" }];
  if (!tenant || !can(me, "pm.manage", tenant)) {
    return (<><PageHeader eyebrow="Business" title="New client" breadcrumbs={crumbs} /><EmptyNote>You don&apos;t have permission to add clients.</EmptyNote></>);
  }
  return (
    <>
      <PageHeader eyebrow="Business" title="New client" breadcrumbs={crumbs} />
      <Card><ClientForm action={createClientAction} /></Card>
    </>
  );
}
