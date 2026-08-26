import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getApAging, reconcileAp, listPeriods, money, type ApAgingRow } from "@/lib/finance";
import { Card, KpiTile, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AgingTable } from "@/components/finance/AgingTable";

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

  const [rows, rec] = await Promise.all([
    getApAging(userId, tenant, asOf),
    reconcileAp(userId, tenant, asOf),
  ]);

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

      <Card title="Entering a bill and releasing a payment" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Neither is <strong>built here yet</strong>. The subledger is complete, including Indonesian
          withholding (PPh 21/23/4(2)) — entering a 20,000,000 contractor bill correctly splits it
          into 19,600,000 owed to the vendor and 400,000 owed to DJP, which is the thing a single
          &ldquo;accounts payable&rdquo; line would hide.
        </p>
        <p className="fin-muted">
          Payment release is deliberately the most restricted action in the module (module manager
          only, high assurance) and is separated from bill entry, because entering a bill and
          releasing its payment is a seeded blocking conflict in the duty matrix. Building the two
          together as one screen would defeat that, so they need separate surfaces rather than one
          form with two buttons.
        </p>
      </Card>
    </div>
  );
}
