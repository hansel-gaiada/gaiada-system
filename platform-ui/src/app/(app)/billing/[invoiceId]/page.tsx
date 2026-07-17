import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { getInvoice } from "@/lib/billing";
import { markInvoiceSent, markInvoicePaid } from "@/lib/billingActions";
import { money, formatDate } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";

type Params = Promise<{ invoiceId: string }>;

export default async function InvoiceDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { invoiceId } = await params;
  if (!tenant) notFound();

  const inv = await getInvoice(userId, tenant, invoiceId);
  if (!inv) notFound();
  const canBill = can(me, "company.manage", tenant) || isElevated(me);

  return (
    <>
      <PageHeader
        eyebrow="Invoice"
        title={`${inv.clientName} · ${money(inv.total, inv.currency)}`}
        breadcrumbs={[{ label: "Billing", href: "/billing" }, { label: inv.clientName }]}
        actions={canBill ? (
          <>
            {inv.status === "draft" && <form action={markInvoiceSent.bind(null, inv.id)}><button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Mark sent</button></form>}
            {inv.status === "sent" && <form action={markInvoicePaid.bind(null, inv.id)}><button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Mark paid</button></form>}
          </>
        ) : undefined}
      />
      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginBottom: 20 }}>
        <Card title="Summary">
          <DescriptionList items={[
            { label: "Client", value: inv.clientName },
            { label: "Status", value: <StatusBadge label={inv.status} /> },
            { label: "Period", value: inv.periodStart ? `${formatDate(inv.periodStart)} – ${formatDate(inv.periodEnd)}` : "—" },
            { label: "Total", value: money(inv.total, inv.currency) },
          ]} />
        </Card>
      </div>
      <Card title="Line items">
        <HairlineTable
          columns={[{ label: "Description" }, { label: "Hours", align: "right" }, { label: "Rate", align: "right" }, { label: "Amount", align: "right" }]}
          rows={inv.lines.map((l) => [l.description, String(l.hours), money(l.rate, inv.currency), money(l.amount, inv.currency)])}
          tcols="2.4fr 0.6fr 0.8fr 0.8fr"
        />
      </Card>
    </>
  );
}
