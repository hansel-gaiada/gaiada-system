import { ChartDataFallback } from "./ChartDataFallback";
import "./charts.css";

// Appraisal: a subject marker on a role-cohort distribution strip (§5.2's
// anti-gaming design — "cohort banding, not absolute scores"). NOTE on the
// prop shape: §6.1's ReportDocument has no cohort-distribution type — the
// appraisal pack is a separate data model owned by TR-24 (auto_inputs/band
// engine), not yet specified. `CohortBandDatum` below is a minimal,
// provisional shape (percentile + 1-5 band per §5.2's small-cohort-guard
// rule) for TR-24/TR-26 to confirm against the real appraisal contract when
// it lands — this is a genuine open point for the architect, not a §6.1 field.
export interface CohortBandDatum {
  metricLabel: string;
  unit: "count" | "minutes" | "percent" | "score";
  subjectValue: number;
  subjectPercentile: number; // 0-100, within the same role cohort + cycle
  band: 1 | 2 | 3 | 4 | 5 | null; // null when the cohort has <5 members (§5.2 small-cohort guard — no band, raw metric only)
  cohortSize: number;
}

const BAND_COLOR: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "var(--rc-critical)", 2: "var(--rc-serious)", 3: "var(--rc-warning)", 4: "var(--rc-good)", 5: "var(--rc-good)",
};

function fmtVal(v: number, unit: CohortBandDatum["unit"]): string {
  if (unit === "percent") return `${Math.round(v * 100)}%`;
  if (unit === "minutes") return `${Math.round(v)}m`;
  return v.toLocaleString();
}

export function CohortBand({ data, subjectLabel = "You" }: { data: CohortBandDatum; subjectLabel?: string }) {
  const noBand = data.band === null;
  return (
    <div className="rc-viz">
      <div className="rc-kpi__foot" style={{ margin: 0 }}>
        <strong>{data.metricLabel}</strong>: {fmtVal(data.subjectValue, data.unit)}
        {noBand ? (
          <span className="rc-kpi__badge" title="Fewer than 5 people in this role cohort — no band shown (§5.2 small-cohort guard)">cohort too small for a band</span>
        ) : (
          <span className="rc-kpi__badge" style={{ color: BAND_COLOR[data.band as 1 | 2 | 3 | 4 | 5], borderColor: BAND_COLOR[data.band as 1 | 2 | 3 | 4 | 5] }}>
            Band {data.band} of 5
          </span>
        )}
      </div>
      <div className="rc-cohort">
        <div className="rc-cohort__track" role="img" aria-label={`${data.metricLabel}: this person sits at the ${data.subjectPercentile}th percentile of ${data.cohortSize} peers in the same role cohort`}>
          {!noBand && (
            <div
              className="rc-cohort__marker"
              style={{ left: `${Math.min(98, Math.max(2, data.subjectPercentile))}%`, background: BAND_COLOR[data.band as 1 | 2 | 3 | 4 | 5] }}
            >
              <span className="rc-cohort__marker-label" style={{ left: 0 }}>{subjectLabel}</span>
            </div>
          )}
        </div>
        <div className="rc-cohort__ticks" aria-hidden>
          <span>P0</span><span>P25</span><span>P50</span><span>P75</span><span>P100</span>
        </div>
      </div>
      <ChartDataFallback
        caption={`${data.metricLabel} cohort position, as a table`}
        columns={["Metric", "Value", "Percentile", "Band", "Cohort size"]}
        rows={[[data.metricLabel, fmtVal(data.subjectValue, data.unit), `P${data.subjectPercentile}`, noBand ? "n/a (cohort < 5)" : `${data.band} of 5`, data.cohortSize]]}
      />
    </div>
  );
}
