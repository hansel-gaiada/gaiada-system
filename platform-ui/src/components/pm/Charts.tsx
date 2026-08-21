"use client";
import { useCallback, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { FlowSeries, BurndownPoint, BurndownOverlayPoint, TagBreakdownRow } from "@/lib/pm";
import type { ReportDistribution } from "@/lib/reports";
import { Card, KpiTile, HairlineTable } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Donut } from "@/components/reports/charts/Donut";
import "./pm.css";

// Project Charts view (P3-06), now scope-generic (P4-A7 — reused UNCHANGED at `@all`/department
// scope, fed by `pmScope-data.ts`'s aggregates): a 3-tile KPI row + cumulative-flow / burndown /
// tag-breakdown cards. This is a CLIENT component (hover/crosshair state) so it CANNOT import the
// "server-only" lib/pm.ts at runtime — only its types (erased at compile time). Every number
// plotted here is precomputed server-side by the (server) caller with pm.ts's tested pure
// helpers (flowSeries/tagBreakdown/burndownOverlay) and handed in as serializable props — this
// component only renders. `TAG_COLOR_HEX` is a real runtime import: lib/tagColors.ts is
// deliberately NOT server-only (see its own header comment), same reason components/pm/TagChip.tsx
// imports it directly instead of going through pm.ts. `lib/reports.ts` is ALSO not server-only
// (its own header explains why: the chart kit needs it at interaction time) so importing its
// `ReportDistribution` type here — even a runtime one, not just `import type` — would be safe;
// only the type is needed, so it stays a type-only import.
//
// P4-A7: the tag donut reuses `components/reports/charts/Donut` unmodified (no new chart
// library — 4 runtime deps stays capped) rather than rebuilding one PM-local. It needs its own
// `ReportDistribution` shape, built by `tagDistribution` below.

export interface ChartsKpis { open: number; done: number; avgProgress: number }

type FigureKey = "flow" | "burndown" | "tags";
const FIGURES: { key: FigureKey; title: string }[] = [
  { key: "flow", title: "Cumulative flow" },
  { key: "burndown", title: "Burndown" },
  { key: "tags", title: "Tag breakdown" },
];

// The expand control, in each figure's own corner. Two arrows out to take the row, two arrows in
// to give it back — the same glyph read in both directions, so there is one thing to learn.
function ExpandButton({ expanded, label, onClick }: { expanded: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pm-chart__expand"
      aria-pressed={expanded}
      aria-label={expanded ? `Collapse ${label}` : `Expand ${label} to the full width`}
      title={expanded ? "Collapse" : "Expand"}
      onClick={onClick}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden focusable="false">
        {expanded ? (
          <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
            <path d="M6.5 2.5v4h-4" />
            <path d="M1.5 1.5l5 5" />
            <path d="M9.5 13.5v-4h4" />
            <path d="M14.5 14.5l-5-5" />
          </g>
        ) : (
          <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square">
            <path d="M10 1.5h4.5V6" />
            <path d="M14.5 1.5l-5 5" />
            <path d="M6 14.5H1.5V10" />
            <path d="M1.5 14.5l5-5" />
          </g>
        )}
      </svg>
    </button>
  );
}

interface ChartsProps {
  kpis: ChartsKpis;
  flow: FlowSeries;
  burndownSeries: BurndownPoint[];
  burndownOverlay: BurndownOverlayPoint[];
  tagRows: TagBreakdownRow[];
  /** The tag bars' denominator — every task in scope, tagged or not. Defaults to open + done,
   *  which IS the whole set by construction; reverse-engineering it out of a rounded percentage
   *  is how a figure ends up off by one. */
  taskTotal?: number;
}

const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

// P5-C1 — which x labels to print. Every tick would collide at a third of the page width, and
// shrinking the type instead is how a chart ends up with a 4px axis. The two ENDS are always
// printed: they are the two a reader needs to place the series in time at all.
function pickTicks(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const span = n - 1;
  // A stride that DIVIDES the span puts every label the same distance apart and still lands on the
  // last day. Rounding evenly-spaced fractions instead gave gaps of 2-1-2-1-2 — a date axis whose
  // own ticks look mis-measured.
  for (let s = 2; s <= span; s++) {
    if (span % s === 0 && span / s + 1 <= max) {
      return Array.from({ length: span / s + 1 }, (_, k) => k * s);
    }
  }
  // No divisor fits (a prime span, say): fall back to a uniform stride and keep the last day,
  // dropping the tick before it if the stride would crowd it.
  const stride = Math.ceil(span / (max - 1));
  const out: number[] = [];
  for (let i = 0; i < span; i += stride) out.push(i);
  if (out[out.length - 1] > span - stride / 2) out.pop();
  out.push(span);
  return out;
}

