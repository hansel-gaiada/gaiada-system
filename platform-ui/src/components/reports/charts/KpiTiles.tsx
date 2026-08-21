import "./charts.css";
import type { ReportKpi } from "@/lib/reports";
import { DeltaChip } from "./DeltaChip";
import { ChartDataFallback } from "./ChartDataFallback";

// KpiTiles takes `ReportKpi[]` directly — the document's own kpi list, no
// adapter. Every tile that carries a numerator/denominator shows it (§5.2
// anti-gaming: "every appraisal-safe rate carries its denominator" — a 100%
// on 2 tasks must read as what it is, not as a bare percentage). Every
// `pointInTime`/`distinctOver` kpi is visibly labelled (§5.4): without that a
// reader assumes any number on a 30-day report is a 30-day total, and both
// markers read as inflated totals if silently summed.
// LEAD_COUNT — how many KPIs get the big treatment. The person grain ships SEVENTEEN kpis and the
// flat `repeat(auto-fit, minmax(180px, 1fr))` grid drew every one of them at identical weight: three
// ragged rows of 28px figures, twelve of which read `0`, `0%` or `0m` on a real account. A wall of
// equally-loud zeros answers no question, so the reader has to search it. `document.kpis` order is
// authored per grain in §7, so the first few ARE the headline ones — promote those and demote the
// tail to a compact band that is still fully present, just quieter. No KPI is dropped or hidden:
// this is a weighting change, not a filter (the `ChartDataFallback` table below still lists all).
const LEAD_COUNT = 4;

// Rendered INSIDE the label span, deliberately — not as a sibling. A sibling is exactly what the
// old `appraisal-unsafe` badge was, and a second flex child in that row is what overflowed it
// (181 > 171 on six of seventeen tiles). Inline in the text, it cannot do that: it wraps with the
// words. Degree sign rather than an asterisk, which reads as a footnote marker on a FIGURE.
const APPRAISAL_MARK = '°';

export function KpiTiles({ kpis }: { kpis: ReportKpi[] }) {
  if (kpis.length === 0) return null;
  // Only split when the tail is worth demoting. At 6 or fewer the flat grid reads fine in one band,
  // and splitting would strand one or two tiles in a nearly-empty second row.
  const split = kpis.length > 6;
  const lead = split ? kpis.slice(0, LEAD_COUNT) : kpis;
  const rest = split ? kpis.slice(LEAD_COUNT) : [];
  return (
    <div className="rc-viz">
      <div className="rc-kpis rc-kpis--lead">
        {lead.map((k) => (
          <KpiTile key={k.metricKey} kpi={k} />
        ))}
      </div>
      {rest.length > 0 && (
        <div className="rc-kpis rc-kpis--rest">
          {rest.map((k) => (
            <KpiTile key={k.metricKey} kpi={k} compact />
          ))}
        </div>
      )}
      {/* ONE legend, not a badge per tile. "NOT APPRAISED" was rendering eleven times on the live
          company report — greying it (the previous pass) reduced the alarm but eleven grey boxes are
          still eleven boxes competing with eleven figures. The fact is per-tile, so the MARK stays
          per-tile; the sentence explaining it belongs once, here. */}
      {kpis.some((k) => !k.appraisalSafe) && (
        <p className="rc-kpis__legend">
          <span aria-hidden>{APPRAISAL_MARK}</span> not used in appraisal scoring
        </p>
      )}
      <ChartDataFallback
        caption="KPI values, as a table"
        columns={["Metric", "Value", "Numerator", "Denominator", "Delta", "Class"]}
        rows={kpis.map((k) => [
          k.label,
          formatValue(k),
          k.numerator ?? "",
          k.denominator ?? "",
          k.delta !== undefined ? String(k.delta) : "",
          classLabel(k),
        ])}
      />
    </div>
  );
}

function classLabel(k: ReportKpi): string {
  if (k.pointInTime) return "point-in-time";
  if (k.distinctOver) return "distinct union";
  if (k.numerator !== undefined && k.denominator !== undefined) return "ratio";
  return "additive";
}

function formatValue(k: ReportKpi): string {
  if (k.unit === "percent") return `${Math.round(k.value * 100)}%`;
  if (k.unit === "minutes") return `${Math.round(k.value)}m`;
  return k.value.toLocaleString();
}

function KpiTile({ kpi, compact = false }: { kpi: ReportKpi; compact?: boolean }) {
  const ratio = kpi.numerator !== undefined && kpi.denominator !== undefined
    ? `${kpi.numerator.toLocaleString()}/${kpi.denominator.toLocaleString()}`
    : null;
  return (
    <div className={`rc-kpi${compact ? " rc-kpi--compact" : ""}`}>
      {/* The label owns this row alone. The appraisal-unsafe marker used to sit here as a second
          flex child, and MEASURED on the live person report it overflowed the row (181px of content
          in 171px) on six of seventeen tiles — "TASKS COMPLETED", "MINUTES LOGGED", "COMMENTS
          AUTHORED" and friends each wrapped to two lines around it, which is what made the band
          look ragged. It moved to `__foot`, where every other qualifier badge already lives and
          which wraps by design. Still always rendered — §5.2 anti-gaming needs it stated — just no
          longer competing with the label for one line, and no longer in alarm red. */}
      <div className="rc-kpi__label-row">
        <span className="rc-kpi__label">
          {kpi.label}
          {!kpi.appraisalSafe && (
            <span className="rc-kpi__mark" title="Not used in appraisal scoring">{APPRAISAL_MARK}</span>
          )}
        </span>
      </div>
      <div className="rc-kpi__value">{formatValue(kpi)}</div>
      <div className="rc-kpi__foot">
        {ratio && <span className="rc-kpi__ratio">{ratio}</span>}
        {kpi.pointInTime && (
          <span className="rc-kpi__badge" title="Evaluated at the end of the range, not summed across it">as of range end</span>
        )}
        {kpi.distinctOver && (
          <span className="rc-kpi__badge" title="A distinct union across the range, not a sum of daily counts">distinct over range</span>
        )}
        {/* No `comparisonLabel` on the chip below. It resolved to the SAME string ("vs 1 Jul - 31
            Jul") on every tile — eighteen identical copies on the live company report, the most
            repeated text on the page — while the header states the compared range once already,
            beside the period. The delta FIGURE is the per-tile fact and stays; the range was
            chrome. Dropping it also removes the unbreakable ~143px run that overflowed the foot. */}
        {kpi.delta !== undefined && (
          <DeltaChip delta={kpi.delta} direction={kpi.direction} unit={kpi.unit} />
        )}
      </div>
    </div>
  );
}
