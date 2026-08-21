"use client";
import { useState } from "react";
import { normalizeBars, type BarsInput } from "./barData";
import { ChartDataFallback } from "./ChartDataFallback";
import "./charts.css";
import { formatNumber } from "@/lib/format";

const SERIES_COLORS = [
  "var(--rc-series-1)", "var(--rc-series-2)", "var(--rc-series-3)", "var(--rc-series-4)",
  "var(--rc-series-5)", "var(--rc-series-6)", "var(--rc-series-7)", "var(--rc-series-8)",
];
// Percentage height on a flex item is unreliable across browsers even with a
// definite-height flex container (a well-known flexbox gotcha) — compute the
// bar's height in real pixels against this fixed plot height instead.
const PLOT_HEIGHT = 200;

function fmtVal(v: number | null, unit: string): string {
  if (v === null) return "—";
  if (unit === "percent") return `${Math.round(v * 100)}%`;
  if (unit === "minutes") return `${Math.round(v)}m`;
  return formatNumber(v);
}

// Grouped columns, side by side within each category (day/week/month bucket
// OR a plain category axis — see barData.ts). Takes `ReportSeries[]`
// (+ `dayCount`) for a time axis, or `ReportDistribution[]` for a category
// axis, directly — no transform step the caller has to write. CSS-div bars
// (not SVG rects) so the 4px-rounded/square-baseline mark spec and the 2px
// surface-gap spacer are just real border-radius + flex gap, matching the
// existing div-bar precedent (components/pm/Charts.tsx's TagBreakdownChart).
export function GroupedBars({ title, unit: unitOverride, ...input }: BarsInput & { title: string; unit?: string }) {
  const data = normalizeBars(input);
  const unit = unitOverride ?? data.unit;
  if (data.groups.length === 0) {
    return <p className="rc-kpi__foot" style={{ margin: 0 }}>No data yet for {title.toLowerCase()}.</p>;
  }
  const max = Math.max(1, ...data.groups.flatMap((g) => g.values.filter((v): v is number => v !== null)));
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
          role="img" aria-label={`${title}: grouped bar chart by ${data.seriesLabels.join(", ")}`}
          style={{ display: "flex", gap: 14, alignItems: "flex-end", height: PLOT_HEIGHT, minWidth: Math.max(320, data.groups.length * 44), position: "relative", borderBottom: "1px solid var(--rc-axis)" }}
        >
          {data.groups.map((g, gi) => (
            <div key={g.categoryKey} role="group" aria-label={g.categoryLabel} style={{ display: "flex", gap: 2, alignItems: "flex-end", flex: "0 0 auto" }}>
              {g.values.map((v, si) => {
                const pct = v === null ? 0 : (v / max) * 100;
                const isHover = hover?.g === gi && hover?.s === si;
                return (
                  <button
                    key={data.seriesKeys[si]}
                    type="button"
                    className={`rc-hit${isHover ? " rc-mark--lift" : ""}`}
                    style={{
                      width: 16, height: Math.max((pct / 100) * PLOT_HEIGHT, v === null ? 0 : 2),
                      background: v === null ? "transparent" : SERIES_COLORS[si % SERIES_COLORS.length],
                      border: 0, borderRadius: "4px 4px 0 0", cursor: v === null ? "default" : "pointer", padding: 0,
                    }}
                    aria-label={`${g.categoryLabel}, ${data.seriesLabels[si]}: ${fmtVal(v, unit)}`}
                    onMouseEnter={() => setHover({ g: gi, s: si })}
                    onFocus={() => setHover({ g: gi, s: si })}
                    onMouseLeave={() => setHover(null)}
                    onBlur={() => setHover(null)}
                    disabled={v === null}
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
          ))}
        </div>
        <div style={{ display: "flex", gap: 14, minWidth: Math.max(320, data.groups.length * 44) }}>
          {data.groups.map((g, i) => (
            <span key={g.categoryKey} className="rc-bar-group__cat-label" style={{ flex: "0 0 auto", width: 16 + (data.seriesLabels.length - 1) * 2, textAlign: "center", visibility: i % thinEvery === 0 ? "visible" : "hidden" }}>
              {g.categoryLabel}
            </span>
          ))}
        </div>
      </div>
      <ChartDataFallback
        caption={`${title}, as a table`}
        columns={["Category", ...data.seriesLabels]}
        rows={data.groups.map((g) => [g.categoryLabel, ...g.values.map((v) => fmtVal(v, unit))])}
      />
    </div>
  );
}
