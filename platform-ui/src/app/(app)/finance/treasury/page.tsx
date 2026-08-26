import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listInstruments, getInstrumentSchedule, getTreasuryMaturity, reconcileTreasury,
  listPeriods, listAssetClasses, money, INSTRUMENT_KIND_LABEL,
} from "@/lib/finance";
import { Card, KpiTile, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { RecogniseLeaseAction } from "@/components/finance/RecogniseLeaseAction";

// Treasury — loans, bonds and leases, on one model.
//
// ── ONE TABLE, BECAUSE THEY ARE ONE THING ──────────────────────────────────────────────────────
// A bank loan, an issued bond and a finance lease differ in paperwork and in which standard governs
// them, but all three are "an amount borrowed, repaid on a schedule, carrying interest". Modelling
// them separately would mean three amortisation engines free to disagree about the same arithmetic.
// `kind` distinguishes them where it matters — a lease additionally recognises a right-of-use asset
// under PSAK 73, which a loan does not.
//
// ── THE SCHEDULE IS DERIVED, NEVER STORED ──────────────────────────────────────────────────────
// Computed at the EFFECTIVE rate when one is set, which is what PSAK 71 amortised cost requires — a
// stored schedule would silently keep the old numbers after a rate revision, and the final
// instalment absorbs rounding rather than leaving a few rupiah outstanding forever.
//
// ── CURRENT VS NON-CURRENT IS A PRESENTATION QUESTION WITH A DATE ──────────────────────────────
// The split is not a property of the loan; it is a property of the loan AS AT a balance-sheet date,
// and it moves every month. That is why it is computed here rather than stored on the instrument.
export default async function FinanceTreasuryPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; instrument?: string }>;
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

  const [instruments, maturity, rec, assetClasses] = await Promise.all([
    listInstruments(userId, tenant),
    getTreasuryMaturity(userId, tenant, asOf),
    reconcileTreasury(userId, tenant, asOf),
    listAssetClasses(userId, tenant),
  ]);

  // Only a lease can be recognised under PSAK 73. Filtering here rather than offering every
  // instrument and refusing later keeps the surface honest about what the action applies to — the
  // server refuses a non-lease anyway, but a control that offers an impossible choice is a bug.
  const leases = instruments.filter((i) => i.kind === "lease");

  const selected = sp.instrument ? instruments.find((i) => i.id === sp.instrument) ?? null : null;
  const schedule = selected ? await getInstrumentSchedule(userId, tenant, selected.id) : [];

  const outstanding = maturity.reduce((t, m) => t + Number(m.outstanding), 0);
  const currentPortion = maturity.reduce((t, m) => t + Number(m.currentPortion), 0);
  const nonCurrent = maturity.reduce((t, m) => t + Number(m.nonCurrentPortion), 0);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Treasury</h1>
        <p className="fin-page__asof">Loans, bonds and leases · position as at {asOf}</p>
      </header>

      <div className="fin-kpis">
        <KpiTile label="Instruments" value={String(instruments.length)} foot="loans, bonds and leases" />
        <KpiTile label="Outstanding" value={money(outstanding)} foot="principal not yet repaid" />
        <KpiTile
          label="Current portion"
          value={money(currentPortion)}
          foot="due within 12 months"
          hint="Falls due within a year of the as-at date. This is a presentation split that moves every month, not a property of the loan — which is why it is computed as at a date rather than stored."
        />
        <KpiTile label="Non-current" value={money(nonCurrent)} foot="due beyond 12 months" />
      </div>

      <Card title="Treasury tie-out" style={{ marginTop: 22 }}>
        <div className="fin-verdict">
          {rec == null ? (
            <>
              <StatusBadge label="archived" />
              <span className="fin-verdict__note">
                The tie-out could not be read. Unknown is not a pass.
              </span>
            </>
          ) : rec.clean ? (
            <>
              <StatusBadge label="active" />
              <span className="fin-verdict__note">
                Instrument balances agree with the accounts carrying them.
              </span>
            </>
          ) : (
            <>
              <StatusBadge label="blocked" />
              <span className="fin-verdict__note">
                {rec.problems.length} difference(s) between the instruments and the ledger.
              </span>
            </>
          )}
        </div>
        {rec && !rec.clean ? (
          <>
            <HairlineTable
              columns={[{ label: "Problem" }, { label: "Detail" }]}
              rows={rec.problems.map((p) => [p.problem, p.detail])}
            />
            <p className="fin-muted" style={{ marginBlockStart: 12 }}>
              A common cause is account tagging rather than a real difference: this check sums
              accounts tagged as treasury, and an instrument posted to an untagged liability account
              will appear as a discrepancy even when every figure is correct. Check the tagging on the
              accounts named above before hunting for a missing entry.
            </p>
          </>
        ) : null}
      </Card>

      <Card title="Instruments" style={{ marginTop: 22 }}>
        {instruments.length === 0 ? (
          <EmptyNote>
            No loans, bonds or leases are recorded for this company. Recording one is not built here
            yet — see the note at the foot of this page.
          </EmptyNote>
        ) : (
          <HairlineTable
            columns={[
              { label: "Code" }, { label: "Instrument" }, { label: "Kind" },
              { label: "Counterparty" }, { label: "Principal", align: "right" },
              { label: "Rate", align: "right" }, { label: "Matures" }, { label: "" },
            ]}
            rows={instruments.map((i) => [
              i.code,
              i.name,
              // Spelled out: `loan_payable` and `loan_receivable` run in OPPOSITE directions and a
              // reader must never have to decode which from a raw enum.
              INSTRUMENT_KIND_LABEL[i.kind] ?? i.kind,
              i.counterpartyName ?? "—",
              money(i.principal, i.currencyCode),
              // The EFFECTIVE rate is what the schedule amortises at when one is set; showing only
              // the nominal would explain neither the interest figures nor the carrying amount.
              i.effectiveRate ? `${i.effectiveRate}% eff.` : i.nominalRate ? `${i.nominalRate}%` : "—",
              i.maturityDate ?? "—",
              <a key={i.id} href={`/finance/treasury?instrument=${i.id}`}>schedule</a>,
            ])}
          />
        )}
      </Card>

      {selected ? (
        <Card
          title={`Amortisation — ${selected.code} · ${selected.name}`}
          hint="Derived at the effective rate. The final instalment absorbs rounding, so the closing balance reaches exactly zero."
          style={{ marginTop: 22 }}
        >
          {schedule.length === 0 ? (
            <EmptyNote>No schedule could be derived for this instrument.</EmptyNote>
          ) : (
            <HairlineTable
              columns={[
                { label: "#" }, { label: "Due" }, { label: "Opening", align: "right" },
                { label: "Interest", align: "right" }, { label: "Principal", align: "right" },
                { label: "Closing", align: "right" },
              ]}
              rows={schedule.map((r) => [
                String(r.seq), r.dueDate,
                money(r.opening, selected.currencyCode),
                money(r.interest, selected.currencyCode),
                money(r.principal, selected.currencyCode),
                money(r.closing, selected.currencyCode),
              ])}
            />
          )}
        </Card>
      ) : null}

      {maturity.length > 0 ? (
        <Card title="Maturity split" hint="How each instrument presents on the balance sheet as at this date." style={{ marginTop: 22 }}>
          <HairlineTable
            columns={[
              { label: "Code" }, { label: "Kind" }, { label: "Outstanding", align: "right" },
              { label: "Current", align: "right" }, { label: "Non-current", align: "right" },
              { label: "Matures" },
            ]}
            rows={maturity.map((m) => [
              m.code,
              INSTRUMENT_KIND_LABEL[m.kind] ?? m.kind,
              money(m.outstanding), money(m.currentPortion), money(m.nonCurrentPortion),
              m.maturityDate ?? "—",
            ])}
          />
        </Card>
      ) : null}

      {leases.length > 0 ? (
        <Card
          title="Recognise a lease (PSAK 73)"
          hint="Creates a right-of-use asset and a lease liability. The balance sheet grows on both sides."
          style={{ marginTop: 22 }}
        >
          {leases.map((l) => (
            <div key={l.id} style={{ marginBlockEnd: 26 }}>
              <Eyebrow>{l.code} · {l.name}</Eyebrow>
              <RecogniseLeaseAction
                instrumentId={l.id}
                instrumentCode={l.code}
                assetClasses={assetClasses.map((c) => ({ id: c.id, code: c.code, name: c.name }))}
              />
            </div>
          ))}
        </Card>
      ) : null}

      <Card title="What is not built here" style={{ marginTop: 22 }}>
        <p className="fin-muted">
          Recording a new instrument and posting an interest accrual are implemented in the engine
          and <strong>not exposed here</strong>. Everything above is live and read from the real
          instruments.
        </p>
        <p className="fin-muted">
          {leases.length === 0
            ? "Lease recognition IS wired, but this company has no instrument of kind `lease`, so the action has nothing to apply to and is not shown."
            : "Lease recognition is wired above, behind a typed-confirmation gate."}
        </p>
      </Card>
    </div>
  );
}
