import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can, isElevated } from "@/lib/rbac";
import { getInvoice, getIssueReadiness } from "@/lib/invoice";
import { invoiceDocumentState, DOCUMENT_PREPARING_TEXT } from "@/lib/billingView";
import { listMembers } from "@/lib/entities";
import { serviceLinesOrNull } from "@/lib/billingNumbering-data";
import { decodeText } from "@/lib/billingNumbering";
import { money, formatDate, formatDateTime } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { DescriptionList } from "@/components/DescriptionList";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { FileLink } from "@/components/clients/billing/FileLink";
import { IssueBlockers } from "@/components/billing/IssueBlockers";
import { MaskedAccount } from "@/components/billing/MaskedAccount";
import { InvoiceActions } from "./InvoiceActions";
import { ServiceLinePicker } from "./ServiceLinePicker";
import { VoidInvoice } from "./VoidInvoice";
import "@/components/billing/billing-screens.css";

type Params = Promise<{ invoiceId: string }>;

// PV5-09 — the staff invoice page, in its three lives:
//   draft / approved : the maker-checker trail and, for an approved invoice, what is MISSING before it can be issued
//                      (read from `GET …/issue-readiness`, so the list is on the page before anyone clicks Issue);
//   issued (`sent`)  : the invoice of record: number, dates, the PDF, the issuer as it was frozen at issue, tax and
//                      totals, a ledger link for the finance read tier, and Void behind a confirm;
//   void / paid      : the same record, read-only.
// Every figure is the API's, formatted and never recomputed. Whether the client sees the invoice is the backend's
// `clientVisible` (PV3-09), never a guess from the status.
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

  // PV5-09: what is missing is shown BEFORE anyone clicks Issue. Only read for an approved invoice (the one state that
  // can be issued), and `null` means the read gave no answer (an older server, or a refusal): then nothing is claimed
  // either way and the server's own check, inside the issue transaction, is the gate.
  const readiness = inv.status === "approved" && (canBill || holdsApproveCapability)
    ? await getIssueReadiness(userId, tenant, invoiceId)
    : null;
  const blockers = readiness?.blockers ?? [];
  // PV5-04b (PV-D35): the service line sets the code in the number. Staff pick it before issue (the picker is also where the
  // NO_SERVICE_LINE blocker's link lands). `null` lines = the viewer may not read them: no picker, and the server decides.
  const canChooseLine = (inv.status === "approved" || inv.status === "draft") && (canBill || holdsApproveCapability);
  const serviceLines = canChooseLine ? await serviceLinesOrNull(userId, tenant) : null;
  // An invoice is ISSUED once it has its number (status `sent` reads "Issued"). A legacy sent/paid row has none.
  const issued = Boolean(inv.invoiceNo);
  const pdf = invoiceDocumentState(inv);
  // The ledger link is for the finance read tier. It goes to Receivables: no per-invoice ledger page exists yet.
  const canSeeLedger = issued && (can(me, "finance.ar.view", tenant) || isElevated(me));

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
            canBill={canBill || holdsApproveCapability}
            isCreator={isCreator}
            legacyUnknownCreator={legacyUnknownCreator}
            invoiceNo={inv.invoiceNo ?? null}
            blockerCount={readiness ? blockers.length : null}
          />
        )}
      />
      <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginBottom: 20 }}>
        <Card title="Summary">
          <DescriptionList items={[
            { label: "Client", value: inv.clientName },
            {
              label: "Status",
              value: (
                <span>
                  {/* PV5-04: `sent` means issued through the ledger, so it reads "Issued". */}
                  <StatusBadge label={inv.status === "sent" ? "Issued" : inv.status} />
                  <ClientVisibilityMarker clientVisible={inv.clientVisible} />
                </span>
              ),
            },
            { label: "Period", value: inv.periodStart ? `${formatDate(inv.periodStart)} – ${formatDate(inv.periodEnd)}` : "—" },
            { label: "Total", value: money(inv.total, inv.currency) },
            // Staff-only (this is the staff page). A legacy or older-server invoice has none: an em dash, never a guess.
            { label: "Service line", value: inv.serviceLineName ?? (inv.serviceLineKey ?? "—") },
          ]} />
          {inv.legacyUnissued && (
            <p className="bs-note" style={{ marginTop: 10 }}>
              This invoice was marked sent before invoices were issued through the ledger, so it has no number, no frozen
              issuer details and no PDF.
            </p>
          )}
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

      {canChooseLine && serviceLines !== null && (
        <div id="service-line" style={{ marginBottom: 20 }}>
          <Card title="Service line" hint="Sets the code in this invoice's number. Only staff can decode it; a client sees the number only.">
            <ServiceLinePicker
              invoiceId={inv.id} lines={serviceLines}
              chosenKey={inv.serviceLineKey ?? null} defaultKey={inv.defaultServiceLineKey ?? null}
            />
          </Card>
        </div>
      )}

      {inv.status === "approved" && blockers.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <IssueBlockers blockers={blockers} lead="This invoice can't be issued yet. Clear these first:" />
        </div>
      )}

      {issued && (
        <div style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", marginBottom: 20 }}>
          <Card title="Invoice of record" hint="The invoice as it was issued. It cannot change; a mistake is corrected by voiding it.">
            <DescriptionList items={[
              { label: "Invoice no.", value: inv.invoiceNo },
              // PV5-04b: what the number's code stands for. Staff only; absent on an older server or a legacy number.
              ...(inv.numberCode ? [{
                label: "Number code",
                value: (
                  <span>
                    <span className="bs-code">{inv.numberCode}</span>
                    {decodeText(inv.numberDecode) ? <> · {decodeText(inv.numberDecode)}</> : null}
                  </span>
                ),
              }] : []),
              { label: "Issued", value: formatDate(inv.issueDate ?? null) },
              { label: "Due", value: formatDate(inv.dueDate ?? null) },
              {
                label: "PDF",
                value: pdf.kind === "link"
                  ? <FileLink fileId={pdf.fileId} label={`Invoice ${inv.invoiceNo} PDF`} />
                  : <span className="bs-pending">{DOCUMENT_PREPARING_TEXT}</span>,
              },
              ...(canSeeLedger ? [{
                label: "Ledger",
                value: <Link className="bs-link" href="/finance/receivables">View in Receivables</Link>,
              }] : []),
            ]} />
          </Card>
          <Card title="Issued by" hint="The issuer's details as they were when the invoice was issued, not as they are today.">
            {inv.issuer ? (
              <DescriptionList items={[
                { label: "Legal name", value: inv.issuer.legalName ?? "—" },
                { label: "Address", value: inv.issuer.address ?? "—" },
                { label: "NPWP", value: inv.issuer.npwp ?? "—" },
                ...(inv.issuer.isPkp != null ? [{ label: "PKP", value: inv.issuer.isPkp ? "Registered" : "Not registered" }] : []),
                ...(inv.issuer.bank?.accountNo ? [
                  { label: "Bank", value: inv.issuer.bank.name ?? "—" },
                  { label: "Account name", value: inv.issuer.bank.accountName ?? "—" },
                  { label: "Account no.", value: <MaskedAccount value={inv.issuer.bank.accountNo} /> },
                ] : []),
              ]} />
            ) : (
              <p className="bs-note">No issuer details were recorded on this invoice.</p>
            )}
          </Card>
        </div>
      )}

      <Card title="Line items">
        <HairlineTable
          columns={[{ label: "Description" }, { label: "Hours", align: "right" }, { label: "Rate", align: "right" }, { label: "Amount", align: "right" }]}
          rows={inv.lines.map((l) => [l.description, String(l.hours), money(l.rate, inv.currency), money(l.amount, inv.currency)])}
          tcols="2.4fr 0.6fr 0.8fr 0.8fr"
        />
        {issued && (
          <div style={{ marginTop: 14 }}>
            <DescriptionList items={[
              { label: "Subtotal", value: inv.subtotal != null ? money(inv.subtotal, inv.currency) : "—" },
              { label: inv.taxCode ? `Tax (${inv.taxCode})` : "Tax", value: inv.taxTotal != null ? money(inv.taxTotal, inv.currency) : "—" },
              { label: "Total", value: <strong>{money(inv.total, inv.currency)}</strong> },
            ]} />
          </div>
        )}
      </Card>

      {issued && inv.status === "sent" && (
        <div style={{ marginTop: 20 }}>
          <Card title="Void">
            <VoidInvoice invoiceId={inv.id} invoiceNo={inv.invoiceNo ?? null} />
          </Card>
        </div>
      )}
    </>
  );
}
