import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listPeriods, getTrialBalance, getBalanceSheet, getArAging, getApAging,
  reconcileAr, reconcileAp, verifyLedger, getCloseReadiness,
  money, fiscalYearStart, PERIOD_STATE_LABEL, BLOCKER_LABEL,
  type FiscalPeriod,
} from "@/lib/finance";
import { Card, KpiTile, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// Finance & Accounting overview.
//
// ── THE DESIGN RULE FOR THIS PAGE: NEVER RENDER AN UNEARNED GREEN ────────────────────────────────
// Four figures here are VERDICTS — the ledger chain, the two subledger tie-outs, and the close gate.
// Each means "problems found; empty means pass". `lib/finance.ts` returns `null` rather than an empty
// list when a verdict cannot be fetched, and this page renders that as **"absent"** — visually
// distinct from a pass, with the reason spelled out next to it.
//
// The failure mode being designed against is specific: a 403 or 404 degrading to `[]` would paint a
// tick beside "Ledger chain" for a check that never ran. On a finance surface that is not cosmetic —
// somebody reads that tick and closes a period.
//
// ── AND NO COMPUTED MONEY ───────────────────────────────────────────────────────────────────────
// Every figure comes from the BFF, which gets it from a SQL function sitting next to the constraint
// that guarantees it. The only arithmetic here is summing an aging column for a KPI tile, which is a
// presentation total over rows the server already computed — not an accounting figure.
//
// `StatusBadge` takes a LABEL and derives its colour family from a shared vocabulary
// (components/ui.tsx STATUS_FAMILY), so the words below are chosen from that vocabulary rather than
// invented: "active"/"paid" read positive, "blocked"/"error" read negative, "draft"/"archived" read
// inactive. A word outside it silently falls back to the neutral in-progress family.

function periodToday(periods: FiscalPeriod[]): FiscalPeriod | null {
  const today = new Date().toISOString().slice(0, 10);
  return periods.find((p) => p.startDate <= today && p.endDate >= today) ?? null;
}

/** A verdict row. `null` is NOT a pass — it is "the check did not run", and it says so out loud. */
function Verdict({ value, label }: { value: { clean: boolean } | null; label: string }) {
  if (value == null) {
    return (
      <div className="fin-verdict">
        <StatusBadge label="archived" />
        <strong>{label}</strong>
        <span className="fin-verdict__note">
          not checked — the check could not run, which is not a pass
        </span>
      </div>
    );
  }
  return (
    <div className="fin-verdict">
      <StatusBadge label={value.clean ? "active" : "blocked"} />
      <strong>{label}</strong>
      <span className="fin-verdict__note">{value.clean ? "ties" : "does not tie"}</span>
    </div>
  );
}

export default async function FinanceOverviewPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const periods = await listPeriods(userId, tenant);

  // Department rows in the sidebar are deliberately ungated (see components/shell/nav.ts) — the
  // console explains itself instead. So this page must tell the two "nothing here" cases apart,
  // because they need opposite responses from the reader.
  if (periods == null) {
    return (
      <EmptyNote>
        You do not have finance access for this company. Finance data is restricted to the finance
        department and company administrators — ask an administrator for a finance role if you need it.
      </EmptyNote>
    );
  }

  if (periods.length === 0) {
    // Deliberately not a zeroed dashboard. No calendar means no period to report on, and rendering
    // "Rp 0" everywhere would be a claim about the books rather than a statement about setup.
    return (
      <EmptyNote>
        This company has no fiscal calendar, so there is nothing to report yet. Seed the department
        with <code>npm run seed:finance-config</code> in platform-nest, or cut a fiscal year first.
      </EmptyNote>
    );
  }

  const current = periodToday(periods);
  const asOf = current?.endDate ?? periods[periods.length - 1].endDate;
  const fyStart = fiscalYearStart(periods, asOf);

  // fyStart is REQUIRED by the balance sheet — "profit so far" is meaningless without knowing when
  // the year began, and passing a guessed 1 January would render a wrong sheet for any company whose
  // fiscal year starts elsewhere. If we cannot derive it, we ask for no sheet at all.
  const [tb, bs, arAging, apAging, arRec, apRec, chain, close] = await Promise.all([
    getTrialBalance(userId, tenant, asOf),
    fyStart ? getBalanceSheet(userId, tenant, asOf, fyStart) : Promise.resolve(null),
    getArAging(userId, tenant, asOf),
    getApAging(userId, tenant, asOf),
    reconcileAr(userId, tenant, asOf),
    reconcileAp(userId, tenant, asOf),
    verifyLedger(userId, tenant),
    current ? getCloseReadiness(userId, tenant, current.id) : Promise.resolve(null),
  ]);

  const arTotal = arAging.reduce((a, r) => a + Number(r.totalOutstanding), 0);
  const apTotal = apAging.reduce((a, r) => a + Number(r.totalOutstanding), 0);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        {/* The heading names the PAGE, not the period.
​
            It used to be the fiscal period plus its badge, which rendered an `<h1>` reading
            "Aug 2026 Open" — so the department's landing page never said what it was, and it was the
            only tab in the strip whose heading changed under you as the calendar moved. A screen
            reader announced the page as "Aug 2026 Open"; browser history and bookmarks got the same.
            The period is CONTEXT for these figures, so it sits on the context line with the as-at
            date, where every sibling tab already puts its scope. */}
        <h1 className="fin-page__title">Overview</h1>
        <p className="fin-page__asof">
          {current ? current.name : "No current period"}{" "}
          {current && (
            <StatusBadge label={current.state === "OPEN" ? "open" : current.state === "SOFT_LOCK" ? "review" : "done"} />
          )}{" "}
          · figures as at {asOf}
        </p>
      </header>

      <section className="fin-kpis">
        <KpiTile
          label="Total assets"
          value={bs ? money(bs.assets) : "—"}
          foot={bs ? (bs.balanced ? "Balance sheet balances" : "DOES NOT BALANCE") : undefined}
          hint={
            bs
              ? "Assets less contra accounts, as at the period end. Equity includes the year's profit so far, which is what makes the sheet balance before year-end close."
              : "Needs a fiscal year start to compute the year's profit — cut the calendar first."
          }
        />
        <KpiTile
          label="Receivables outstanding"
          value={money(arTotal)}
          foot={`${arAging.length} customer(s)`}
          hint="Open customer invoices. A customer prepayment is not netted in here — it sits as a credit against the control account, which is why this figure and the ledger's receivable balance can legitimately differ."
        />
        <KpiTile
          label="Payables outstanding"
          value={money(apTotal)}
          foot={`${apAging.length} vendor(s)`}
          hint="What vendors are owed. Tax withheld from a vendor bill is excluded — it is owed to the tax office, not the vendor, and appears as its own liability."
        />
        <KpiTile
          label="Trial balance"
          value={tb ? money(tb.totalDebit) : "—"}
          foot={tb ? (tb.balanced ? "Debits = credits" : "OUT OF BALANCE") : undefined}
          hint="Total debits. Equal to total credits for any window, because every journal is balanced and none is excluded — including reversals, which net to zero."
        />
      </section>

      <Card
        title="Integrity"
        hint="Each of these is a check, not a metric. “Not checked” means it could not run — never that it passed."
      >
        <div className="fin-verdicts">
          <Verdict value={chain} label="Ledger chain" />
          <Verdict value={arRec} label="Receivables tie to the ledger" />
          <Verdict value={apRec} label="Payables tie to the ledger" />
          <Verdict value={tb == null ? null : { clean: tb.balanced }} label="Trial balance" />
        </div>

        {/* Problems in full when there are any. A count alone tells nobody what to do next. */}
        {chain && !chain.clean && (
          <HairlineTable
            columns={[{ label: "Entry #" }, { label: "Problem" }, { label: "Detail" }]}
            rows={chain.problems.map((p) => [p.ledgerSequence, p.problem, p.detail])}
          />
        )}
        {arRec && !arRec.clean && (
          <HairlineTable
            columns={[{ label: "Receivables problem" }, { label: "Detail" }]}
            rows={arRec.problems.map((p) => [p.problem, p.detail])}
          />
        )}
        {apRec && !apRec.clean && (
          <HairlineTable
            columns={[{ label: "Payables problem" }, { label: "Detail" }]}
            rows={apRec.problems.map((p) => [p.problem, p.detail])}
          />
        )}
      </Card>

      <Card title="Can this period close?">
        {close == null ? (
          <p className="fin-muted">
            Close readiness could not be checked{current ? "" : " — there is no current period"}. That
            is not the same as ready.
          </p>
        ) : close.ready ? (
          <p>
            <StatusBadge label="approved" /> Every integrity check passes and the period carries an
            accountant sign-off.
          </p>
        ) : (
          <>
            <p>
              <StatusBadge label="blocked" /> {close.blockers.length} blocker(s) — this period cannot
              be closed yet.
            </p>
            <HairlineTable
              columns={[{ label: "Blocker" }, { label: "Detail" }]}
              rows={close.blockers.map((b) => [BLOCKER_LABEL[b.blocker] ?? b.blocker, b.detail])}
            />
          </>
        )}
      </Card>

      <Card
        title="Receivables aging"
        hint="Bucketed by DAYS OVERDUE, not invoice age — an invoice on 60-day terms raised 45 days ago is current."
      >
        {arAging.length === 0 ? (
          <p className="fin-muted">No outstanding customer invoices as at {asOf}.</p>
        ) : (
          <HairlineTable
            columns={[
              { label: "Customer" }, { label: "Current", align: "right" }, { label: "1–30", align: "right" },
              { label: "31–60", align: "right" }, { label: "61–90", align: "right" },
              { label: "90+", align: "right" }, { label: "Total", align: "right" },
            ]}
            rows={arAging.map((r) => [
              r.customerName, money(r.current), money(r.d1To30), money(r.d31To60),
              money(r.d61To90), money(r.d90Plus), money(r.totalOutstanding),
            ])}
          />
        )}
      </Card>

      <Card
        title="Payables aging"
        hint="Amounts are what each vendor is owed. Withheld tax is a separate liability to the tax office and is not included."
      >
        {apAging.length === 0 ? (
          <p className="fin-muted">No outstanding vendor bills as at {asOf}.</p>
        ) : (
          <HairlineTable
            columns={[
              { label: "Vendor" }, { label: "Current", align: "right" }, { label: "1–30", align: "right" },
              { label: "31–60", align: "right" }, { label: "61–90", align: "right" },
              { label: "90+", align: "right" }, { label: "Total", align: "right" },
            ]}
            rows={apAging.map((r) => [
              r.vendorName, money(r.current), money(r.d1To30), money(r.d31To60),
              money(r.d61To90), money(r.d90Plus), money(r.totalOutstanding),
            ])}
          />
        )}
      </Card>

      {/* Configuration lives BEHIND the console rather than in the sidebar. nav.ts renders exactly
          one Finance row on purpose (an org structure often contains a department of the same name,
          and two identical labels pointing at different screens is the kind of thing a user learns
          to distrust). Adding two more top-level rows would fight that; the console is the entry. */}
      <Card
        title="Configuration"
        hint="The cap table decides who can SEE which companies — it is an access record as much as a financial one."
      >
        <ul className="fin-links">
          <li>
            <Link href="/finance/ownership">Ownership &amp; cap table</Link>
            <span className="fin-muted"> — who holds this company, and from when</span>
          </li>
          <li>
            <Link href="/finance/settings">Accounting settings</Link>
            <span className="fin-muted"> — PKP status, NPWP and reporting currency</span>
          </li>
        </ul>
      </Card>

      <Card
        title="Fiscal periods"
        hint="A closed period is terminal — a wrong figure is corrected by an entry in an open period, never by reopening."
      >
        <HairlineTable
          columns={[
            { label: "Period" }, { label: "From" }, { label: "To" },
            { label: "State" }, { label: "Signed off" },
          ]}
          rows={periods.map((p) => [
            p.name, p.startDate, p.endDate, PERIOD_STATE_LABEL[p.state], p.signedOff ? "yes" : "—",
          ])}
        />
      </Card>
    </div>
  );
}
