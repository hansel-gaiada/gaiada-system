"use client";
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
// Type-only import — REUSES the pm module's existing burndown data shape
// rather than inventing a new one (TR-16 brief). lib/pm.ts is "server-only";
// this is a "use client" component, so only the TYPE crosses the boundary
// (erased at compile time) — same trick components/pm/Charts.tsx already
// uses. The actual BurndownPoint[]/overlay arrays are computed server-side
// (lib/pm.ts's tested burndownOverlay/aggregateBurndown) and handed in here
// as plain serializable props.
import type { BurndownPoint, BurndownOverlayPoint } from "@/lib/pm";
import { ChartDataFallback } from "./ChartDataFallback";
import { nearestIndex, pointerPct, fmtDate } from "./chartHover";
import "./charts.css";

export function Burndown({ series, overlay, title = "Burndown" }: {
  series: BurndownPoint[]; overlay: BurndownOverlayPoint[]; title?: string;
}) {
  if (series.length < 2 || overlay.length < 2) {
    return <p className="rc-kpi__foot" style={{ margin: 0 }}>Not enough history yet for a burndown.</p>;
  }
  const total = series[0].open + series[0].done;
  const xs = overlay.map((p) => p.x);
  const idealLine = overlay.map((p) => `${p.x},${100 - p.idealPct}`).join(" ");
  const actualLine = overlay.map((p) => `${p.x},${100 - p.actualPct}`).join(" ");

  const [hoverI, setHoverI] = useState<number | null>(null);
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => setHoverI(nearestIndex(xs, pointerPct(e)));
  const idealRemaining = (i: number) => Math.round((overlay[i].idealPct / 100) * total);

  return (
    <div className="rc-viz">
      <div className="rc-legend" role="list" aria-label="Series">
        <span className="rc-legend__item" role="listitem"><span className="rc-legend__swatch rc-legend__swatch--line" style={{ background: "var(--rc-text-muted)" }} aria-hidden />Ideal</span>
        <span className="rc-legend__item" role="listitem"><span className="rc-legend__swatch rc-legend__swatch--line" style={{ background: "var(--rc-series-1)" }} aria-hidden />Actual remaining</span>
      </div>
      <div className="rc-scroll">
        <div className="rc-plot">
          <svg
            className="rc-svg rc-svg--hoverable" viewBox="0 0 100 100" preserveAspectRatio="none"
            role="img" aria-label={`${title}: ideal versus actual remaining work`}
            onPointerMove={onMove} onPointerLeave={() => setHoverI(null)}
          >
            {[0, 25, 50, 75, 100].map((y) => <line key={y} className="rc-grid-line" x1={0} y1={y} x2={100} y2={y} />)}
            <polyline points={idealLine} fill="none" stroke="var(--rc-text-muted)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            <polyline points={actualLine} fill="none" stroke="var(--rc-series-1)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            {hoverI !== null && <line className="rc-crosshair" x1={xs[hoverI]} y1={0} x2={xs[hoverI]} y2={100} />}
          </svg>
          {hoverI !== null && (
            <div className="rc-tooltip" style={{ left: `${xs[hoverI]}%` }}>
              <div className="rc-tooltip__head">{fmtDate(series[hoverI].date)}</div>
              <div className="rc-tooltip__row"><span>Open</span><strong>{series[hoverI].open}</strong></div>
              <div className="rc-tooltip__row"><span>Done</span><strong>{series[hoverI].done}</strong></div>
              <div className="rc-tooltip__row"><span>Ideal remaining</span><strong>{idealRemaining(hoverI)}</strong></div>
            </div>
          )}
        </div>
      </div>
      <ChartDataFallback
        caption={`${title}, as a table`}
        columns={["Date", "Open", "Done", "Ideal remaining"]}
        rows={series.map((p, i) => [fmtDate(p.date), p.open, p.done, idealRemaining(i)])}
      />
    </div>
  );
}
