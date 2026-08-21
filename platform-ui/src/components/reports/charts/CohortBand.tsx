import { formatCohortValue, type CohortBandDatum } from "@/lib/appraisals";
import { ChartDataFallback } from "./ChartDataFallback";
import "./charts.css";
import { formatNumber } from "@/lib/format";

// Appraisal: a subject marker on a role-cohort distribution strip (§5.2's anti-gaming design —
// "cohort banding, not absolute scores").
//
// TR-26 ADAPTATION NOTE (per the ticket brief — "adapt to TR-24's real contract if they differ, and
// say what you changed"): TR-16 shipped this component against a provisional, locally-declared
// `CohortBandDatum` (a minimal percentile+band shape). appraisal-document.ts (TR-24) confirmed and
// refined that shape into the program's real contract — this component now imports THAT type from
// `lib/appraisals.ts` (the FE mirror of appraisal-document.ts) instead of declaring its own. Three
// concrete deltas from the placeholder:
//   1. `subjectPercentile` is now OPTIONAL, omitted whenever `band` is null — the placeholder typed
//      it as a required `number`, which would have forced a fake percentile into a suppressed
//      small-cohort datum. This component never reads `subjectPercentile` when `band` is null.
//   2. `numerator`/`denominator` are new — §5.2 point 2 ("every appraisal-safe rate carries its
//      denominator") applies REGARDLESS of whether a band exists, so this component renders the
//      ratio whenever both are present, band or no band (ethical requirement 2 of this ticket).
//   3. `informationalOnly` is new (the two `axis:"discipline"` safe metrics — appraisal-safe,
//      banded, but not folded into any weighted axis/score) — rendered as a distinct badge so a
//      reader never mistakes a discipline metric for one of the four scored axes.
export function CohortBand({ data, subjectLabel = "You" }: { data: CohortBandDatum; subjectLabel?: string }) {
  const noBand = data.band === null;
  const ratio = data.numerator !== undefined && data.denominator !== undefined
    ? `${formatNumber(data.numerator)}/${formatNumber(data.denominator)}`
    : null;
  return (
    <div className="rc-viz">
      <div className="rc-kpi__foot" style={{ margin: 0, flexWrap: "wrap" }}>
        <strong>{data.metricLabel}</strong>: {formatCohortValue(data.subjectValue, data.unit)}
        {ratio && <span className="rc-kpi__ratio">({ratio})</span>}
        {data.informationalOnly && (
          <span className="rc-kpi__badge" title="Appraisal-safe, but not part of any weighted score axis — carried for reference only">informational</span>
        )}
        {noBand ? (
          <span className="rc-kpi__badge" title={`Fewer than 5 people in this role cohort (${data.cohortSize} here) — no band or percentile shown (§5.2 small-cohort guard)`}>
            cohort too small for a band ({data.cohortSize} in cohort)
          </span>
        ) : (
          <span className="rc-kpi__badge rc-kpi__badge--band" data-band={data.band}>
            Band {data.band} of 5
          </span>
        )}
      </div>
      <div className="rc-cohort">
        <div
          className="rc-cohort__track"
          role="img"
          aria-label={
            noBand
              ? `${data.metricLabel}: cohort of ${data.cohortSize} is too small for a band — no ranking is shown`
              : `${data.metricLabel}: this person sits at the ${data.subjectPercentile}th percentile of ${data.cohortSize} peers in the same role cohort`
          }
        >
          {!noBand && (
            <div className="rc-cohort__marker" data-band={data.band} style={{ left: `${Math.min(98, Math.max(2, data.subjectPercentile ?? 50))}%` }}>
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
        columns={["Metric", "Value", "Numerator", "Denominator", "Percentile", "Band", "Cohort size"]}
        rows={[[
          data.metricLabel, formatCohortValue(data.subjectValue, data.unit),
          data.numerator ?? "", data.denominator ?? "",
          noBand ? "n/a (cohort too small)" : `P${data.subjectPercentile}`,
          noBand ? "n/a (cohort < 5)" : `${data.band} of 5`,
          data.cohortSize,
        ]]}
      />
    </div>
  );
}
