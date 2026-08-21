"use client";
import { useState } from "react";
import type { ReportDistribution } from "@/lib/reports";
import { ChartDataFallback } from "./ChartDataFallback";
import "./charts.css";
import { formatNumber } from "@/lib/format";

const SERIES_COLORS = [
  "var(--rc-series-1)", "var(--rc-series-2)", "var(--rc-series-3)", "var(--rc-series-4)",
  "var(--rc-series-5)", "var(--rc-series-6)",
];
const OTHER_COLOR = "var(--rc-text-muted)";
const MAX_SLICES = 6; // dataviz: donut caps at ≤6 slices + "other" (categorical all-pairs
// series ladder for a form where every slice can sit next to every other one).

const R = 40;
const STROKE = 16;
const CIRCUMFERENCE = 2 * Math.PI * R;
const GAP_DEG = 1.5; // angular surface-gap between adjacent slices (a ring has no
// linear axis to spend a literal 2px on — this is the donut-specific analog of the
// mark spec's surface-gap spacer: a small rotational gap, not a border).

// Part-to-whole, ≤6 slices + a trailing "Other" fold for anything past the cap —
// takes a `ReportDistribution` directly (kind:"donut"). Never colors more than 6
// real categorical slots (anti-patterns.md: "cycling/generating hues past 8" —
// here the harder categorical-all-pairs ceiling of 3 doesn't strictly apply
// since slices don't need to be told apart pairwise the way scatter marks do,
// but 6 is already the kit's donut-specific legibility cap independent of that).
export function Donut({ distribution, title }: { distribution: ReportDistribution; title?: string }) {
  const label = title ?? distribution.label;
  if (distribution.slices.length === 0) {
    return <p className="rc-kpi__foot" style={{ margin: 0 }}>No data yet for {label.toLowerCase()}.</p>;
  }
  const sorted = [...distribution.slices].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, MAX_SLICES - 1);
  const tail = sorted.slice(MAX_SLICES - 1);
  const slices = tail.length > 0
    ? [...head, { label: "Other", value: tail.reduce((s, x) => s + x.value, 0) }]
    : sorted;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;

  let cumulativeDeg = 0;
  const arcs = slices.map((s, i) => {
    const frac = s.value / total;
    const deg = frac * 360;
    const startDeg = cumulativeDeg;
    cumulativeDeg += deg;
    const dash = Math.max(0, (deg - GAP_DEG) / 360) * CIRCUMFERENCE;
    return { ...s, i, startDeg, dash, color: i === slices.length - 1 && tail.length > 0 ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length], pct: Math.round(frac * 100) };
  });

  const [hoverI, setHoverI] = useState<number | null>(null);

  return (
    <div className="rc-viz">
      <div className="rc-legend" role="list" aria-label="Slices">
        {arcs.map((a) => (
          <span key={a.label} className="rc-legend__item" role="listitem">
            <span className="rc-legend__swatch" style={{ background: a.color }} aria-hidden />
            {a.label} · {a.pct}%
          </span>
        ))}
      </div>
      <div className="rc-plot rc-plot--short" style={{ display: "flex", justifyContent: "center" }}>
        <svg
          className="rc-svg" viewBox="0 0 100 100" style={{ width: 180, height: 140 }}
          role="img" aria-label={`${label}: ${arcs.map((a) => `${a.label} ${a.pct}%`).join(", ")}`}
        >
          <g transform="translate(50,50) rotate(-90)">
            {arcs.map((a) => (
              <circle
                key={a.label}
                r={R} cx={0} cy={0} fill="none"
                stroke={a.color}
                strokeWidth={hoverI === a.i ? STROKE + 3 : STROKE}
                strokeDasharray={`${a.dash} ${CIRCUMFERENCE - a.dash}`}
                strokeDashoffset={-(a.startDeg / 360) * CIRCUMFERENCE}
                transform="rotate(0)"
                style={{ cursor: "pointer", transition: "stroke-width 0.1s var(--erp-ease, ease)" }}
                onMouseEnter={() => setHoverI(a.i)}
                onMouseLeave={() => setHoverI(null)}
                onFocus={() => setHoverI(a.i)}
                onBlur={() => setHoverI(null)}
                tabIndex={0}
                aria-label={`${a.label}: ${formatNumber(a.value)} (${a.pct}%)`}
              />
            ))}
          </g>
          <text x={50} y={47} textAnchor="middle" className="rc-donut__center-label">Total</text>
          <text x={50} y={60} textAnchor="middle" className="rc-donut__center-value">{formatNumber(total)}</text>
        </svg>
      </div>
      {hoverI !== null && (
        <div className="rc-kpi__foot" role="status">
          <strong>{arcs[hoverI].label}</strong>: {formatNumber(arcs[hoverI].value)} ({arcs[hoverI].pct}%)
        </div>
      )}
      <ChartDataFallback
        caption={`${label}, as a table`}
        columns={["Slice", "Value", "Share"]}
        rows={arcs.map((a) => [a.label, a.value, `${a.pct}%`])}
      />
    </div>
  );
}
