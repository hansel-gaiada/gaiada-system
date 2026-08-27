import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  getApAging, reconcileAp, listPeriods, listApVendors, listApOpenBills, listApBills, listAccounts,
  money, type ApAgingRow,
} from "@/lib/finance";
import { Card, KpiTile, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AgingTable } from "@/components/finance/AgingTable";
import { EnterBillForm, ReleasePaymentForm, CreateVendorForm } from "@/components/finance/ApForms";
import { ApApprovalQueue } from "@/components/finance/ApApprovalQueue";

// Payables — what the company owes vendors, bucketed by age, and whether that ties to the ledger.
//
// ── THE MIRROR OF RECEIVABLES, WITH ONE DIFFERENCE THAT MATTERS ────────────────────────────────
// Structurally this is the AR page with the direction reversed. The difference is consequence: an
// AR aging that is wrong means chasing the wrong customer, while an AP aging that is wrong means
// either paying twice or missing a payment — and in Indonesia a missed vendor bill usually carries
// withholding that was already deducted and is owed to DJP whether or not the vendor was paid.
//
// Which is why the withholding split is called out below rather than assumed understood: a bill's
// gross is NOT what the vendor is owed. The vendor gets the net; the tax office gets the rest, and
// that second liability does not appear in this aging at all.
export default async function FinancePayablesPage({
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

  const today = new Date().toISOString().slice(0, 10);
  const current = periods.find((p) => p.startDate <= today && p.endDate >= today);
  const asOf = sp.asOf ?? current?.endDate ?? periods[periods.length - 1]?.endDate ?? today;

  const [rows, rec, vendors, openBills, accounts, draftBills] = await Promise.all([
    getApAging(userId, tenant, asOf),
    reconcileAp(userId, tenant, asOf),
    listApVendors(userId, tenant),
    listApOpenBills(userId, tenant),
    listAccounts(userId, tenant),
    listApBills(userId, tenant, "draft"),
  ]);

  // The pickers are built from the REAL chart, not a hardcoded list of codes — same reasoning as
  // the receivables page. Which codes exist genuinely differs per company, because the chart is
  // instantiated from a template and then edited.
  const expenseAccounts = (accounts ?? [])
    .filter((a) => a.accountType === "expense" && a.allowManualPosting && a.status === "active")
    .map((a) => ({ code: a.code, name: a.name }));
  const bankAccounts = (accounts ?? [])
    .filter((a) => a.accountType === "asset" && a.allowManualPosting && a.status === "active"
      && (a.code.startsWith("11") || /bank|kas/i.test(a.name)))
    .map((a) => ({ code: a.code, name: a.name }));
  // A withholding payable is a LIABILITY to DJP, not the vendor — offering the expense/bank lists
  // here would let a bill's withholding land in the wrong account type entirely.
  const liabilityAccounts = (accounts ?? [])
    .filter((a) => a.accountType === "liability" && a.allowManualPosting && a.status === "active")
    .map((a) => ({ code: a.code, name: a.name }));

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Payables</h1>
        <p className="fin-page__asof">As of {asOf}</p>
      </header>

      {rec?.position ? (
        <div className="fin-kpis">
          <KpiTile label="Open bills" value={money(rec.position.openBills)} foot="received and not yet paid" />
          <KpiTile
            label="Payments on account"
            value={money(rec.position.paymentsOnAccount)}
            foot="paid but not allocated to a bill"
          />
          <KpiTile label="Net payable" value={money(rec.position.netPayable)} foot="what is actually owed" />
        </div>
      ) : null}

      <Card
        title="Aging"
        hint="Buckets are by days past due. These are amounts owed to VENDORS — withholding deducted from a bill is a separate liability to the tax office and is not in this table."
        style={{ marginTop: 22 }}
      >
        <AgingTable
          rows={rows}
          partyLabel="Vendor"
          partyCode={(r) => (r as ApAgingRow).vendorCode}
          partyName={(r) => (r as ApAgingRow).vendorName}
          verdict={rec}
          emptyNote="No vendor has an outstanding balance as of this date. That is a real answer, not a missing one — the subledger was read and returned nothing."
        />
      </Card>

      <div style={{ marginTop: 22, display: "grid", gap: 22 }}>
        <ApApprovalQueue drafts={draftBills} />
        <EnterBillForm vendors={vendors} expenseAccounts={expenseAccounts} liabilityAccounts={liabilityAccounts} />
        <ReleasePaymentForm vendors={vendors} openBills={openBills} bankAccounts={bankAccounts} />
        <CreateVendorForm />
      </div>

      <Card title="What is still not built here" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Credit notes and write-offs are not built for payables — neither has SQL behind it yet, so
          building a form would mean inventing the accounting rather than exposing it. The AR side
          (<code>/finance/receivables</code>) has both, for the mirror-image case: a supplier
          crediting or forgiving what the company owes THEM has no engine here yet.
        </p>
      </Card>
    </div>
  );
}