// Five labels against the five gridlines the plots already draw at 0/25/50/75/100.
function yTicks(maxY: number): number[] {
  return [1, 0.75, 0.5, 0.25, 0].map((f) => Math.round(maxY * f));
}

// The axis furniture, in HTML around the plot. The plot SVG is `preserveAspectRatio="none"` —
// correct for the shape, fatal for text — so no label may live inside it.
function Axes({ yMax, dates, wide, children }: {
  yMax: number; dates: string[]; wide: boolean; children: React.ReactNode;
}) {
  // 4, not 3, in a third-width card: the stride has to DIVIDE the span to stay evenly spaced, and
  // a span of 9 days has no divisor that yields 3 labels — it falls straight to the two ends.
  const ticks = pickTicks(dates.length, wide ? 7 : 4);
  return (
    <div className="pm-chart__frame">
      {/* No unit label on the axis: the line above the legend already names it ("8 tasks · 07 Jul
          – 16 Jul"), and squeezing the word in here either ate the top tick or landed on the
          legend. One statement of the unit, in the place that reads as a sentence. */}
      <div className="pm-chart__yaxis" aria-hidden>
        {yTicks(yMax).map((v, i) => <span key={i}>{v}</span>)}
      </div>
      {children}
      <div className="pm-chart__xaxis" aria-hidden>
        {ticks.map((i) => <span key={i}>{fmtDate(dates[i])}</span>)}
      </div>
    </div>
  );
}

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

