import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { listInvoices } from "@/lib/billing";
import { money } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { BackendPending } from "@/components/BackendPending";
import { DataTable, type Column } from "@/components/data/DataTable";

const COLUMNS: Column[] = [
  { key: "clientName", header: "Client", sortable: true },
  { key: "period", header: "Period" },
  { key: "total", header: "Total", align: "right", sortable: true },
  { key: "status", header: "Status", format: "status", sortable: true, align: "right" },
];

export default async function BillingPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const canBill = tenant ? (can(me, "company.manage", tenant) || isElevated(me)) : false;
  if (!tenant) {
    return (<><PageHeader eyebrow="Business" title="Billing" /><EmptyNote>Select a company from the top bar.</EmptyNote></>);
  }
  if (!canBill) {
    return (<><PageHeader eyebrow="Business" title="Billing" /><EmptyNote>Billing is limited to finance administrators.</EmptyNote></>);
  }

  const invoices = await listInvoices(userId, tenant);
  const outstanding = invoices.filter((i) => i.status === "sent").reduce((n, i) => n + i.total, 0);
  const paid = invoices.filter((i) => i.status === "paid").reduce((n, i) => n + i.total, 0);
  const cur = invoices[0]?.currency ?? "USD";
  const rows = invoices.map((i) => ({
    id: i.id, clientName: i.clientName,
    period: i.periodStart ? `${i.periodStart} – ${i.periodEnd ?? ""}` : "—",
    total: money(i.total, i.currency), status: i.status,
  }));

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Billing"
        subtitle="Invoices generated from billable time."
        actions={<Link href="/billing/new" className="lux-btn lux-btn--solid lux-btn--sm">New invoice</Link>}
      />
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Invoices" value={String(invoices.length)} />
        <KpiTile label="Outstanding" value={money(outstanding, cur)} foot="sent, unpaid" />
        <KpiTile label="Paid" value={money(paid, cur)} />
      </div>
      {invoices.length === 0 ? (
        <>
          <BackendPending what="No invoices returned." contract="GET /api/:t/invoices" />
          <Card><EmptyNote>No invoices yet. Generate one from billable time.</EmptyNote></Card>
        </>
      ) : (
        <DataTable columns={COLUMNS} rows={rows} link={{ base: "/billing", idKey: "id", labelKey: "clientName" }} csvName="invoices" pageSize={20} />
      )}
    </>
  );
}
