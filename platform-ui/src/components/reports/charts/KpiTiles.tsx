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
export function KpiTiles({ kpis, comparisonLabel }: { kpis: ReportKpi[]; comparisonLabel?: string | null }) {
  if (kpis.length === 0) return null;
  return (
    <div className="rc-viz">
      <div className="rc-kpis">
        {kpis.map((k) => (
          <KpiTile key={k.metricKey} kpi={k} comparisonLabel={comparisonLabel} />
        ))}
      </div>
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

function KpiTile({ kpi, comparisonLabel }: { kpi: ReportKpi; comparisonLabel?: string | null }) {
  const ratio = kpi.numerator !== undefined && kpi.denominator !== undefined
    ? `${kpi.numerator.toLocaleString()}/${kpi.denominator.toLocaleString()}`
    : null;
  return (
    <div className="rc-kpi">
      <div className="rc-kpi__label-row">
        <span className="rc-kpi__label">{kpi.label}</span>
        {!kpi.appraisalSafe && (
          <span className="rc-kpi__badge rc-kpi__badge--unsafe" title="Not used in appraisal scoring">appraisal-unsafe</span>
        )}
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
        {kpi.delta !== undefined && (
          <DeltaChip delta={kpi.delta} direction={kpi.direction} unit={kpi.unit} comparisonLabel={comparisonLabel} />
        )}
      </div>
    </div>
  );
}