export function Charts({ kpis, flow, burndownSeries, burndownOverlay, tagRows, taskTotal = kpis.open + kpis.done }: ChartsProps) {
  // P5-C1 — three figures across, and any ONE of them can take the full row. The control sits in
  // that figure's own corner rather than as a mode switch above all three: what a reader wants is
  // "show me THIS one properly", and a global switch makes them say it in two steps.
  // URL-driven (`?chart=flow`) rather than component state, the same bookmarkable convention the
  // Gantt's zoom and window controls use — the link you send is the view you were looking at.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The page OPENS with the first figure at full width rather than with three thirds. Three
  // narrow charts is a contact sheet — it tells you what is here, not what any of it says — and a
  // reader arriving at "Charts" is almost always here to read one. `?chart=none` is the explicit
  // "collapse everything" state, because an absent param has to mean the default, and without a
  // spelling for "none" the opened figure could never be closed.
  const raw = searchParams.get("chart");
  const expanded: FigureKey | null =
    raw === "none" ? null
    : FIGURES.some((f) => f.key === raw) ? (raw as FigureKey)
    : FIGURES[0].key;
  const setExpanded = useCallback((next: FigureKey | null) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    // The default needs no parameter — a shared link should not carry state nobody chose.
    if (next === FIGURES[0].key) params.delete("chart");
    else params.set("chart", next ?? "none");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  return (
    <div className="pm-charts">
      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <KpiTile label="Open" value={String(kpis.open)} hint="Tasks whose status this project does not mark as done. Counts every task in the project, ignoring any tag filter above." />
        <KpiTile label="Done" value={String(kpis.done)} />
        <KpiTile label="Avg progress" value={`${kpis.avgProgress}%`} hint="A flat mean of each task's own progress percentage — every task counts equally, whatever its size or estimate. Done tasks are included, so this rises as work closes." />
      </div>

      <div className={`pm-charts__grid${expanded ? " pm-charts__grid--focused" : ""}`}>
        {FIGURES.map((f) => {
          const open = expanded === f.key;
          return (
            <div key={f.key} className={`pm-charts__cell${open ? " pm-charts__cell--expanded" : ""}`}>
              <Card
                title={f.title}
                headerRight={
                  <ExpandButton
                    expanded={open}
                    label={f.title}
                    onClick={() => setExpanded(open ? null : f.key)}
                  />
                }
              >
                {f.key === "flow" && <CumulativeFlowChart flow={flow} wide={open} />}
                {f.key === "burndown" && <BurndownChart series={burndownSeries} overlay={burndownOverlay} wide={open} />}
                {f.key === "tags" && <TagBreakdownSection rows={tagRows} wide={open} taskTotal={taskTotal} />}
              </Card>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- cumulative flow diagram ----
function CumulativeFlowChart({ flow, wide }: { flow: FlowSeries; wide: boolean }) {
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
  // The pattern is referenced by id, so two flow charts on one page would otherwise share one.
  const hatchId = "pm-flow-hatch";
  const blockedColor = bands.find((b) => b.isBlocked)?.color ?? null;

  return (
    <div className="pm-chart">
      <p className="pm-chart__denom">{maxY} task{maxY === 1 ? "" : "s"} · {fmtDate(dates[0])} – {fmtDate(dates[n - 1])}</p>
      {bands.length >= 2 && (
        <div className="pm-chart__legend">
          {bands.map((b) => (
            <span key={b.statusId} className="pm-chart__legend-item">
              <span
                className="pm-chart__swatch"
                style={b.isBlocked
                  ? { background: `repeating-linear-gradient(45deg, ${b.color} 0 3px, var(--surface-card) 3px 5px)` }
                  : { background: b.color }}
                aria-hidden
              />
              {b.label}
            </span>
          ))}
        </div>
      )}
      <Axes yMax={maxY} dates={dates} wide={wide}>
      <div className="pm-chart__plot">
        <svg
          className="pm-chart__svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
          aria-label="Cumulative flow diagram: task count by status over time"
          onPointerMove={onMove} onPointerLeave={() => setHoverI(null)}
        >
          {[0, 25, 50, 75, 100].map((y) => <line key={y} className="pm-chart__grid" x1={0} y1={y} x2={100} y2={y} />)}
          {/* P5-C1 — Blocked is hatched. With the status ladder kept as it is (owner decision; the
              measurements are in tokens/pm.css), a SHAPE is the only distinction on this chart that
              survives both the sub-3:1 contrast and the colour-blind case, so this is not
              decoration. Same hatch the Gantt uses for blocked bars. It rides at the same 25%
              opacity as every other band — the hatch is meant to be read, not to shout over the
              four bands beside it. */}
          <defs>
            <pattern id={hatchId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)" patternContentUnits="userSpaceOnUse">
              <rect width={6} height={6} fill={blockedColor ?? "transparent"} />
              <line x1={0} y1={0} x2={0} y2={6} stroke="var(--surface-card)" strokeWidth={2} />
            </pattern>
          </defs>
          {bands.map((b, i) => (
            <path
              key={`fill-${b.statusId}`}
              d={areaPath(i)}
              fill={b.isBlocked ? `url(#${hatchId})` : b.color}
              fillOpacity={0.25}
            />
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
      </Axes>
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
function BurndownChart({ series, overlay, wide }: { series: BurndownPoint[]; overlay: BurndownOverlayPoint[]; wide: boolean }) {
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
      <p className="pm-chart__denom">{total} task{total === 1 ? "" : "s"} · {fmtDate(series[0].date)} – {fmtDate(series[series.length - 1].date)}</p>
      <div className="pm-chart__legend">
        <span className="pm-chart__legend-item">
          <span className="pm-chart__swatch pm-chart__swatch--line" style={{ background: "var(--erp-accent)" }} aria-hidden />
          Actual remaining <strong style={{ marginLeft: 4 }}>{series[series.length - 1].open}</strong>
        </span>
        {/* P5-C1 — the ideal line is DASHED. Two 2px lines separated only by hue is the one
            distinction a greyscale print, a projector, or a colour-blind reader cannot make; and a
            plan reads as a dashed line while the record reads as a solid one. */}
        <span className="pm-chart__legend-item">
          <span className="pm-chart__swatch pm-chart__swatch--line pm-chart__swatch--dashed" aria-hidden />
          Ideal
        </span>
      </div>
      <Axes yMax={total} dates={series.map((p) => p.date)} wide={wide}>
      <div className="pm-chart__plot">
        <svg
          className="pm-chart__svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img"
          aria-label="Burndown chart: ideal versus actual remaining work"
          onPointerMove={onMove} onPointerLeave={() => setHoverI(null)}
        >
          {[0, 25, 50, 75, 100].map((y) => <line key={y} className="pm-chart__grid" x1={0} y1={y} x2={100} y2={y} />)}
          <polyline points={idealLine} fill="none" stroke="var(--erp-ink-50)" strokeWidth={2} strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <polyline points={actualLine} fill="none" stroke="var(--erp-accent)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
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
      </Axes>
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

// ---- tag breakdown: donut (P4-A7) + the existing ranked bars, side by side ----
//
// `tagDistribution` deliberately DROPS the trailing "Untagged" row before handing rows to the
// donut. `tagBreakdown` (lib/pm.ts) builds a tag CLOUD, not a partition — a task with two tags
// counts once toward EACH, so `TagBreakdownRow.pct` is "share of ALL tasks carrying this tag" and
// can sum past 100% across rows. A donut's slices are angles that must sum to 360°, so feeding it
// raw counts (including Untagged) would silently answer a DIFFERENT question — "share of
// taggings" rather than "share of tasks" — while looking like the same percentage as the ranked
// bars next to it. Excluding Untagged keeps the donut honestly about "of the tags actually
// applied, how are they distributed", which is what a tag-distribution donut is for; the ranked
// bars keep answering "what share of tasks carry this tag" (Untagged included) exactly as before.
// Zero tags used anywhere -> `slices: []` -> `Donut` renders its own built-in empty state.
export function tagDistribution(rows: TagBreakdownRow[]): ReportDistribution {
  const tagged = rows.filter((r) => r.tagId !== null);
  return {
    key: "pm-tag-distribution",
    label: "Tags",
    kind: "donut",
    slices: tagged.map((r) => ({
      label: r.label,
      value: r.count,
      ref: { kind: "tag" as const, id: r.tagId! },
    })),
  };
}

// P5-C1 — the colour a tag gets in the BARS, matched to the slice the donut gives the same tag.
//
// The two figures used to draw the same three tags from two unrelated sources: the bars took each
// tag's own registry colour (TAG_COLOR_HEX, the one a person picked for the chip), the donut
// coloured by RANK from the reporting series ramp. Frontend came out navy in one and blue in the
// other, 300px apart, which breaks the one rule a paired figure has — colour follows the entity.
//
// The donut is the constrained half (`ReportDistribution.slices` carries no colour, and that
// contract is mirrored by platform-nest, so it is not the thing to widen for this), so the bars
// follow it. This mirrors `components/reports/charts/Donut`'s own assignment exactly: sort by
// value descending, take the first six from `--rc-series-1..6`, fold the rest into the muted
// "Other" step. If that component's ramp or cap ever changes, this has to change with it.
const TAG_SERIES = [
  "var(--rc-series-1)", "var(--rc-series-2)", "var(--rc-series-3)",
  "var(--rc-series-4)", "var(--rc-series-5)", "var(--rc-series-6)",
];
const TAG_OTHER = "var(--rc-text-muted)";
export function tagHues(rows: TagBreakdownRow[]): Map<string, string> {
  const tagged = rows.filter((r) => r.tagId !== null);
  const sorted = [...tagged].sort((a, b) => b.count - a.count);
  const out = new Map<string, string>();
  sorted.forEach((r, i) => out.set(r.tagId!, i < TAG_SERIES.length ? TAG_SERIES[i] : TAG_OTHER));
  return out;
}

function TagBreakdownSection({ rows, wide, taskTotal }: { rows: TagBreakdownRow[]; wide: boolean; taskTotal: number }) {
  if (rows.length === 0) {
    return <EmptyNote>No tasks yet — the tag breakdown needs at least one task.</EmptyNote>;
  }
  const hues = tagHues(rows);
  const tagged = rows.filter((r) => r.tagId !== null).reduce((n, r) => n + r.count, 0);
  return (
    <div style={{ display: "grid", gap: 20, gridTemplateColumns: wide ? "minmax(190px, 240px) minmax(0, 1fr)" : "minmax(0, 1fr)", alignItems: "start" }}>
      {/* Each figure states its own denominator, because they genuinely differ — see
          `tagDistribution` above. Today the page prints "Frontend · 67%" beside "Frontend 4 · 50%"
          and leaves the reader to guess; the reason was written down only in this file. */}
      <div>
        <p className="pm-chart__denom">Share of the {tagged} tag{tagged === 1 ? "" : "s"} applied</p>
        <Donut distribution={tagDistribution(rows)} title="Tag distribution" />
      </div>
      <div>
        <p className="pm-chart__denom">Share of the {taskTotal} task{taskTotal === 1 ? "" : "s"}</p>
        <TagBreakdownChart rows={rows} hues={hues} />
      </div>
    </div>
  );
}

function TagBreakdownChart({ rows, hues }: { rows: TagBreakdownRow[]; hues: Map<string, string> }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="pm-chart">
      <div className="pm-tagbars">
        {rows.map((r) => {
          const hue = r.tagId ? hues.get(r.tagId) : null;
          const style: CSSProperties = hue
            ? ({ "--pm-tagbar-hue": hue, width: `${(r.count / max) * 100}%` } as CSSProperties)
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
