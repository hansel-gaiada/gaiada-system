"use client";
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
// Type-only import — REUSES the pm module's existing CFD data shape (see the
// same rationale in Burndown.tsx). FlowSeries is built server-side by
// lib/pm.ts's tested flowSeries()/aggregateFlow() and handed in as props.
import type { FlowSeries } from "@/lib/pm";
import { ChartDataFallback } from "./ChartDataFallback";
import { nearestIndex, pointerPct, fmtDate } from "./chartHover";
import "./charts.css";

export function CumulativeFlow({ flow, title = "Cumulative flow" }: { flow: FlowSeries; title?: string }) {
  const { dates, bands, counts, stacked } = flow;
  if (dates.length < 2 || bands.length === 0) {
    return <p className="rc-kpi__foot" style={{ margin: 0 }}>Not enough history yet — the flow chart needs at least two days of data.</p>;
  }
  const n = dates.length;
  const maxY = Math.max(1, ...stacked[stacked.length - 1]);
  const xAt = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 0);
  const yAt = (v: number) => 100 - (v / maxY) * 100;
  const xs = dates.map((_, i) => xAt(i));

  const areaPath = (i: number): string => {
    const top = stacked[i];
    const bottom = i === 0 ? dates.map(() => 0) : stacked[i - 1];
    const topPts = top.map((v, di) => `${xAt(di)},${yAt(v)}`).join(" L ");
    const bottomPts = bottom.map((v, di) => `${xAt(di)},${yAt(v)}`).reverse().join(" L ");
    return `M ${topPts} L ${bottomPts} Z`;
  };
  const topLine = (i: number): string => stacked[i].map((v, di) => `${xAt(di)},${yAt(v)}`).join(" ");

  const [hoverI, setHoverI] = useState<number | null>(null);
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => setHoverI(nearestIndex(xs, pointerPct(e)));

  return (
    <div className="rc-viz">
      {bands.length >= 2 && (
        <div className="rc-legend" role="list" aria-label="Series">
          {bands.map((b) => (
            <span key={b.statusId} className="rc-legend__item" role="listitem">
              <span className="rc-legend__swatch" style={{ background: b.color }} aria-hidden />
              {b.label}
            </span>
          ))}
        </div>
      )}
      <div className="rc-scroll">
        <div className="rc-plot">
          <svg
            className="rc-svg rc-svg--hoverable" viewBox="0 0 100 100" preserveAspectRatio="none"
            role="img" aria-label={`${title}: task count by status over time`}
            onPointerMove={onMove} onPointerLeave={() => setHoverI(null)}
          >
            {[0, 25, 50, 75, 100].map((y) => <line key={y} className="rc-grid-line" x1={0} y1={y} x2={100} y2={y} />)}
            {bands.map((b, i) => <path key={`fill-${b.statusId}`} d={areaPath(i)} fill={b.color} fillOpacity={0.25} />)}
            {/* a surface-color backer stroke drawn first is the 2px gap-spacer between
                adjacent bands (marks-and-anatomy.md: negative space, never a border). */}
            {bands.map((b, i) => (
              <g key={`line-${b.statusId}`}>
                <polyline points={topLine(i)} fill="none" stroke="var(--rc-surface)" strokeWidth={5} vectorEffect="non-scaling-stroke" />
                <polyline points={topLine(i)} fill="none" stroke={b.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </g>
            ))}
            {hoverI !== null && <line className="rc-crosshair" x1={xs[hoverI]} y1={0} x2={xs[hoverI]} y2={100} />}
          </svg>
          {hoverI !== null && (
            <div className="rc-tooltip" style={{ left: `${xs[hoverI]}%` }}>
              <div className="rc-tooltip__head">{fmtDate(dates[hoverI])}</div>
              {bands.map((b, i) => (
                <div key={b.statusId} className="rc-tooltip__row">
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <span className="rc-tooltip__key" style={{ background: b.color }} aria-hidden />
                    {b.label}
                  </span>
                  <strong>{counts[i][hoverI]}</strong>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <ChartDataFallback
        caption={`${title}, as a table`}
        columns={["Date", ...bands.map((b) => b.label)]}
        rows={dates.map((d, di) => [fmtDate(d), ...bands.map((_, i) => counts[i][di])])}
      />
    </div>
  );
}
