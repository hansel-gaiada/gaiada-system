"use client";
import { useState } from "react";
import { normalizeBars, type BarsInput } from "./barData";
import { ChartDataFallback } from "./ChartDataFallback";
import "./charts.css";

const SERIES_COLORS = [
  "var(--rc-series-1)", "var(--rc-series-2)", "var(--rc-series-3)", "var(--rc-series-4)",
  "var(--rc-series-5)", "var(--rc-series-6)", "var(--rc-series-7)", "var(--rc-series-8)",
];
// Percentage height on a flex item is unreliable across browsers even with a
// definite-height flex container (a well-known flexbox gotcha) — compute
// every segment's height in real pixels against this fixed plot height instead.
const PLOT_HEIGHT = 200;

function fmtVal(v: number | null, unit: string): string {
  if (v === null) return "—";
  if (unit === "percent") return `${Math.round(v * 100)}%`;
  if (unit === "minutes") return `${Math.round(v)}m`;
  return v.toLocaleString();
}

// One column per category, segments stacked bottom-up (part-to-whole over
// time or over category — evidence-by-source per day, served-companies
// split, workload-by-person). Same `ReportSeries[]+dayCount` /
// `ReportDistribution[]` input as GroupedBars (barData.ts normalizes both).
// Segments are separated by a 2px surface-color gap (flex `gap`, not a
// border — marks-and-anatomy.md: "never draw a border around a mark to
// separate it"); only the TOPMOST segment of the whole stack gets the
// rounded data-end, every other boundary is square.
export function StackedBars({ title, unit: unitOverride, ...input }: BarsInput & { title: string; unit?: string }) {
  const data = normalizeBars(input);
  const unit = unitOverride ?? data.unit;
  if (data.groups.length === 0) {
    return <p className="rc-kpi__foot" style={{ margin: 0 }}>No data yet for {title.toLowerCase()}.</p>;
  }
  const totals = data.groups.map((g) => g.values.reduce<number>((sum, v) => sum + (v ?? 0), 0));
  const max = Math.max(1, ...totals);
  const [hover, setHover] = useState<{ g: number; s: number } | null>(null);
  const thinEvery = data.groups.length > 16 ? Math.ceil(data.groups.length / 12) : 1;

  return (
    <div className="rc-viz">
      {data.seriesLabels.length >= 2 && (
        <div className="rc-legend" role="list" aria-label="Series">
          {data.seriesLabels.map((label, i) => (
            <span key={data.seriesKeys[i]} className="rc-legend__item" role="listitem">
              <span className="rc-legend__swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden />
              {label}
            </span>
          ))}
        </div>
      )}
      <div className="rc-scroll">
        <div
          role="img" aria-label={`${title}: stacked bar chart by ${data.seriesLabels.join(", ")}`}
          style={{ display: "flex", gap: 14, alignItems: "flex-end", height: PLOT_HEIGHT, minWidth: Math.max(320, data.groups.length * 30), borderBottom: "1px solid var(--rc-axis)" }}
        >
          {data.groups.map((g, gi) => {
            const lastRealSeg = g.values.reduce((last, v, i) => (v !== null && v > 0 ? i : last), -1);
            const columnHeight = (totals[gi] / max) * PLOT_HEIGHT;
            return (
              <div key={g.categoryKey} style={{ position: "relative", display: "flex", flexDirection: "column-reverse", gap: 2, height: Math.max(columnHeight, 2), flex: "0 0 auto", width: 20 }}>
                {g.values.map((v, si) => {
                  if (v === null || v === 0) return null;
                  const segHeight = totals[gi] > 0 ? (v / totals[gi]) * columnHeight : 0;
                  const isTop = si === lastRealSeg;
                  const isHover = hover?.g === gi && hover?.s === si;
                  return (
                    <button
                      key={data.seriesKeys[si]}
                      type="button"
                      className={`rc-hit${isHover ? " rc-mark--lift" : ""}`}
                      style={{
                        width: "100%", height: Math.max(segHeight, 2),
                        background: SERIES_COLORS[si % SERIES_COLORS.length],
                        border: 0, borderRadius: isTop ? "4px 4px 0 0" : 0, padding: 0, cursor: "pointer",
                      }}
                      aria-label={`${g.categoryLabel}, ${data.seriesLabels[si]}: ${fmtVal(v, unit)}`}
                      onMouseEnter={() => setHover({ g: gi, s: si })}
                      onFocus={() => setHover({ g: gi, s: si })}
                      onMouseLeave={() => setHover(null)}
                      onBlur={() => setHover(null)}
                    />
                  );
                })}
                {hover?.g === gi && (
                  <div className="rc-tooltip" style={{ position: "absolute", bottom: "100%", left: 0, transform: "none" }}>
                    <div className="rc-tooltip__head">{g.categoryLabel}</div>
                    <div className="rc-tooltip__row">
                      <span>{data.seriesLabels[hover.s]}</span>
                      <strong>{fmtVal(g.values[hover.s], unit)}</strong>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 14, minWidth: Math.max(320, data.groups.length * 30) }}>
          {data.groups.map((g, i) => (
            <span key={g.categoryKey} className="rc-bar-group__cat-label" style={{ flex: "0 0 auto", width: 20, textAlign: "center", visibility: i % thinEvery === 0 ? "visible" : "hidden" }}>
              {g.categoryLabel}
            </span>
          ))}
        </div>
      </div>
      <ChartDataFallback
        caption={`${title}, as a table`}
        columns={["Category", ...data.seriesLabels, "Total"]}
        rows={data.groups.map((g, i) => [g.categoryLabel, ...g.values.map((v) => fmtVal(v, unit)), fmtVal(totals[i], unit)])}
      />
    </div>
  );
}
