import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import {
  listPeriods, getTrialBalance, getBalanceSheet, getProfitAndLoss,
  money, fiscalYearStart,
} from "@/lib/finance";
import { Card, HairlineTable, StatusBadge, Eyebrow } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

// The three statements a bank, an auditor and a director all ask for.
//
// ── EACH ONE STATES WHETHER IT BALANCES, AND THAT IS NOT DECORATION ────────────────────────────
// A trial balance whose debits do not equal its credits, or a balance sheet where A ≠ L + E, is not
// a report with a small problem — it is not a report at all. The badge is the first thing rendered
// for that reason, above the figures rather than beneath them.
//
// ── THE P&L IS A WINDOW; THE BALANCE SHEET IS AN INSTANT ───────────────────────────────────────
// The two are not variations on one report and the API refuses to pretend otherwise: the P&L needs
// BOTH bounds (it is flow) and the balance sheet needs `fyStart` (it is stock, plus the year's
// profit so far so it balances before year-end close). Getting `fyStart` wrong renders a wrong
// sheet that still balances, which is why it is derived from the CALENDAR here and never defaulted
// to 1 January.
export default async function FinanceReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; from?: string }>;
}) {
  const sp = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const periods = await listPeriods(userId, tenant);
  if (periods == null) {
    return <EmptyNote>You do not have finance access for this company.</EmptyNote>;
  }
  if (periods.length === 0) {
    return <EmptyNote>This company has no fiscal calendar yet, so there is nothing to report on.</EmptyNote>;
  }

  const today = new Date().toISOString().slice(0, 10);
  const current = periods.find((p) => p.startDate <= today && p.endDate >= today);
  const asOf = sp.asOf ?? current?.endDate ?? periods[periods.length - 1].endDate;
  const fyStart = fiscalYearStart(periods, asOf);
  const from = sp.from ?? fyStart ?? periods[0].startDate;

  const [tb, bs, pl] = await Promise.all([
    getTrialBalance(userId, tenant, asOf),
    fyStart ? getBalanceSheet(userId, tenant, asOf, fyStart) : Promise.resolve(null),
    getProfitAndLoss(userId, tenant, from, asOf),
  ]);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Reports</h1>
        <p className="fin-page__asof">
          Balance sheet and trial balance as at <strong>{asOf}</strong>; profit and loss for{" "}
          <strong>{from}</strong> to <strong>{asOf}</strong>.
        </p>
      </header>

      <Card
        title="Trial balance"
        hint="Every posted line, summed by account. Debits equal credits for any window, because no journal is excluded — reversals included, which net to zero."
      >
        {tb == null ? (
          <p className="fin-muted">
            Could not be produced. That is not the same as balanced — nothing has been checked.
          </p>
        ) : (
          <>
            <p>
              <StatusBadge label={tb.balanced ? "active" : "blocked"} />{" "}
              {tb.balanced ? "Debits equal credits." : "OUT OF BALANCE — this is not a usable report."}
            </p>
            {tb.rows.length === 0 ? (
              <p className="fin-muted">No postings as at {asOf}.</p>
            ) : (
              <HairlineTable
                columns={[
                  { label: "Code" }, { label: "Account" },
                  { label: "Debit", align: "right" }, { label: "Credit", align: "right" },
                ]}
                rows={[
                  ...tb.rows.map((r) => [r.code, r.name, money(r.debit), money(r.credit)]),
                  ["", "Total", money(tb.totalDebit), money(tb.totalCredit)],
                ]}
              />
            )}
          </>
        )}
      </Card>

      <Card
        title="Profit and loss"
        hint="A window, not a moment — which is why it needs both a start and an end."
      >
        {pl.length === 0 ? (
          <p className="fin-muted">No revenue or expense in this window.</p>
        ) : (
          <HairlineTable
            columns={[{ label: "Section" }, { label: "Code" }, { label: "Account" }, { label: "Amount", align: "right" }]}
            rows={pl.map((r) => [
              r.section === "total" ? "" : r.section,
              r.code.startsWith("TOTAL") || r.code === "NET_PROFIT" ? "" : r.code,
              r.name,
              money(r.amount),
            ])}
          />
        )}
      </Card>

      <Card
        title="Balance sheet"
        hint="Equity includes the year’s profit so far, which is what makes A = L + E hold before the year-end close moves it to retained earnings."
      >
        {bs == null ? (
          <p className="fin-muted">
            {fyStart
              ? "Could not be produced — nothing has been checked."
              : "Needs a fiscal year start, which could not be derived from this calendar."}
          </p>
        ) : (
          <>
            <p>
              <StatusBadge label={bs.balanced ? "active" : "blocked"} />{" "}
              {bs.balanced
                ? "Assets equal liabilities plus equity."
                : "DOES NOT BALANCE — the figures below cannot be relied on."}
            </p>
            <HairlineTable
              columns={[{ label: "" }, { label: "Amount", align: "right" }]}
              rows={[
                ["Assets", money(bs.assets)],
                ["Liabilities", money(bs.liabilities)],
                ["Equity", money(bs.equity)],
              ]}
            />
          </>
        )}
      </Card>
    </div>
  );
}
