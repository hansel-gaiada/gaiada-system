import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { money, type ArAgingRow, type TrialBalance } from "@/lib/finance";
import { getArAgingResult, getProfitAndLossResult, getTrialBalanceResult } from "@/lib/finance-data";
import { todayIsoInDisplayZone } from "@/lib/format";
import { formatRate } from "@/lib/gmMoney";
import {
  arPicture, cashPosition, lastMonths, readingOfMonth, type ArPicture, type MonthReading, type MonthWindow,
} from "@/lib/financeAnalytics";
import type { ReadResult } from "@/lib/readResult";
import { Card, HairlineTable, Eyebrow, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { MonthBars } from "@/components/finance/MonthBars";

// Finance analytics: Revenue, AR and cash (DW-7b-2). Three sections, and each reads on its own.
//
// ── EACH SECTION IS ITS OWN READ, AND A REFUSAL SAYS SO IN ITS SECTION ───────────────────────────
// Every read goes through a `ReadResult` (`lib/finance-data.ts`): a 403 is "you may not see this", a 404 or a failure is "we cannot
// tell", and only a real 200 is data. A refused or failed read is drawn as exactly that, in its own section, and never as a zero or an
// empty table: "no revenue", "nothing overdue" and "no cash" are claims about the company's money. One section failing costs only that
// section. The revenue section reads one month at a time, so one failed month is one row that says so, not a hole in the chart.
//
// ── NO COMPUTED MONEY ───────────────────────────────────────────────────────────────────────────
// Revenue and net are the P&L's own total rows, the margin is net over revenue (`gmMoney`), the aging buckets and the cash balances are
// the server's rows. The only arithmetic is the presentation roll-ups in `lib/financeAnalytics.ts`.
//
// "Today" is the display zone's date (`DISPLAY_TZ`, the zone the Overview's tiles use). The aging and the trial balance are read
// without an `asOf`, which the server takes as today.
export default async function FinanceAnalyticsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>Select a company from the top bar.</EmptyNote>;

  const today = todayIsoInDisplayZone();
  const months = lastMonths(today, 12);
  const [monthly, aging, trial] = await Promise.all([
    Promise.all(months.map((m) => getProfitAndLossResult(userId, tenant, m.from, m.to))),
    getArAgingResult(userId, tenant),
    getTrialBalanceResult(userId, tenant),
  ]);

  return (
    <div className="fin-page">
      <header className="fin-page__head">
        <Eyebrow>Finance &amp; Accounting</Eyebrow>
        <h1 className="fin-page__title">Revenue, AR and cash</h1>
        <p className="fin-page__asof">
          The last 12 months, {months[0].label} to {months[months.length - 1].label} (this month to date) · receivables and cash as at today, {today}
        </p>
      </header>

      <RevenueSection months={months} readings={monthly.map(readingOfMonth)} />
      <ReceivablesSection result={aging} />
      <CashSection result={trial} today={today} />
    </div>
  );
}

/** A section's refusal, in the section: forbidden says so, a failed read says it is NOT a statement about contents. */
function Refusal({ subject, result }: { subject: string; result: { kind: "forbidden" } | { kind: "unavailable"; reason: string } }): ReactNode {
  if (result.kind === "forbidden") return <ReadRefusal subject={subject} kind="forbidden" inline />;
  return (
    <div role="alert">
      <ReadRefusal subject={subject} kind="unavailable" reason={result.reason} inline />
    </div>
  );
}

// ── Revenue by month ──────────────────────────────────────────────────────────────────────────────

function RevenueSection({ months, readings }: { months: MonthWindow[]; readings: MonthReading[] }) {
  const title = "Revenue by month";
  const hint = "The profit and loss's own revenue and net profit totals for each calendar month, and net over revenue as the margin. The current month runs to today.";
  const refused = readings.filter((r): r is Extract<MonthReading, { kind: "forbidden" | "unavailable" }> => r.kind !== "ok");
  // Nothing was readable: one refusal for the section (a refusal outranks a failure, the more precise answer).
  if (refused.length === readings.length) {
    const first = refused.find((r) => r.kind === "forbidden") ?? refused[0];
    return (
      <Card title={title} hint={hint}>
        <Refusal subject="the profit and loss" result={first} />
      </Card>
    );
  }

  const bars = months.map((m, i) => {
    const r = readings[i];
    if (r.kind !== "ok") return { label: m.label, value: null, missing: r.kind === "forbidden" ? "no access" : "could not be read" };
    if (r.revenue === null) return { label: m.label, value: null, missing: "the statement carried no totals" };
    return { label: m.label, value: r.revenue, text: money(r.revenue) };
  });

  const cell = (r: MonthReading, pick: (ok: Extract<MonthReading, { kind: "ok" }>) => ReactNode): ReactNode =>
    r.kind === "forbidden" ? "No access" : r.kind === "unavailable" ? "Unavailable" : pick(r);

  return (
    <Card title={title} hint={hint}>
      {refused.length > 0 && (
        <p className="fin-muted" role="alert">
          {refused.length} of {readings.length} months could not be read. Those rows say so; they are not months with no revenue.
        </p>
      )}
      <MonthBars bars={bars} caption={`Revenue for each of the last ${months.length} months, ${months[0].label} to ${months[months.length - 1].label}`} />
      <HairlineTable
        columns={[{ label: "Month" }, { label: "Revenue", align: "right" }, { label: "Net", align: "right" }, { label: "Margin", align: "right" }]}
        rows={months.map((m, i) => {
          const r = readings[i];
          return [
            m.partial ? `${m.label} (to date)` : m.label,
            cell(r, (o) => (o.totalsMissing ? "No totals" : o.revenue === null ? "—" : money(o.revenue))),
            cell(r, (o) => (o.net === null ? "—" : money(o.net))),
            cell(r, (o) => formatRate(o.marginRate)),
          ];
        })}
      />
    </Card>
  );
}

