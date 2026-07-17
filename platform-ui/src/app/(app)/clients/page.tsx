import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listClients } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { DataTable, type Column } from "@/components/data/DataTable";

const COLUMNS: Column[] = [
  { key: "name", header: "Client", sortable: true },
  { key: "email", header: "Contact" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

export default async function ClientsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Clients" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }

  const clients = await listClients(userId, tenant);
  const rows = clients.map((c) => ({ id: c.id, name: c.name, email: (c.contact as { email?: string })?.email ?? "—", status: c.status }));

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Clients"
        subtitle="Everyone this company does work for."
        actions={can(me, "pm.manage", tenant) ? <Link href="/clients/new" className="lux-btn lux-btn--solid lux-btn--sm">New client</Link> : undefined}
      />
      {clients.length === 0 ? (
        <>
          <BackendPending what="No clients returned. Once the clients API is live they appear here." contract="GET /api/:t/clients" />
          <Card><EmptyNote>No clients yet.</EmptyNote></Card>
        </>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/clients", idKey: "id", labelKey: "name" }} csvName="clients" pageSize={20} />
      )}
    </>
  );
}
