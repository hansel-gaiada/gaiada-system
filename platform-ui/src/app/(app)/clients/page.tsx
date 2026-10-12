import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { listClients } from "@/lib/entities";
import { listClientCentres } from "@/lib/clientCentre-data";
import { registry, businessTypeLabel } from "@/lib/clientCentre";
import { REVIEW_BUSINESS_TYPE, clientsHref, inBusinessTypeReview, readCentres } from "@/lib/clientBusinessType";
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
  { key: "groupCompany", header: "Group company", sortable: true },
  { key: "profile", header: "Profile", align: "right" },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

type Search = Promise<{ status?: string; archived?: string; review?: string }>;

export default async function ClientsPage({ searchParams }: { searchParams: Search }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Clients" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }
  const { status, archived, review } = await searchParams;

  // CC-D8 — the former `/client-centre` list folded in as two columns, so there is one client list.
  // The profile read is a second endpoint. PV3-04: when it fails the columns still show "—" ("unknown",
  // never "0%"), but the page now SAYS so and withholds the business-type review filter: the old
  // `.catch(() => [])` let a refused read pass for "no client has a type set".
  const [clients, centreOutcome] = await Promise.all([
    listClients(userId, tenant),
    listClientCentres(userId, tenant).then(
      (items) => ({ items, thrown: undefined as unknown }),
      (e: unknown) => ({ items: null, thrown: e ?? new Error("read failed") }),
    ),
  ]);
  const centreRead = readCentres(clients.length, centreOutcome.items, centreOutcome.thrown);
  // Empty on a failed read, so every profile cell reads "—" (unknown) rather than a guess.
  const centreById = new Map((centreRead.ok ? centreOutcome.items ?? [] : []).map((c) => [c.clientId, c]));
  const allRows = clients.map((c) => {
    const centre = centreById.get(c.id);
    return {
      id: c.id,
      name: c.name,
      // M5-G0b: the internal sentinel client (WSK-D36) is shown to staff, flagged.
      badge: c.isInternal ? "Internal" : "",
      email: (c.contact as { email?: string })?.email ?? "—",
      owner: c.owner_name ?? "—",
      businessType: centre ? businessTypeLabel(registry, centre.businessType) : "—",
      groupCompany: c.groupCompany?.name ?? "—",
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
  const inView = activeStatus
    ? allRows.filter((r) => r.status === activeStatus)
    : showArchived ? allRows : allRows.filter((r) => r.status !== "archived");
  // PV3-04 (PV-D1): the review list, "Business type: Other or not set", over the profile list read above.
  // Withheld when that read failed (the banner below says so); never filtered through an empty stand-in.
  const reviewCount = inView.filter((r) => inBusinessTypeReview(centreRead, r.id)).length;
  const reviewActive = review === REVIEW_BUSINESS_TYPE && centreRead.ok;
  const rows = reviewActive ? inView.filter((r) => inBusinessTypeReview(centreRead, r.id)) : inView;
  const buildStatusHref = (next: string | undefined) => clientsHref({ status: next, review: reviewActive });
  const buildReviewHref = (next: string | undefined) => clientsHref({ status: activeStatus, archived: archived === "1", review: next === REVIEW_BUSINESS_TYPE });

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
          {!centreRead.ok && (
            <p role="alert" style={{ margin: "0 0 12px", font: "400 13px var(--font-body)", color: "var(--erp-accent)" }}>
              {centreRead.message} The &ldquo;Other or not set&rdquo; filter is unavailable until it can, and the Business type and Profile columns show &ldquo;—&rdquo; rather than a guess.
            </p>
          )}
          {centreRead.ok && (reviewCount > 0 || reviewActive) && (
            <div style={{ marginBottom: 14 }}>
              <FilterBar
                label="Review business types"
                active={reviewActive ? REVIEW_BUSINESS_TYPE : undefined}
                options={[{ key: REVIEW_BUSINESS_TYPE, label: "Business type: Other or not set", count: reviewCount }]}
                buildHref={buildReviewHref}
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
          {reviewActive && rows.length === 0 ? (
            <EmptyNote>Every client in this view has a business type.</EmptyNote>
          ) : (
            <ClientsTable columns={COLUMNS} rows={rows} canManage={can(me, "client.delete", tenant)} viewKey="clients" />
          )}
        </>
      )}
    </>
  );
}
