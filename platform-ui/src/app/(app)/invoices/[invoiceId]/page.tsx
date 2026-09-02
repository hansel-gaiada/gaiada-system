import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { getInvoice } from "@/lib/invoice";
import { listMembers } from "@/lib/entities";
import { money, formatDate, formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { InvoiceActions } from "./InvoiceActions";

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

  // IAM-GAP-01/02 — per-INSTANCE narrowing `can()` cannot express: the invoice's own createdBy is
  // data, not a role, so it is read here rather than baked into a capability. A capability answers
  // "should the Approve control render at all" (invoice.approve — company_admin/manager, or
  // isElevated); this file additionally hides it for the exact invoice the viewer raised, and for a
  // legacy row with no recorded creator when the viewer isn't elevated (Cerbos fails closed on those
  // for company_admin/manager — only the platform_admin wildcard can still reach them).
  const holdsApproveCapability = can(me, "invoice.approve", tenant) || isElevated(me);
  const isCreator = !!inv.createdBy && inv.createdBy === me.userId;
  const legacyUnknownCreator = !inv.createdBy && !isElevated(me);
  const canApprove = holdsApproveCapability && !isCreator && !legacyUnknownCreator;

  // Best-effort id -> name lookup for createdBy/approvedBy/updatedBy. `/members` is readable by any
  // member (unlike the admin-only `/users` list `lib/people.ts` prefers), so this degrades to the
  // raw id rather than 403ing the whole page for a manager who lacks admin.access.
  let nameFor = (id: string | null) => id ?? "—";
  try {
    const members = await listMembers(userId, tenant);
    const byId = new Map(members.map((m) => [m.user_id, m.name]));
    nameFor = (id: string | null) => (id ? byId.get(id) ?? id : "—");
  } catch (e) {
    if (!(e instanceof PlatformError)) throw e;
    // Directory unavailable — fall back to raw ids, set above.
  }

  return (
    <>
      <PageHeader
        eyebrow="Invoice"
        title={`${inv.clientName} · ${money(inv.total, inv.currency)}`}
        breadcrumbs={[{ label: "Invoices", href: "/invoices" }, { label: inv.clientName }]}
        actions={(
          <InvoiceActions
            invoiceId={inv.id}
            status={inv.status}
            canApprove={canApprove}
            canBill={canBill}
            isCreator={isCreator}
            legacyUnknownCreator={legacyUnknownCreator}
          />
        )}
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
        {/* IAM-GAP-01/02 — the maker/checker trail: who raised it, who signed off, who touched it last. */}
        <Card title="Approval trail">
          <DescriptionList items={[
            { label: "Raised by", value: nameFor(inv.createdBy) },
            { label: "Approved by", value: inv.approvedBy ? nameFor(inv.approvedBy) : "—" },
            { label: "Approved at", value: inv.approvedAt ? formatDateTime(inv.approvedAt) : "—" },
            { label: "Last updated by", value: nameFor(inv.updatedBy) },
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
