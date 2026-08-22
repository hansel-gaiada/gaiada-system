import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listClients } from "@/lib/entities";
import { PageHeader } from "@/components/PageHeader";
import { humanizeStatus } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { type Column } from "@/components/data/DataTable";
import { FilterBar } from "@/components/data/FilterBar";
import { ClientsTable } from "./ClientsTable";

const COLUMNS: Column[] = [
  { key: "name", header: "Client", sortable: true },
  { key: "email", header: "Contact" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

type Search = Promise<{ status?: string }>;

export default async function ClientsPage({ searchParams }: { searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Clients" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }
  const { status } = await searchParams;

  const clients = await listClients(userId, tenant);
  const allRows = clients.map((c) => ({ id: c.id, name: c.name, email: (c.contact as { email?: string })?.email ?? "—", status: c.status }));

  // FilterBar (Phase 4, NEW — unifies the OriginFilterBar/FilterChips pattern) faceted by status,
  // server-computed from the already-fetched list — no extra round trip.
  const counts = new Map<string, number>();
  for (const r of allRows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const statusOptions = [...counts.entries()].map(([key, count]) => ({ key, label: humanizeStatus(key), count }));
  const activeStatus = status && counts.has(status) ? status : undefined;
  const rows = activeStatus ? allRows.filter((r) => r.status === activeStatus) : allRows;
  const buildStatusHref = (next: string | undefined) => (next ? `/clients?status=${encodeURIComponent(next)}` : "/clients");

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
          <EmptyNote>No clients yet.</EmptyNote>
        </>
      ) : (
        <>
          {statusOptions.length > 1 && (
            <div style={{ marginBottom: 14 }}>
              <FilterBar
                label="Filter by status"
                totalCount={allRows.length}
                active={activeStatus}
                options={statusOptions}
                buildHref={buildStatusHref}
              />
            </div>
          )}
          <ClientsTable columns={COLUMNS} rows={rows} canManage={can(me, "pm.manage", tenant)} viewKey="clients" />
        </>
      )}
    </>
  );
}
