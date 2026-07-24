"use client";
import { useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { FlowSeries, BurndownPoint, BurndownOverlayPoint, TagBreakdownRow } from "@/lib/pm";
import { TAG_COLOR_HEX } from "@/lib/tagColors";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import "./pm.css";

// Project Charts view (P3-06): a 3-tile KPI row + cumulative-flow / burndown / tag-breakdown
// cards. This is a CLIENT component (hover/crosshair state) so it CANNOT import the
// "server-only" lib/pm.ts at runtime — only its types (erased at compile time). Every number
// plotted here is precomputed server-side by the (server) caller with pm.ts's tested pure
// helpers (flowSeries/tagBreakdown/burndownOverlay) and handed in as serializable props — this
// component only renders. `TAG_COLOR_HEX` is a real runtime import: lib/tagColors.ts is
// deliberately NOT server-only (see its own header comment), same reason components/pm/TagChip.tsx
// imports it directly instead of going through pm.ts.

export interface ChartsKpis { open: number; done: number; avgProgress: number }

interface ChartsProps {
  kpis: ChartsKpis;
  flow: FlowSeries;
  burndownSeries: BurndownPoint[];
  burndownOverlay: BurndownOverlayPoint[];
  tagRows: TagBreakdownRow[];
}

const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

// Nearest x-position among a set of candidate x's (0-100 viewBox units) to a pointer's x pct —
// robust to any spacing (flow's days are evenly spaced by construction; burndown's needn't be).
function nearestIndex(xs: number[], pct: number): number {
  let best = 0;
  let bestDist = Infinity;
  xs.forEach((x, i) => {
    const d = Math.abs(x - pct);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

function pointerPct(e: ReactPointerEvent<SVGSVGElement>): number {
  const rect = e.currentTarget.getBoundingClientRect();
  return ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
}

export function Charts({ kpis, flow, burndownSeries, burndownOverlay, tagRows }: ChartsProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <KpiTile label="Open" value={String(kpis.open)} />
        <KpiTile label="Done" value={String(kpis.done)} />
        <KpiTile label="Avg progress" value={`${kpis.avgProgress}%`} />
      </div>
      <Card title="Cumulative flow"><CumulativeFlowChart flow={flow} /></Card>
      <Card title="Burndown"><BurndownChart series={burndownSeries} overlay={burndownOverlay} /></Card>
      <Card title="Tag breakdown"><TagBreakdownChart rows={tagRows} /></Card>
    </div>
  );
}

// ---- cumulative flow diagram ----
function CumulativeFlowChart({ flow }: { flow: FlowSeries }) {
  const { dates, bands, counts, stacked } = flow;
  if (dates.length < 2 || bands.length === 0) {
    return <EmptyNote>Not enough history yet — the flow chart needs at least two days of data.</EmptyNote>;
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
    <div className="pm-chart">
      {bands.length >= 2 && (
        <div className="pm-chart__legend">
          {bands.map((b) => (
            <span key={b.statusId} className="pm-chart__legend-item">
              <span className="pm-chart__swatch" style={{ background: b.color }} aria-hidden />
              {b.label}
            </span>
          ))}
        </div>
      )}
      <div className="pm-chart__plot">
        <svg
          className="pm-chart__svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
          aria-label="Cumulative flow diagram: task count by status over time"
          onPointerMove={onMove} onPointerLeave={() => setHoverI(null)}
        >
          {[0, 25, 50, 75, 100].map((y) => <line key={y} className="pm-chart__grid" x1={0} y1={y} x2={100} y2={y} />)}
          {bands.map((b, i) => (
            <path key={`fill-${b.statusId}`} d={areaPath(i)} fill={b.color} fillOpacity={0.25} />
          ))}
          {/* Each band's own top line, full hex — a surface-color backer stroke drawn first acts
              as the 2px gap-spacer between adjacent bands (the mechanism dataviz calls for is
              negative space, not a border; see marks-and-anatomy.md), the hex line rides on top. */}
          {bands.map((b, i) => (
            <g key={`line-${b.statusId}`}>
              <polyline points={topLine(i)} fill="none" stroke="var(--surface-card)" strokeWidth={5} vectorEffect="non-scaling-stroke" />
              <polyline points={topLine(i)} fill="none" stroke={b.color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          {hoverI !== null && (
            <line className="pm-chart__crosshair" x1={xs[hoverI]} y1={0} x2={xs[hoverI]} y2={100} />
          )}
        </svg>
        {hoverI !== null && (
          <div className="pm-chart__tooltip" style={{ left: `${xs[hoverI]}%` }}>
            <div className="pm-chart__tooltip-date">{fmtDate(dates[hoverI])}</div>
            {bands.map((b, i) => (
              <div key={b.statusId} className="pm-chart__tooltip-row">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="pm-chart__tooltip-key" style={{ background: b.color }} aria-hidden />
                  {b.label}
                </span>
                <strong>{counts[i][hoverI]}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
      <details className="pm-chart__data">
        <summary>Data</summary>
        <HairlineTable
          columns={[{ label: "Date" }, ...bands.map((b) => ({ label: b.label }))]}
          rows={dates.map((d, di) => [fmtDate(d), ...bands.map((_, i) => String(counts[i][di]))])}
          tcols={`1fr ${bands.map(() => "1fr").join(" ")}`}
        />
      </details>
    </div>
  );
}

// ---- burndown ----
function BurndownChart({ series, overlay }: { series: BurndownPoint[]; overlay: BurndownOverlayPoint[] }) {
  if (series.length < 2 || overlay.length < 2) {
    return <EmptyNote>Not enough history yet for a burndown.</EmptyNote>;
  }
  const total = series[0].open + series[0].done;
  const xs = overlay.map((p) => p.x);
  const idealLine = overlay.map((p) => `${p.x},${100 - p.idealPct}`).join(" ");
  const actualLine = overlay.map((p) => `${p.x},${100 - p.actualPct}`).join(" ");

  const [hoverI, setHoverI] = useState<number | null>(null);
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => setHoverI(nearestIndex(xs, pointerPct(e)));
  const idealRemaining = (i: number) => Math.round((overlay[i].idealPct / 100) * total);

  return (
    <div className="pm-chart">
      <div className="pm-chart__legend">
        <span className="pm-chart__legend-item"><span className="pm-chart__swatch pm-chart__swatch--line" style={{ background: "var(--erp-ink-50)" }} aria-hidden />Ideal</span>
        <span className="pm-chart__legend-item"><span className="pm-chart__swatch pm-chart__swatch--line" style={{ background: "var(--erp-accent)" }} aria-hidden />Actual remaining</span>
      </div>
      <div className="pm-chart__plot">
        <svg
          className="pm-chart__svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
          aria-label="Burndown chart: ideal versus actual remaining work"
          onPointerMove={onMove} onPointerLeave={() => setHoverI(null)}
        >
          {[0, 25, 50, 75, 100].map((y) => <line key={y} className="pm-chart__grid" x1={0} y1={y} x2={100} y2={y} />)}
          <polyline points={idealLine} fill="none" stroke="var(--erp-ink-50)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <polyline points={actualLine} fill="none" stroke="var(--erp-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {hoverI !== null && (
            <line className="pm-chart__crosshair" x1={xs[hoverI]} y1={0} x2={xs[hoverI]} y2={100} />
          )}
        </svg>
        {hoverI !== null && (
          <div className="pm-chart__tooltip" style={{ left: `${xs[hoverI]}%` }}>
            <div className="pm-chart__tooltip-date">{fmtDate(series[hoverI].date)}</div>
            <div className="pm-chart__tooltip-row"><span>Open</span><strong>{series[hoverI].open}</strong></div>
            <div className="pm-chart__tooltip-row"><span>Done</span><strong>{series[hoverI].done}</strong></div>
            <div className="pm-chart__tooltip-row"><span>Ideal remaining</span><strong>{idealRemaining(hoverI)}</strong></div>
          </div>
        )}
      </div>
      <details className="pm-chart__data">
        <summary>Data</summary>
        <HairlineTable
          columns={[{ label: "Date" }, { label: "Open" }, { label: "Done" }, { label: "Ideal remaining" }]}
          rows={series.map((p, i) => [fmtDate(p.date), String(p.open), String(p.done), String(idealRemaining(i))])}
          tcols="1fr 1fr 1fr 1.2fr"
        />
      </details>
    </div>
  );
}

// ---- tag breakdown — ranked horizontal bars (not a donut), square 0-radius ends ----
function TagBreakdownChart({ rows }: { rows: TagBreakdownRow[] }) {
  if (rows.length === 0) {
    return <EmptyNote>No tasks yet — the tag breakdown needs at least one task.</EmptyNote>;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="pm-chart">
      <div className="pm-tagbars">
        {rows.map((r) => {
          const hex = r.color ? TAG_COLOR_HEX[r.color] : null;
          const style: CSSProperties = hex
            ? ({ "--pm-tagbar-onlight": hex.onLight, "--pm-tagbar-ondark": hex.onDark, width: `${(r.count / max) * 100}%` } as CSSProperties)
            : { width: `${(r.count / max) * 100}%` };
          return (
            <div className="pm-tagbar" key={r.tagId ?? "untagged"}>
              <span className="pm-tagbar__label">{r.label}</span>
              <div className="pm-tagbar__track">
                <div className={`pm-tagbar__fill${r.color ? "" : " pm-tagbar__fill--untagged"}`} style={style} />
              </div>
              <span className="pm-tagbar__val">{r.count} · {r.pct}%</span>
            </div>
          );
        })}
      </div>
      <details className="pm-chart__data">
        <summary>Data</summary>
        <HairlineTable
          columns={[{ label: "Tag" }, { label: "Count", align: "right" }, { label: "Share", align: "right" }]}
          rows={rows.map((r) => [r.label, String(r.count), `${r.pct}%`])}
          tcols="2fr 1fr 1fr"
        />
      </details>
    </div>
  );
}
