import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listClients } from "@/lib/entities";
import { listClientCentres } from "@/lib/clientCentre-data";
import { registry, businessTypeLabel } from "@/lib/clientCentre";
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
  { key: "owner", header: "Owner", sortable: true },
  { key: "businessType", header: "Business type", sortable: true },
  { key: "profile", header: "Profile", align: "right" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

type Search = Promise<{ status?: string; archived?: string }>;

export default async function ClientsPage({ searchParams }: { searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Clients" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }
  const { status, archived } = await searchParams;

  // CC-D8 — the former `/client-centre` list folded in as two columns, so there is one client list.
  // The profile read is a second endpoint; if it fails the columns show "—" rather than taking the
  // client list down with it ("—" says "unknown", never "0%", which would claim an empty profile).
  const [clients, centres] = await Promise.all([
    listClients(userId, tenant),
    listClientCentres(userId, tenant).catch(() => []),
  ]);
  const centreById = new Map(centres.map((c) => [c.clientId, c]));
  const allRows = clients.map((c) => {
    const centre = centreById.get(c.id);
    return {
      id: c.id,
      name: c.name,
      email: (c.contact as { email?: string })?.email ?? "—",
      owner: c.owner_name ?? "—",
      businessType: centre ? businessTypeLabel(registry, centre.businessType) : "—",
      profile: centre && centre.fieldsFilled.total > 0
        ? `${Math.round((centre.fieldsFilled.filled / centre.fieldsFilled.total) * 100)}%`
        : "—",
      status: c.status,
    };
  });

  // FilterBar (Phase 4, NEW — unifies the OriginFilterBar/FilterChips pattern) faceted by status,
  // server-computed from the already-fetched list — no extra round trip.
  const counts = new Map<string, number>();
  for (const r of allRows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const statusOptions = [...counts.entries()].map(([key, count]) => ({ key, label: humanizeStatus(key), count }));
  const activeStatus = status && counts.has(status) ? status : undefined;
  // CC-D10 — archiving is the everyday alternative to Delete, so archived clients leave the default
  // list (they are still one click away, and picking the "archived" status facet shows them too).
  const showArchived = archived === "1" || activeStatus === "archived";
  const archivedCount = counts.get("archived") ?? 0;
  const rows = activeStatus
    ? allRows.filter((r) => r.status === activeStatus)
    : showArchived ? allRows : allRows.filter((r) => r.status !== "archived");
  const buildStatusHref = (next: string | undefined) => (next ? `/clients?status=${encodeURIComponent(next)}` : "/clients");

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Clients"
        subtitle="Everyone this company does work for."
        actions={can(me, "client.write", tenant) ? <Link href="/clients/new" className="lux-btn lux-btn--solid lux-btn--sm">New client</Link> : undefined}
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
          {!activeStatus && archivedCount > 0 && (
            <p style={{ margin: "0 0 10px", font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
              {showArchived
                ? <Link href="/clients" style={{ color: "var(--erp-accent)" }}>Hide {archivedCount} archived</Link>
                : <Link href="/clients?archived=1" style={{ color: "var(--erp-accent)" }}>Show {archivedCount} archived</Link>}
            </p>
          )}
          {/* Bulk delete is a delete: `client.delete` (manager+), not `client.write`. */}
          <ClientsTable columns={COLUMNS} rows={rows} canManage={can(me, "client.delete", tenant)} viewKey="clients" />
        </>
      )}
    </>
  );
}
