"use client";
import { useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { ReportSeries } from "@/lib/reports";
import { bucketSeriesWithParts, type BucketedSeriesDetailed } from "@/lib/reports";
import { ChartDataFallback } from "./ChartDataFallback";
import { nearestIndex, pointerPct, fmtDate } from "./chartHover";
import "./charts.css";
import { formatNumber } from "@/lib/format";

const SERIES_COLORS = [
  "var(--rc-series-1)", "var(--rc-series-2)", "var(--rc-series-3)", "var(--rc-series-4)",
  "var(--rc-series-5)", "var(--rc-series-6)", "var(--rc-series-7)", "var(--rc-series-8)",
];

// Line/area trend chart(s) sharing one date axis. Consumes `ReportSeries[]`
// directly (§7's "no adapter layer") plus `dayCount` (from `header.dayCount`)
// to pick the x-axis bucket granularity (§7 amendment) — never re-fetches,
// never re-derives the underlying numbers, only regroups what's already in
// the document's props (see lib/reports.ts's bucketing comment for the full
// rationale). Honest null gaps: a bucket with no real data anywhere breaks
// the line rather than interpolating across it or faking a zero — this is
// what makes an "ends in future" trailing gap read correctly without the
// chart lying about a flat drop to 0.
export function TrendLine({
  series, dayCount, title, unit = "count", pointInTimeKeys = [],
}: {
  series: ReportSeries[];
  dayCount: number;
  title: string;
  unit?: ReportSeries["unit"];
  // series keys that are point-in-time (§5.4 #20 e.g. overdue_open) and must
  // bucket via their bucket's LAST value, never a sum — see lib/reports.ts.
  pointInTimeKeys?: string[];
}) {
  const bucketed: BucketedSeriesDetailed[] = series.map((s) =>
    bucketSeriesWithParts(s, series, dayCount, { lastNotSum: pointInTimeKeys.includes(s.key) }),
  );
  const n = Math.max(0, ...bucketed.map((b) => b.points.length));
  if (n < 2) {
    return (
      <div className="rc-viz">
        <p className="rc-kpi__foot" style={{ margin: 0 }}>Not enough history yet for {title.toLowerCase()}.</p>
      </div>
    );
  }

  const allValues = bucketed.flatMap((b) => b.points.map((p) => p.v)).filter((v): v is number => v !== null);
  const maxY = Math.max(1, ...allValues, 0);
  const minY = Math.min(0, ...allValues);
  const range = maxY - minY || 1;
  const xAt = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 0);
  const yAt = (v: number) => 100 - ((v - minY) / range) * 100;
  const xs = Array.from({ length: n }, (_, i) => xAt(i));

  // Break the path at null runs — never draw a segment across missing data.
  const pathFor = (b: BucketedSeriesDetailed): string => {
    let d = "";
    let drawing = false;
    b.points.forEach((p, i) => {
      if (p.v === null) { drawing = false; return; }
      const cmd = drawing ? "L" : "M";
      d += `${cmd}${xAt(i).toFixed(2)} ${yAt(p.v).toFixed(2)} `;
      drawing = true;
    });
    return d.trim();
  };
  const areaFor = (b: BucketedSeriesDetailed): string => {
    // Area fill only across contiguous non-null runs.
    const segs: string[] = [];
    let seg: { x: number; y: number }[] = [];
    const flush = () => {
      if (seg.length >= 2) {
        const top = seg.map((p) => `${p.x},${p.y}`).join(" L ");
        const bottom = [...seg].reverse().map((p) => `${p.x},${yAt(0)}`).join(" L ");
        segs.push(`M ${top} L ${bottom} Z`);
      }
      seg = [];
    };
    b.points.forEach((p, i) => {
      if (p.v === null) { flush(); return; }
      seg.push({ x: xAt(i), y: yAt(p.v) });
    });
    flush();
    return segs.join(" ");
  };

  const [hoverI, setHoverI] = useState<number | null>(null);
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => setHoverI(nearestIndex(xs, pointerPct(e)));

  const lastRealIndex = (b: BucketedSeriesDetailed): number | null => {
    for (let i = b.points.length - 1; i >= 0; i--) if (b.points[i].v !== null) return i;
    return null;
  };

  const ariaLabel = `${title}: ${bucketed.map((b) => b.label).join(", ")} over time, ${bucketed[0]?.granularity ?? "day"}ly buckets`;

  return (
    <div className="rc-viz">
      {bucketed.length >= 2 && (
        <div className="rc-legend" role="list" aria-label="Series">
          {bucketed.map((b, i) => (
            <span key={b.key} className="rc-legend__item" role="listitem">
              <span className="rc-legend__swatch rc-legend__swatch--line" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden />
              {b.label}
            </span>
          ))}
        </div>
      )}
      <div className="rc-scroll">
        <div className="rc-plot" style={{ minWidth: 480 }}>
          <svg
            className="rc-svg rc-svg--hoverable" viewBox="0 0 100 100" preserveAspectRatio="none"
            role="img" aria-label={ariaLabel}
            onPointerMove={onMove} onPointerLeave={() => setHoverI(null)}
          >
            {[0, 25, 50, 75, 100].map((y) => <line key={y} className="rc-grid-line" x1={0} y1={y} x2={100} y2={y} />)}
            {bucketed.map((b, i) => {
              const color = SERIES_COLORS[i % SERIES_COLORS.length];
              return (
                <g key={b.key}>
                  {b.kind === "area" && <path d={areaFor(b)} fill={color} fillOpacity={0.1} stroke="none" />}
                  <path d={pathFor(b)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                  {(() => {
                    const li = lastRealIndex(b);
                    if (li === null) return null;
                    return (
                      <circle cx={xAt(li)} cy={yAt(b.points[li].v as number)} r={2.4} fill={color} stroke="var(--rc-surface)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                    );
                  })()}
                </g>
              );
            })}
            {hoverI !== null && <line className="rc-crosshair" x1={xs[hoverI]} y1={0} x2={xs[hoverI]} y2={100} />}
          </svg>
          {hoverI !== null && (
            <div className="rc-tooltip" style={{ left: `${xs[hoverI]}%` }}>
              <div className="rc-tooltip__head">{fmtDate(bucketed[0].points[hoverI]?.t ?? "")}</div>
              {bucketed.map((b, i) => {
                const p = b.points[hoverI];
                const hasRatio = p?.numerator !== undefined && p?.denominator !== undefined;
                return (
                  <div key={b.key} className="rc-tooltip__row">
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span className="rc-tooltip__key" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} aria-hidden />
                      {b.label}
                    </span>
                    <strong>
                      {p?.v === null || p?.v === undefined ? "—" : formatVal(p.v, unit)}
                      {hasRatio && p.numerator !== null && p.denominator !== null && ` (${p.numerator}/${p.denominator})`}
                    </strong>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <ChartDataFallback
        caption={`${title}, as a table`}
        columns={["Date", ...bucketed.map((b) => b.label)]}
        rows={bucketed[0].points.map((p, i) => [
          fmtDate(p.t),
          ...bucketed.map((b) => (b.points[i]?.v === null || b.points[i]?.v === undefined ? "—" : formatVal(b.points[i].v as number, unit))),
        ])}
      />
    </div>
  );
}

function formatVal(v: number, unit: ReportSeries["unit"]): string {
  if (unit === "percent") return `${Math.round(v * 100)}%`;
  if (unit === "minutes") return `${Math.round(v)}m`;
  return formatNumber(v);
}
