"use client";
import { useState } from "react";
import {
  cellConditionText, cellTargetText, cellsInMonthOrder, conditionTone, formatKpiValue, monthColumnLabel, monthsWithValue,
  trendSeriesOf, type DeptKpiMonthsKpi, type DeptKpiMonthsView,
} from "@/lib/deptKpiFormat";
import { TrendLine } from "@/components/reports/charts/TrendLine";
import "./deptKpis.css";

// DW-10b-2 (BFF §58.4): the department's KPIs by month. One row per KPI, one column per month, oldest first; the current month is marked "so far".
// Each cell says three things in words: the value in the KPI's unit, the target in force that month under it (or "no target"), and the condition as a
// WORD beside a dot, so colour never carries the meaning alone. An `unavailable` cell says why in the page's own reason words. The table is a real
// <table> (caption, column and row headers) and scrolls sideways INSIDE its own container at phone width, never the page.
//
// Under it each KPI can open a trend line (the values, with the target as a step line) from the same cells. It is the kit's TrendLine, so it brings its own
// data table for screen readers; a KPI with fewer than two months of values says so instead of drawing one point.

// The trend's x axis is months, so it is always bucketed as months (TrendLine buckets by the day count it is given; anything over 182 days is monthly).
const MONTHLY_DAY_COUNT = 365;
const monthLabel = (iso: string) => monthColumnLabel(iso.slice(0, 7));

function KpiTrend({ kpi, view }: { kpi: DeptKpiMonthsKpi; view: DeptKpiMonthsView }) {
  const withValue = monthsWithValue(kpi);
  if (withValue < 2) {
    return <p className="dk-months__note">There are not enough months with a value to draw a trend for {kpi.label}.</p>;
  }
  const { values, target } = trendSeriesOf(kpi, view.months);
  const hasTarget = target.points.some((p) => p.v !== null);
  const partialLast = view.months.length > 0 && view.months[view.months.length - 1].partial;
  return (
    <div className="dk-months__trend">
      <TrendLine
        series={hasTarget ? [values, target] : [values]}
        dayCount={MONTHLY_DAY_COUNT}
        title={`${kpi.label} by month`}
        unit={kpi.unit}
        stepKeys={["target"]}
        formatDate={monthLabel}
      />
      <p className="dk-months__note">
        {hasTarget ? "The step line is the target in force each month. " : "No month has a target yet, so there is no target line. "}
        A gap is a month with no value, never a zero.{partialLast ? " The latest month is month to date." : ""}
      </p>
    </div>
  );
}

export function MonthsView({ view }: { view: DeptKpiMonthsView }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (view.months.length === 0 || view.kpis.length === 0) {
    return <p className="dk-months__note">This department has no KPIs or no months to show yet.</p>;
  }
  const first = view.months[0];
  const last = view.months[view.months.length - 1];

  return (
    <div className="dk-months">
      <div className="dk-months__scroll" tabIndex={0} role="region" aria-label="KPIs by month, scrolls sideways">
        <table className="dk-months__table">
          <caption>
            {view.unit.name}: each KPI by month, {monthColumnLabel(first.month)} to {monthColumnLabel(last.month)}, oldest first. Under each value:
            the target in force that month, then the condition.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="dk-months__kpi">KPI</th>
              {view.months.map((m) => (
                <th key={m.month} scope="col">
                  {monthColumnLabel(m.month)}
                  {m.partial && <span className="dk-months__sofar"> so far</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.kpis.map((k) => {
              const cells = cellsInMonthOrder(k, view.months);
              return (
                <tr key={k.key}>
                  <th scope="row" className="dk-months__kpi">{k.label}</th>
                  {cells.map((c, i) => {
                    const m = view.months[i];
                    if (!c) {
                      return (
                        <td key={m.month} className="dk-cell dk-cell--idle">
                          <span className="dk-cell__value">{formatKpiValue(null, k.unit)}</span>
                          <span className="dk-cell__cond dk-badge--idle"><span className="dk-dot dk-dot--idle" aria-hidden="true" />Unavailable</span>
                        </td>
                      );
                    }
                    const tone = conditionTone(c.condition);
                    return (
                      <td key={m.month} className={`dk-cell dk-cell--${tone}`}>
                        <span className="dk-cell__value">{formatKpiValue(c.value, k.unit)}</span>
                        <span className="dk-cell__target">{cellTargetText(c, k.unit)}</span>
                        <span className={`dk-cell__cond dk-badge--${tone}`}>
                          <span className={`dk-dot dk-dot--${tone}`} aria-hidden="true" />
                          {cellConditionText(c)}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="dk-months__trends" aria-label="Trend lines">
        {view.kpis.map((k) => {
          const isOpen = open.has(k.key);
          const panel = `dk-trend-${k.key}`;
          return (
            <li key={k.key} className="dk-months__trendrow">
              <span className="dk-months__trendname">{k.label}</span>
              <button
                type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-expanded={isOpen} aria-controls={panel}
                aria-label={`${isOpen ? "Hide" : "Show"} the trend for ${k.label}`} onClick={() => toggle(k.key)}
              >
                {isOpen ? "Hide trend" : "Show trend"}
              </button>
              <div id={panel} className="dk-months__panel" hidden={!isOpen}>
                {isOpen && <KpiTrend kpi={k} view={view} />}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
