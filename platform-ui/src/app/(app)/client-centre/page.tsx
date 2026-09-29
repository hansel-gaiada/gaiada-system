import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listClientCentres } from "@/lib/clientCentre-data";
import { registry, businessTypeLabel } from "@/lib/clientCentre";
import { PageHeader } from "@/components/PageHeader";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { DataTable, type Column } from "@/components/data/DataTable";

// CC-D1 — the Client Centre's staff landing: every client of the tenant, with business type, city
// and completion, so a manager can see at a glance who still has an empty profile. Row links straight
// into that client's workspace (`/client-centre/[clientId]`); DataTable's own search box covers the
// "search/filter" requirement (name, business type, city are all in `searchKeys`) without a bespoke
// FilterBar for what is, so far, a single facet-free list.
const COLUMNS: Column[] = [
  { key: "clientName", header: "Client", sortable: true },
  { key: "businessTypeLabel", header: "Business type", sortable: true },
  { key: "city", header: "City", sortable: true },
  { key: "fieldsLabel", header: "Fields", align: "right" },
  { key: "connectionsLabel", header: "Connections", align: "right" },
  { key: "updatedAt", header: "Updated", format: "date", sortable: true, align: "right" },
];

export default async function ClientCentreListPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader title="Client Centre" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }

  const items = await listClientCentres(userId, tenant);
  const rows = items.map((it) => ({
    clientId: it.clientId,
    clientName: it.clientName,
    businessTypeLabel: businessTypeLabel(registry, it.businessType),
    city: it.city ?? "—",
    fieldsLabel: `${it.fieldsFilled.filled}/${it.fieldsFilled.total}`,
    connectionsLabel: `${it.connectionsConnected.connected}/${it.connectionsConnected.total}`,
    updatedAt: it.updatedAt ?? "",
  }));

  return (
    <>
      <PageHeader title="Client Centre" />
      {items.length === 0 ? (
        <EmptyNote>No clients yet.</EmptyNote>
      ) : (
        <DataTable
          columns={COLUMNS}
          rows={rows}
          link={{ base: "/client-centre", idKey: "clientId", labelKey: "clientName" }}
          searchKeys={["clientName", "businessTypeLabel", "city"]}
          csvName="client-centre"
          pageSize={20}
          viewKey="client-centre"
        />
      )}
    </>
  );
}
