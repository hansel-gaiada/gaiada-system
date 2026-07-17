import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { listClients } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { InvoiceForm } from "@/components/forms/InvoiceForm";
import { createInvoiceAction } from "@/lib/billingActions";

export default async function NewInvoicePage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const crumbs = [{ label: "Billing", href: "/billing" }, { label: "New invoice" }];
  if (!tenant || (!can(me, "company.manage", tenant) && !isElevated(me))) {
    return (<><PageHeader eyebrow="Business" title="New invoice" breadcrumbs={crumbs} /><EmptyNote>Billing is limited to finance administrators.</EmptyNote></>);
  }
  const clients = (await listClients(userId, tenant)).map((c) => ({ id: c.id, name: c.name }));
  return (
    <>
      <PageHeader eyebrow="Business" title="New invoice" breadcrumbs={crumbs} />
      <Card><InvoiceForm action={createInvoiceAction} clients={clients} /></Card>
    </>
  );
}
