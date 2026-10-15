import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getPpnSummary, getEfakturExceptions, listPeriods, listTaxCodes, money, type TaxCode } from "@/lib/finance";
import { getTaxReturnDriftResult, listTaxReturnsResult } from "@/lib/finance-data";
import { canWorkTaxReturns, defaultReturnPeriod } from "@/lib/taxReturns";
import { Card, KpiTile, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { TaxCodeManager } from "@/components/finance/TaxCodeManager";
import { TaxReturns } from "@/components/finance/TaxReturns";

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
//
// ── RETURNS (DW-7g-1) ──────────────────────────────────────────────────────────────────────────
// The Returns section prepares a period's return, records its filing and amends a filed one. Its list and its drift
// check are read through `ReadResult`, so a refused or failed read is said in words, never "no returns" or "no drift".
// The controls are offered to `company.manage`, a finance staff or manager grant, or an operator (a superset of the
// Cerbos `finance_tax` prepare/file rules, which `lib/rbac.ts` has no capability for); the server refuses the rest in words.
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
  // PV5-F2: the tax codes are set up here, and a taxed invoice is refused without them, so this card does not wait on a
  // fiscal calendar. `null` means the read was refused or unavailable, which is not the same claim as "no codes".
  const codes = await listTaxCodes(userId, tenant);
  // DW-7g-1: read for everyone who can read this page (`finance_tax` read), whatever they may DO with a return.
  const today = new Date().toISOString().slice(0, 10);
  const [returnsRead, driftRead] = await Promise.all([
    listTaxReturnsResult(userId, tenant),
    getTaxReturnDriftResult(userId, tenant),
  ]);
  const returnsSection = (
    <TaxReturns
      returns={returnsRead}
      drift={driftRead}
      canAct={canWorkTaxReturns(me, tenant)}
      defaultPeriod={defaultReturnPeriod(periods, today)}
    />
  );
  const codesCard = codes == null ? (
    <Card title="Tax codes" style={{ marginTop: 22 }}>
      <EmptyNote>The tax codes could not be loaded for this company.</EmptyNote>
    </Card>
  ) : (
    <div style={{ marginTop: 22 }}>
      <TaxCodeManager codes={codes as TaxCode[]} />
    </div>
  );

  if (periods.length === 0) {
    return (
      <div className="fin-page">
        <header className="fin-page__head">
          <Eyebrow>Finance &amp; Accounting</Eyebrow>
          <h1 className="fin-page__title">Tax</h1>
        </header>
        <EmptyNote>This company has no fiscal calendar, so there is no period to report tax for.</EmptyNote>
        {returnsSection}
        {codesCard}
      </div>
    );
  }

  // PPN is filed MONTHLY, so the natural window is one fiscal period — not the year to date. A
  // default spanning several months would produce a figure that matches no return anyone files.
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

      {returnsSection}

      {codesCard}

      <Card title="Filing and PPh" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Nothing is transmitted to the tax office from this page: that goes through a licensed ASP/PJAP. Recording a filing
          captures the receipt reference and freezes the figures as filed; an amended return is a correction,
          never an erasure.
        </p>
        <p className="fin-muted">
          The PPN figures above are for the period shown. PPh (21/23/4(2)) withholding is computed and posted by payroll
          and payables respectively; it is not summarised on this page, but its returns are prepared under Returns.
        </p>
      </Card>
    </div>
  );
}