// ── Receivables ───────────────────────────────────────────────────────────────────────────────────

function ReceivablesSection({ result }: { result: ReadResult<ArAgingRow[]> }) {
  const link = <Link href="/finance/receivables" className="lux-btn lux-btn--ghost lux-btn--sm">Receivables →</Link>;
  const title = "Receivables";
  const hint = "Customer invoices still open as at today, bucketed by days overdue (not invoice age): an invoice inside its terms is current.";
  if (result.kind !== "ok") {
    return <Card title={title} hint={hint} headerRight={link}><Refusal subject="the receivables aging" result={result} /></Card>;
  }
  if (result.data.length === 0) {
    return (
      <Card title={title} hint={hint} headerRight={link}>
        <EmptyNote>No customer has an outstanding balance as at today. That is a real answer, not a missing one: the subledger was read and returned nothing.</EmptyNote>
      </Card>
    );
  }
  const p: ArPicture = arPicture(result.data, 5);
  if (p.unreadable) {
    return (
      <Card title={title} hint={hint} headerRight={link}>
        <div role="alert">
          <ReadRefusal subject="the receivables aging" kind="unavailable" reason="An amount in it was not a number." inline />
        </div>
      </Card>
    );
  }
  const b = p.buckets;
  return (
    <Card title={title} hint={hint} headerRight={link}>
      <div className="fin-kpis">
        <KpiTile label="Outstanding" value={money(b.total)} foot={`${p.customers} customer(s)`} />
        <KpiTile
          label="Overdue"
          value={money(p.overdue)}
          foot={p.overdueShare === null ? "Nothing outstanding" : `${formatRate(p.overdueShare)} of what is outstanding`}
        />
        <KpiTile label="90+ days" value={money(b.d90Plus)} foot="the oldest bucket" />
      </div>
      <HairlineTable
        columns={[
          { label: "Current", align: "right" }, { label: "1–30", align: "right" }, { label: "31–60", align: "right" },
          { label: "61–90", align: "right" }, { label: "90+", align: "right" }, { label: "Total", align: "right" },
        ]}
        rows={[[money(b.current), money(b.d1To30), money(b.d31To60), money(b.d61To90), money(b.d90Plus), money(b.total)]]}
      />
      {p.top.length === 0 ? (
        <p className="fin-muted">No customer is overdue.</p>
      ) : (
        <HairlineTable
          columns={[{ label: `Most overdue (top ${p.top.length})` }, { label: "Overdue", align: "right" }, { label: "Outstanding", align: "right" }]}
          rows={p.top.map((c) => [c.name, money(c.overdue), money(c.total)])}
        />
      )}
    </Card>
  );
}

// ── Cash ──────────────────────────────────────────────────────────────────────────────────────────

function CashSection({ result, today }: { result: ReadResult<TrialBalance>; today: string }) {
  const link = <Link href="/finance/treasury" className="lux-btn lux-btn--ghost lux-btn--sm">Treasury →</Link>;
  const title = "Cash and bank";
  // The honest limits, said in the section: no route returns bank balances, and the chart has no cash flag.
  const hint = "The ledger's balance for each asset account whose name says Kas, Bank or Cash, as at today. No bank-balance read exists and the chart of accounts has no cash flag, so this is the books' figure, not a bank statement, and an account named otherwise is not counted. Treasury holds loans, bonds and leases.";
  if (result.kind !== "ok") {
    return <Card title={title} hint={hint} headerRight={link}><Refusal subject="the trial balance (the ledger's account balances)" result={result} /></Card>;
  }
  if (!Array.isArray(result.data?.rows)) {
    return (
      <Card title={title} hint={hint} headerRight={link}>
        <div role="alert">
          <ReadRefusal subject="the trial balance" kind="unavailable" reason="It did not carry any account rows." inline />
        </div>
      </Card>
    );
  }
  const cash = cashPosition(result.data.rows);
  if (cash.accounts.length === 0) {
    return (
      <Card title={title} hint={hint} headerRight={link}>
        <EmptyNote>
          The ledger has no posting to an asset account named Kas, Bank or Cash as at {today}. That is a statement about the ledger and the
          account names, not a bank balance: an account with another name is not counted here.
        </EmptyNote>
      </Card>
    );
  }
  return (
    <Card title={title} hint={hint} headerRight={link}>
      <HairlineTable
        columns={[{ label: "Account" }, { label: "Balance", align: "right" }]}
        rows={[
          ...cash.accounts.map((a) => [`${a.code} · ${a.name}`, a.balance === null ? "—" : money(a.balance)]),
          [<strong key="t">Total cash and bank</strong>, cash.total === null ? "—" : <strong key="v">{money(cash.total)}</strong>],
        ]}
      />
    </Card>
  );
}
