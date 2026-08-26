import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  getArAging, reconcileAr, listPeriods, listArCustomers, listArOpenInvoices, listAccounts,
  money, type ArAgingRow,
} from "@/lib/finance";
import { Card, KpiTile, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AgingTable } from "@/components/finance/AgingTable";
import { IssueInvoiceForm, RecordReceiptForm } from "@/components/finance/ArForms";

// Receivables — what customers owe, bucketed by age, and whether that agrees with the ledger.
//
// ── THE POSITION IS THREE NUMBERS, NOT ONE ─────────────────────────────────────────────────────
// `netReceivable` alone hides the thing a controller actually chases: payments received on account
// that have never been ALLOCATED to an invoice. Those reduce the net while the invoice they should
// have settled still sits in the aging, so a healthy-looking net can coexist with a customer being
// dunned for something they already paid. Open invoices, payments on account and the net are shown
// as three separate figures for that reason.
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

  const [rows, rec, customers, openInvoices, accounts] = await Promise.all([
    getArAging(userId, tenant, asOf),
    reconcileAr(userId, tenant, asOf),
    listArCustomers(userId, tenant),
    listArOpenInvoices(userId, tenant),
    listAccounts(userId, tenant),
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
      </div>

      <Card title="What is still not built here" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Credit notes and write-offs are not built. A write-off is deliberately a separate grant
          from banking a receipt — holding both is a seeded blocking conflict in the duty matrix
          (take the cash, then write off the debt), so the two must never arrive as one screen.
        </p>
        <p className="fin-muted">
          Adding a customer is also not built; customer records currently come from the finance
          seed. A customer is not a CRM client — it carries the NPWP, the PKP flag and the payment
          terms that decide how an invoice is taxed and aged.
        </p>
      </Card>
    </div>
  );
}