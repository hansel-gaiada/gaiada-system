import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPortalInvoice } from "@/lib/portal-data";
import { clientStatus, money, portalDate } from "@/lib/portal";
import { Card, Eyebrow, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPaymentForm } from "@/components/portal/PortalPaymentForm";
import { PortalFacts, PortalLink, PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// CP-13 — one invoice: its frozen line items, its payment history, and the form to tell us you've paid.
//
// Line items are read from `invoices.lines`, which was computed and FROZEN at creation. Deliberately not
// recomputed from time entries: an invoice is a statement made at a point in time, and a page that
// re-derived it would quietly disagree with the PDF the client was sent.
export default async function PortalInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const invoice = await getPortalInvoice(userId, tenant, invoiceId);
  // 404 for "not yours" and "does not exist" alike — the BFF makes them indistinguishable on purpose.
  if (!invoice) notFound();

  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const canPay = invoice.balance > 0 && invoice.status !== "void";
  const pendingPayments = invoice.payments.filter((p) => p.status === "pending");

  return (
    <>
      <PortalPageHead
        eyebrow={invoice.clientName ?? "Your account"}
        title={
          invoice.periodStart && invoice.periodEnd
            ? `${portalDate(invoice.periodStart)} — ${portalDate(invoice.periodEnd)}`
            : "Invoice"
        }
        lead={`Invoice issued ${portalDate(invoice.issuedAt)}.`}
        actions={<PortalLive topics={["invoices"]} />}
      />

      <div className="cp-stack">
        <Card title="Summary" headerRight={<PortalStatus status={invoice.status} />}>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap", marginBottom: 16 }}>
            <div>
              <Eyebrow style={{ display: "block", marginBottom: 3, opacity: 0.6 }}>Invoice total</Eyebrow>
              <span className="cp-money">{money(invoice.total, invoice.currency)}</span>
            </div>
            <div>
              <Eyebrow style={{ display: "block", marginBottom: 3, opacity: 0.6 }}>
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
                <Eyebrow style={{ display: "block", marginBottom: 5, opacity: 0.6 }}>Your receipts</Eyebrow>
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

        {canPay ? (
          <Card title="Tell us you've paid" hint="Recording a transfer here puts it in our finance team's queue to verify against the bank statement.">
            <PortalPaymentForm invoiceId={invoice.id} balance={invoice.balance} currency={invoice.currency} />
          </Card>
        ) : (
          <Card title="Nothing to pay">
            <EmptyNote>
              {invoice.status === "void"
                ? "This invoice was cancelled — there's nothing to pay."
                : `This invoice is settled (${clientStatus(invoice.status)}). Thank you.`}
            </EmptyNote>
          </Card>
        )}

        <PortalLink href="/portal/invoices">All invoices</PortalLink>
      </div>
    </>
  );
}
