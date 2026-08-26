import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPpnSummary, getEfakturExceptions, listPeriods, money } from "@/lib/finance";
import { Card, KpiTile, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// Tax — the PPN position for a period, and the documents that put it at risk.
//
// ── UNCREDITABLE INPUT VAT IS A COST, AND IS SHOWN AS ONE ──────────────────────────────────────
// Input VAT the company cannot reclaim — because the vendor never issued a valid e-Faktur — is real
// money that will never come back. Netting it silently into one "PPN payable" figure would make the
// position look right while hiding an expense nobody chose to incur. So it is its own tile, beside
// the creditable figure rather than inside it.
//
// ── THE EXCEPTION LIST IS THE ACTIONABLE PART ──────────────────────────────────────────────────
// The summary says what is owed; the exceptions say what somebody can still DO about it. An
// AR_MISSING_EFAKTUR is the company's own failure to issue a faktur on a sale it has already
// booked — fixable, and expensive if it reaches a DJP audit unfixed. An AP_INPUT_VAT_LOST is a
// vendor's failure, chaseable only until the filing deadline. Both are listed with the document
// number and the amount at stake, because "there are exceptions" is not something anyone can act on.
export default async function FinanceTaxPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const periods = await listPeriods(userId, tenant);
  if (periods == null) return <EmptyNote>You do not have finance access for this company.</EmptyNote>;
  if (periods.length === 0) {
    return <EmptyNote>This company has no fiscal calendar, so there is no period to report tax for.</EmptyNote>;
  }

  // PPN is filed MONTHLY, so the natural window is one fiscal period — not the year to date. A
  // default spanning several months would produce a figure that matches no return anyone files.
  const today = new Date().toISOString().slice(0, 10);
  const current = periods.find((p) => p.startDate <= today && p.endDate >= today) ?? periods[periods.length - 1];
  const from = sp.from ?? current.startDate;
  const to = sp.to ?? current.endDate;

  const [ppn, exceptions] = await Promise.all([
    getPpnSummary(userId, tenant, from, to),
    getEfakturExceptions(userId, tenant, from, to),
  ]);

  const uncreditable = Number(ppn?.inputVatUncreditable ?? 0);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Tax</h1>
        <p className="fin-page__asof">
          PPN for {current.name} · {from} to {to}
        </p>
      </header>

      {ppn == null ? (
        <Card title="PPN">
          <EmptyNote>
            No PPN position could be computed for this period. If this company is not registered as a
            PKP, that is expected — output VAT is only charged by a registered taxable enterprise. The
            registration flag lives in <a href="/finance/settings">Settings</a>.
          </EmptyNote>
        </Card>
      ) : (
        <>
          <div className="fin-kpis">
            <KpiTile label="Output VAT" value={money(ppn.outputVat)} foot="PPN charged on sales" />
            <KpiTile
              label="Input VAT (creditable)"
              value={money(ppn.inputVatCreditable)}
              foot="reclaimable against output"
            />
            <KpiTile
              label="Input VAT (lost)"
              value={money(ppn.inputVatUncreditable)}
              foot={uncreditable > 0 ? "NOT reclaimable — a real cost" : "none this period"}
            />
            <KpiTile label="Net payable" value={money(ppn.netPayable)} foot="what is owed to DJP" />
          </div>

          {uncreditable > 0 ? (
            <Card title="Why input VAT was lost" style={{ marginTop: 22 }}>
              <p className="fin-muted">
                {money(ppn.inputVatUncreditable)} of input VAT cannot be credited this period. That is
                not an accounting adjustment — it is money paid to a vendor that will not be recovered
                from DJP, and it becomes an expense. The documents responsible are listed below.
              </p>
            </Card>
          ) : null}
        </>
      )}

      <Card
        title="e-Faktur exceptions"
        hint="Documents whose faktur status puts the position at risk. Empty here means the list was READ and was empty, not that it was skipped."
        style={{ marginTop: 22 }}
      >
        <div className="fin-verdict" style={{ marginBottom: 16 }}>
          <StatusBadge label={exceptions.length === 0 ? "active" : "blocked"} />
          <span className="fin-verdict__note">
            {exceptions.length === 0
              ? "Every booked document in this period has the faktur it needs."
              : `${exceptions.length} document(s) need attention before this period is filed.`}
          </span>
        </div>

        {exceptions.length === 0 ? (
          <EmptyNote>Nothing outstanding for this period.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Kind" }, { label: "Document" }, { label: "Counterparty" },
              { label: "Date" }, { label: "Tax at stake", align: "right" }, { label: "Detail" },
            ]}
            rows={exceptions.map((e) => [
              // Spelled out rather than shown as a code: the two kinds have opposite owners. One is
              // ours to fix, the other is a vendor to chase, and a reader must not have to decode
              // which is which.
              e.kind === "AR_MISSING_EFAKTUR" ? "We owe a faktur" : "Vendor faktur missing",
              e.documentNo,
              e.counterparty,
              e.docDate,
              money(e.taxAmount),
              e.detail,
            ])}
          />
        )}
      </Card>

      <Card title="Preparing and filing a return" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          The return-preparation flow is <strong>not built here yet</strong>, and filing deliberately
          never will be from this page: transmission goes through a licensed ASP/PJAP. What the
          backend supports is recording that a return was LODGED and snapshotting the figures as
          filed — an amended return is a correction, never an erasure.
        </p>
        <p className="fin-muted">
          PPh (21/23/4(2)) withholding is computed and posted by payroll and payables respectively.
          It is not summarised on this page yet; only PPN is.
        </p>
      </Card>
    </div>
  );
}
