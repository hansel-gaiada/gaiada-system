import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  getArAging, reconcileAr, listPeriods, listArCustomers, listArOpenInvoices, listAccounts,
  listArCreditNotes, money, type ArAgingRow,
} from "@/lib/finance";
import { Card, KpiTile, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AgingTable } from "@/components/finance/AgingTable";
import { IssueInvoiceForm, RecordReceiptForm, CreateCustomerForm } from "@/components/finance/ArForms";
import { IssueCreditNoteForm, CreditNotesTable, WriteOffInvoiceForm } from "@/components/finance/CreditNotesForms";

// Receivables — what customers owe, bucketed by age, and whether that agrees with the ledger.
//
// ── THE POSITION IS FOUR NUMBERS, NOT ONE ──────────────────────────────────────────────────────
// `netReceivable` alone hides two things a controller actually chases: payments received on account
// that have never been ALLOCATED to an invoice, and credit notes issued but not yet applied. Both
// reduce the net while the invoice they might settle still sits in the aging, so a healthy-looking
// net can coexist with a customer being dunned for something already credited or paid. An unapplied
// credit note credits the AR control account exactly as an unallocated receipt does — it is a credit
// note's NORMAL state, not an edge case — so it gets its own figure rather than vanishing into the
// net. Open invoices, payments on account, unapplied credits and the net are shown as four separate
// figures for that reason.
export default async function FinanceReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const periods = await listPeriods(userId, tenant);
  if (periods == null) return <EmptyNote>You do not have finance access for this company.</EmptyNote>;

  // Default to the current period's end, exactly as the reports page does. An aging is always AS OF
  // a date and defaulting to "today" would disagree with the statements the reader just looked at.
  const today = new Date().toISOString().slice(0, 10);
  const current = periods.find((p) => p.startDate <= today && p.endDate >= today);
  const asOf = sp.asOf ?? current?.endDate ?? periods[periods.length - 1]?.endDate ?? today;

  const [rows, rec, customers, openInvoices, accounts, creditNotes] = await Promise.all([
    getArAging(userId, tenant, asOf),
    reconcileAr(userId, tenant, asOf),
    listArCustomers(userId, tenant),
    listArOpenInvoices(userId, tenant),
    listAccounts(userId, tenant),
    listArCreditNotes(userId, tenant),
  ]);

  // The pickers are built from the REAL chart, not a hardcoded list of codes. A form offering `4100`
  // on a company whose chart does not carry it would fail at submit with an "unknown revenue
  // account" the user cannot act on — and which codes exist genuinely differs per company, because
  // the chart is instantiated from a template and then edited.
  const revenueAccounts = (accounts ?? [])
    .filter((a) => a.accountType === "revenue" && a.allowManualPosting && a.status === "active")
    .map((a) => ({ code: a.code, name: a.name }));
  const bankAccounts = (accounts ?? [])
    .filter((a) => a.accountType === "asset" && a.allowManualPosting && a.status === "active"
      && (a.code.startsWith("11") || /bank|kas/i.test(a.name)))
    .map((a) => ({ code: a.code, name: a.name }));
  // Contra-revenue, never the original revenue account — crediting revenue itself would net the
  // credit away and hide a deteriorating return rate inside ordinary sales. 42xx/43xx is the
  // Indonesian COA convention (Potongan/Retur Penjualan); the codes themselves still come from the
  // real chart, only the prefix heuristic is fixed, matching the bank-account filter above.
  const creditAccounts = (accounts ?? [])
    .filter((a) => a.accountType === "revenue" && a.allowManualPosting && a.status === "active"
      && (a.code.startsWith("42") || a.code.startsWith("43")))
    .map((a) => ({ code: a.code, name: a.name }));

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Receivables</h1>
        <p className="fin-page__asof">As of {asOf}</p>
      </header>

      {rec?.position ? (
        <div className="fin-kpis">
          <KpiTile label="Open invoices" value={money(rec.position.openInvoices)} foot="issued and not yet settled" />
          <KpiTile
            label="Payments on account"
            value={money(rec.position.paymentsOnAccount)}
            foot="received but not allocated to an invoice"
          />
          <KpiTile
            label="Unapplied credits"
            value={money(rec.position.unappliedCredits)}
            foot="issued but not yet applied to an invoice"
            hint="A credit note credits the AR control account the moment it is issued — the same as an unallocated receipt. This is a credit note's NORMAL state until someone decides what it settles, not an edge case, which is why it is a figure of its own rather than folded silently into the net."
          />
          <KpiTile label="Net receivable" value={money(rec.position.netReceivable)} foot="what is actually owed" />
        </div>
      ) : null}

      <Card
        title="Aging"
        hint="Buckets are by days past due, not days since issue — a 60-day invoice inside terms is current."
        style={{ marginTop: 22 }}
      >
        <AgingTable
          rows={rows}
          partyLabel="Customer"
          partyCode={(r) => (r as ArAgingRow).customerCode}
          partyName={(r) => (r as ArAgingRow).customerName}
          verdict={rec}
          emptyNote="No customer has an outstanding balance as of this date. That is a real answer, not a missing one — the subledger was read and returned nothing."
        />
      </Card>

      <div style={{ marginTop: 22, display: "grid", gap: 22 }}>
        <IssueInvoiceForm customers={customers} revenueAccounts={revenueAccounts} />
        <RecordReceiptForm
          customers={customers}
          openInvoices={openInvoices}
          bankAccounts={bankAccounts}
        />
        <CreateCustomerForm />
      </div>

      <Card
        title="Credit notes"
        hint="The customer never owed it. Reverses output VAT along with the sale."
        style={{ marginTop: 22 }}
      >
        <CreditNotesTable notes={creditNotes} openInvoices={openInvoices} />
      </Card>

      <div style={{ marginTop: 22 }}>
        <IssueCreditNoteForm customers={customers} openInvoices={openInvoices} creditAccounts={creditAccounts} />
      </div>

      <div style={{ marginTop: 22 }}>
        <WriteOffInvoiceForm openInvoices={openInvoices} />
      </div>

      <Card title="Design notes" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          A write-off and a credit note both bind to the same segregation-of-duties grant
          (<code>ar_writeoff_approve</code>) and both are a seeded blocking pair with
          <code> ar_receipt_posting</code> — the person who banks a receipt must not also be the one
          who writes off or credits the debt it might have settled (&ldquo;pocket the cash, then
          write off the debt&rdquo;).
        </p>
      </Card>
    </div>
  );
}