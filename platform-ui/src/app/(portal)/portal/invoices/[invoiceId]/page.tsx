import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalInvoice } from "@/lib/portal-data";
import { clientStatus, isCheckoutReturn, money, portalDate } from "@/lib/portal";
import { DOCUMENT_PREPARING_TEXT, invoiceDocumentState } from "@/lib/billingView";
import { Card, Eyebrow, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPaymentForm } from "@/components/portal/PortalPaymentForm";
import { PortalPayOnline } from "@/components/portal/PortalPayOnline";
import { PortalFacts, PortalLink, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-13 — one invoice: its frozen line items, its payment history, and the form to tell us you've paid.
//
// Line items are read from `invoices.lines`, which was computed and FROZEN at creation. Deliberately not
// recomputed from time entries: an invoice is a statement made at a point in time, and a page that
// re-derived it would quietly disagree with the PDF the client was sent.
//
// PV5-09 — and, once the invoice is ISSUED (PV-D7), the invoice of record: its number, issue and due dates, who issued it
// (the issuer block frozen at issue, with the issuer's legal name and tax id), tax and totals, the PDF, and "How to pay"
// with the bank account from that same frozen block. Every figure is the API's, formatted and never recomputed here. The
// PDF is rendered after the commit (PV5-07), so an issued invoice with no file yet says "being prepared"; an older server
// omits the field, which reads the same.
//
// PV5-10 — "Pay online" (the payment provider's hosted page) shows ONLY when the API's `onlinePayment.available` says so.
// Coming back from that page (`?checkout=finished`, or the provider's own return parameters) shows "We're confirming your
// payment" and nothing else changes: the payment itself is written only from the provider's verified, re-fetched notice,
// and PortalLive refreshes this page when it is (`invoice.payment.confirmed`).
export default async function PortalInvoicePage({ params, searchParams }: {
  params: Promise<{ invoiceId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { invoiceId } = await params;
  const returning = isCheckoutReturn(await searchParams);
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const invoice = await getPortalInvoice(userId, tenant, invoiceId);
  // 404 for "not yours" and "does not exist" alike — the BFF makes them indistinguishable on purpose.
  if (!invoice) notFound();

  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  // PV5-04: the API says whether this invoice accepts a claim (`payable`: issued, unpaid, and not already fully being
  // verified). An older server without the field keeps the old rule.
  const canPay = invoice.payable ?? (invoice.balance > 0 && invoice.status !== "void");
  const bank = invoice.issuer?.bank ?? null;
  const issuer = invoice.issuer ?? null;
  const pendingPayments = invoice.payments.filter((p) => p.status === "pending");
  const pdf = invoiceDocumentState(invoice);
  const taxLines = Array.isArray(invoice.taxLines) ? invoice.taxLines : [];
  const hasTotalsBreakdown = invoice.subtotal != null || taxLines.length > 0 || invoice.taxTotal != null;
  const labelInk = { display: "block", marginBottom: 3, color: "var(--ink-subtle)" } as const;
  const settled = invoice.status === "paid" || invoice.balance <= 0;
  // Hidden while a payer is just back from the provider: a second "Pay online" there invites paying twice.
  const payOnline = invoice.onlinePayment?.available === true && !returning;

  return (
    <>
      <PortalPageHead
        eyebrow={invoice.clientName ?? "Your account"}
        title={
          invoice.invoiceNo
            ? `Invoice ${invoice.invoiceNo}`
            : invoice.periodStart && invoice.periodEnd
              ? `${portalDate(invoice.periodStart)} — ${portalDate(invoice.periodEnd)}`
              : "Invoice"
        }
        lead={`Invoice issued ${portalDate(invoice.issueDate ?? invoice.issuedAt)}.`}
        actions={<PortalLive topics={["invoices"]} />}
      />

      <div className="cp-stack">
        {returning && (
          <Card title="Your online payment">
            <p role="status" style={{ margin: 0, font: "400 14px/1.6 var(--font-body)" }}>
              {settled
                ? "Payment received. Thank you, this invoice is settled."
                : "We're confirming your payment with the payment provider. This page updates by itself once it is confirmed, usually within a minute. You don't need to tell us about it."}
            </p>
          </Card>
        )}

        <Card title="Summary" headerRight={<PortalStatus status={invoice.status} />}>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: 16 }}>
            <div>
              <Eyebrow style={labelInk}>Invoice total</Eyebrow>
              <span className="cp-money">{money(invoice.total, invoice.currency)}</span>
            </div>
            <div>
              <Eyebrow style={labelInk}>
                {invoice.balance > 0 ? "Still due" : "Settled"}
              </Eyebrow>
              <span className={`cp-money${invoice.balance > 0 ? " cp-money--danger" : ""}`}>
                {money(invoice.balance, invoice.currency)}
              </span>
            </div>
          </div>
          <PortalFacts
            rows={[
              { k: "Paid", v: money(invoice.paid, invoice.currency) },
              ...(pendingPayments.length > 0
                ? [{
                    k: "Being verified",
                    v: (
                      <>
                        {money(pendingPayments.reduce((s, p) => s + p.amount, 0), invoice.currency)}
                        <span style={{ color: "var(--ink-subtle)" }}>
                          {" "}· recorded by you, awaiting our confirmation
                        </span>
                      </>
                    ),
                  }]
                : []),
              ...(invoice.periodStart && invoice.periodEnd
                ? [{ k: "Period", v: `${portalDate(invoice.periodStart)} — ${portalDate(invoice.periodEnd)}` }]
                : []),
            ]}
          />
        </Card>

        {invoice.invoiceNo && (
          <Card title="Invoice of record" hint="The invoice as it was issued to you. It does not change after that.">
            <PortalFacts
              rows={[
                { k: "Invoice no.", v: invoice.invoiceNo, strong: true },
                { k: "Issued", v: portalDate(invoice.issueDate ?? invoice.issuedAt) },
                ...(invoice.dueDate ? [{ k: "Due", v: portalDate(invoice.dueDate) }] : []),
                ...(issuer?.legalName ? [{ k: "Issued by", v: issuer.legalName }] : []),
                ...(issuer?.address ? [{ k: "Address", v: <span style={{ whiteSpace: "pre-line" }}>{issuer.address}</span> }] : []),
                ...(issuer?.npwp ? [{ k: "Tax ID (NPWP)", v: issuer.npwp }] : []),
                {
                  k: "PDF",
                  v: pdf.kind === "link"
                    ? (
                      <a href={`/api/${tenant}/portal/files/${pdf.fileId}`}
                         style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
                        Download invoice {invoice.invoiceNo} (PDF)
                      </a>
                    )
                    : <span style={{ color: "var(--ink-muted)" }}>{DOCUMENT_PREPARING_TEXT}</span>,
                },
              ]}
            />
          </Card>
        )}

        <Card title="What this covers">
          {lines.length === 0 ? (
            <EmptyNote>No line items recorded on this invoice.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "Description" },
                { label: "Hours", align: "right" },
                { label: "Rate", align: "right" },
                { label: "Amount", align: "right" },
              ]}
              tcols="1fr 90px 130px 150px"
              rows={lines.map((l) => [
                l.description,
                l.hours === undefined ? "—" : String(l.hours),
                l.rate === undefined ? "—" : money(l.rate, invoice.currency),
                money(l.amount, invoice.currency),
              ])}
            />
          )}
          {hasTotalsBreakdown && (
            <div style={{ marginTop: 16 }}>
              <PortalFacts
                rows={[
                  ...(invoice.subtotal != null ? [{ k: "Subtotal", v: money(invoice.subtotal, invoice.currency) }] : []),
                  ...taxLines.map((t) => ({
                    k: `${t.code}${t.rate != null ? ` ${t.rate}%` : ""}`,
                    v: money(t.amount, invoice.currency),
                  })),
                  // A tax total with no per-line breakdown: say the total and never invent the lines.
                  ...(taxLines.length === 0 && invoice.taxTotal != null
                    ? [{ k: invoice.taxCode ? `Tax (${invoice.taxCode})` : "Tax", v: money(invoice.taxTotal, invoice.currency) }]
                    : []),
                  { k: "Total", v: money(invoice.total, invoice.currency), strong: true },
                ]}
              />
            </div>
          )}
        </Card>

        {invoice.payments.length > 0 && (
          <Card title="Payment history">
            <HairlineTable
              columns={[{ label: "Date" }, { label: "Method" }, { label: "Reference" }, { label: "Status" }, { label: "Amount", align: "right" }]}
              tcols="120px 130px 1fr 150px 140px"
              rows={invoice.payments.map((p) => [
                portalDate(p.paidOn),
                p.method.replace(/_/g, " "),
                p.reference ?? "—",
                <span key={p.id}>
                  <PortalStatus status={p.status} />
                  {/* A rejection must say WHY, in the row. A bare "Not accepted" leaves the client with no
                      idea whether to re-send the transfer or query the reference. */}
                  {p.status === "rejected" && p.rejectedReason && (
                    <span style={{ display: "block", font: "400 11px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
                      {p.rejectedReason}
                    </span>
                  )}
                  {p.status === "pending" && (
                    <span style={{ display: "block", font: "400 11px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
                      awaiting our confirmation
                    </span>
                  )}
                </span>,
                money(p.amount, p.currency),
              ])}
            />
            {/* Receipts the client themselves uploaded, linked back so they can retrieve their own proof. */}
            {invoice.payments.some((p) => p.proofFileId) && (
              <div style={{ marginTop: 14 }}>
                <Eyebrow style={{ display: "block", marginBottom: 5, color: "var(--ink-subtle)" }}>Your receipts</Eyebrow>
                <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
                  {invoice.payments.filter((p) => p.proofFileId).map((p) => (
                    <li key={p.id}>
                      <a href={`/api/${tenant}/portal/files/${p.proofFileId}`}
                         style={{ font: "500 13px var(--font-body)", color: "var(--erp-accent)" }}>
                        Receipt for {money(p.amount, p.currency)} on {portalDate(p.paidOn)}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        {payOnline && (
          <Card title="Pay online" hint="Pay on our payment provider's secure page. It confirms the payment to us directly.">
            <PortalPayOnline
              invoiceId={invoice.id}
              amountDue={invoice.onlinePayment?.amount ?? invoice.outstanding ?? invoice.balance}
              currency={invoice.onlinePayment?.currency ?? invoice.currency}
            />
          </Card>
        )}

        {/* PV5-04: where to pay, from the issuer block frozen on the invoice when it was issued. The reference is the invoice
            number: it is what lets us match a transfer to this invoice quickly. */}
        {canPay && bank?.accountNo && (
          <Card title="How to pay" hint="Pay by bank transfer to this account, then tell us below so we can match it.">
            <PortalFacts
              rows={[
                { k: "Bank", v: bank.name ?? "—" },
                { k: "Account name", v: bank.accountName ?? "—" },
                { k: "Account no.", v: bank.accountNo, strong: true },
                ...(invoice.invoiceNo ? [{ k: "Reference", v: invoice.invoiceNo }] : []),
                { k: "Amount due", v: money(invoice.outstanding ?? invoice.balance, invoice.currency), strong: true },
              ]}
            />
          </Card>
        )}

        {canPay ? (
          <Card title="Tell us you've paid" hint="Recording a transfer here puts it in our finance team's queue to verify against the bank statement.">
            <PortalPaymentForm invoiceId={invoice.id} balance={invoice.balance} currency={invoice.currency} />
          </Card>
        ) : (
          <Card title="Nothing to pay">
            <EmptyNote>
              {invoice.status === "void"
                ? "This invoice was cancelled — there's nothing to pay."
                : invoice.status === "paid" || invoice.balance <= 0
                  ? `This invoice is settled (${clientStatus(invoice.status)}). Thank you.`
                  : "We're verifying the payment you told us about, or this invoice can't be paid here. Questions? Contact us."}
            </EmptyNote>
          </Card>
        )}

        <PortalLink href="/portal/invoices">All invoices</PortalLink>
      </div>
    </>
  );
}
