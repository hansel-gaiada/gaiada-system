import Link from "next/link";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import type { ReadResult } from "@/lib/readResult";
import {
  buildGridRows, formatAttainment, formatMoney, minorToMajor, yearTotals,
  type ActualCell, type RevenuePlanRead,
} from "@/lib/revenuePlan";
import { RevenuePlanEditor } from "./RevenuePlanEditor";
import "./revenuePlan.css";

/** What the actual column says for one month: the figure, or in words why there is none. */
function actualText(cell: ActualCell, currency: string, unit: number): string {
  switch (cell.kind) {
    case "value": return formatMoney(cell.major, currency, unit);
    case "future": return "Not yet";
    case "none": return "Not reported";
    case "forbidden": return "No access";
    case "unavailable": return "Could not be read";
  }
}

/**
 * The Revenue plan tab of the Office of the GM (BFF §40.6.4): twelve months of one year, each month's plan beside the revenue the
 * books show for it (the P&L's total revenue) and the revenue as a share of the plan. Presentational: the page decides who may see
 * it and reads the data; `canEdit` only decides whether the Set / Edit buttons are offered (the server still decides who may write).
 *
 * Honest by construction: a refused or failed plan read says so instead of showing an empty grid; a month with no plan reads "No plan"
 * and has no ratio (never 100%); a month whose revenue could not be read says so (never 0); a future month has no revenue yet.
 */
export function RevenuePlanView({
  year, deptId, plan, actuals, canEdit,
}: {
  year: number;
  deptId: string;
  plan: ReadResult<RevenuePlanRead>;
  /** By `YYYY-MM`; a month with no entry has not started. */
  actuals: Record<string, ReadResult<number | null>>;
  canEdit: boolean;
}) {
  const base = `/departments/${encodeURIComponent(deptId)}/revenue-plan`;
  const years = [year - 1, year, year + 1];
  const nav = (
    <nav className="rp-years" aria-label="Year">
      {years.map((y) => (
        <Link key={y} href={`${base}?year=${y}`} aria-current={y === year ? "true" : undefined} className="lux-btn lux-btn--ghost lux-btn--sm">{y}</Link>
      ))}
    </nav>
  );
  const title = `Revenue plan ${year}`;

  if (plan.kind !== "ok") {
    return (
      <Card title={title} headerRight={nav}>
        <ReadRefusal subject="the revenue plan" kind={plan.kind} reason={plan.kind === "unavailable" ? plan.reason : undefined} inline />
      </Card>
    );
  }
  const { currency, minorUnit } = plan.data;
  if (currency === null || minorUnit === null) {
    return (
      <Card title={title} headerRight={nav}>
        <EmptyNote>This company has no finance settings yet, so it has no base currency to plan in. Set them up in Finance first.</EmptyNote>
      </Card>
    );
  }

  const rows = buildGridRows(year, plan.data, actuals);
  const totals = yearTotals(rows, minorUnit);
  return (
    <Card title={title} headerRight={nav}>
      <table className="rp-table">
        <caption className="rp-sr">Revenue plan and actual revenue for each month of {year}, in {currency}</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col" className="rp-num">Plan</th>
            <th scope="col" className="rp-num">Actual revenue</th>
            <th scope="col" className="rp-num">Actual ÷ plan</th>
            {canEdit && <th scope="col"><span className="rp-sr">Edit</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month}>
              <th scope="row">{r.label}{r.note ? <span className="rp-muted"> · {r.note}</span> : null}</th>
              <td className="rp-num">
                {r.amountMinor === null ? <span className="rp-muted">No plan</span> : formatMoney(minorToMajor(r.amountMinor, minorUnit), currency, minorUnit)}
              </td>
              <td className={`rp-num${r.actual.kind === "forbidden" || r.actual.kind === "unavailable" ? " rp-bad" : r.actual.kind === "value" ? "" : " rp-muted"}`}
                title={r.actual.kind === "unavailable" ? r.actual.reason : undefined}>
                {actualText(r.actual, currency, minorUnit)}
              </td>
              <td className="rp-num">{formatAttainment(r.attainment)}</td>
              {canEdit && (
                <td>
                  <RevenuePlanEditor month={r.month} label={r.label} currency={currency} minorUnit={minorUnit} amountMinor={r.amountMinor} note={r.note} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Year</th>
            <td className="rp-num">{totals.plannedMonths === 0 ? <span className="rp-muted">No plan</span> : formatMoney(totals.planMajor, currency, minorUnit)}</td>
            <td className="rp-num">{totals.readMonths === 0 ? <span className="rp-muted">—</span> : formatMoney(totals.actualMajor, currency, minorUnit)}</td>
            <td />
            {canEdit && <td />}
          </tr>
        </tfoot>
      </table>
      <p className="rp-note">
        Amounts are in {currency}, the company&apos;s base currency. Actual revenue is the books&apos; total revenue for the month, from the
        profit and loss; the current month counts revenue so far, and a month that has not started has none yet. A month with no plan shows no
        ratio, and the &ldquo;Revenue against plan&rdquo; KPI reads &ldquo;no data&rdquo; for any period that includes one.
        The year row adds the {totals.plannedMonths} of 12 months that have a plan and the {totals.readMonths} months whose revenue was read.
      </p>
      {!canEdit && <p className="rp-note">Only a company administrator can set or clear the plan; you can read it.</p>}
    </Card>
  );
}
