// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// GA4 Data API v1beta `properties.runReport` response: `{dimensionHeaders, metricHeaders, rows:
// [{dimensionValues:[{value}], metricValues:[{value}]}], rowCount, metadata, kind}`.
//
// SHAPE FACTS FROM DOCS (all SM-41G confirmables):
//   * EVERY metric value arrives as a STRING, including counts and doubles. A parser that assumes
//     numbers gets `"1234"`, and one that assumes integers gets `"12.5"` for a rate metric. Modelled
//     literally here for that reason.
//   * headers are positional, exactly like GSC's `keys`: `dimensionValues[i]` aligns with
//     `dimensionHeaders[i]`. There are no names inside the rows.
//   * `rows` is ABSENT when the report is empty, and `rowCount` is then absent too.
//   * GA4 applies its own thresholding + sampling on some property/date combinations and signals it in
//     `metadata`. Not modelled — a pipeline property, not an envelope property.
export interface Ga4RowSpec {
  dimensions: string[];
  /** Metric values as STRINGS, matching the wire format. */
  metrics: string[];
}

export function ga4RunReportBody(args: {
  dimensionNames: string[];
  metricNames: string[];
  rows: Ga4RowSpec[];
}) {
  const base = {
    dimensionHeaders: args.dimensionNames.map((name) => ({ name })),
    metricHeaders: args.metricNames.map((name) => ({ name, type: "TYPE_INTEGER" })),
    metadata: { currencyCode: "USD", timeZone: "UTC" },
    kind: "analyticsData#runReport",
  };
  if (args.rows.length === 0) return base;
  return {
    ...base,
    rows: args.rows.map((r) => ({
      dimensionValues: r.dimensions.map((value) => ({ value })),
      metricValues: r.metrics.map((value) => ({ value })),
    })),
    rowCount: args.rows.length,
  };
}

/** Deterministic default report for an unseeded property — sessions + totalUsers by sessionSource. */
export function defaultGa4Report(propertyId: string) {
  let h = 5381;
  for (let i = 0; i < propertyId.length; i++) h = (h * 33) ^ propertyId.charCodeAt(i);
  const sessions = 500 + ((h >>> 0) % 500);
  return ga4RunReportBody({
    dimensionNames: ["sessionSource"],
    metricNames: ["sessions", "totalUsers"],
    rows: [
      { dimensions: ["google"], metrics: [String(sessions), String(Math.floor(sessions * 0.8))] },
      { dimensions: ["(direct)"], metrics: [String(Math.floor(sessions / 3)), String(Math.floor(sessions / 4))] },
    ],
  });
}
