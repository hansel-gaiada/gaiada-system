// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-30; superseded by SM-41G recordings
//
// Search Console API v3 `searchanalytics.query` response — THE surface an SEO department cannot do
// without: `{rows: [{keys, clicks, impressions, ctr, position}], responseAggregationType}`.
//
// SHAPE FACTS TAKEN FROM DOCS (each one is a thing SM-41G must confirm against a real property):
//   * `keys` is an ARRAY, positionally aligned with the REQUEST's `dimensions` array — there are no
//     field names in the response, so a consumer that mis-orders its request dimensions silently
//     mislabels every row. That is why this fixture is generated FROM the requested dimensions.
//   * `ctr` is a FRACTION (0..1), not a percentage; `position` is a 1-based average and is a FLOAT.
//   * rows are omitted entirely (not zero-filled) for dimension combinations with no data, and the
//     `rows` key itself is ABSENT — not `[]` — when nothing matched. Modelled here deliberately,
//     because "no data" vs "empty array" is exactly the distinction a parser gets wrong once.
//   * Google applies data-freshness lag (recent days are incomplete) and privacy thresholding (rare
//     queries are withheld entirely, so clicks/impressions do NOT sum to the property totals). Neither
//     is modelled here and neither can be: they are properties of Google's pipeline, not of an envelope.
//     Any report built on this data must state that, and SM-41G is where it gets measured.
export interface GscAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** A deterministic row set for one site — never random, so two consecutive sandbox runs are identical
 *  (SM-49 AC 12's determinism rule, carried over). Values are derived from the key strings themselves. */
export function deterministicRows(dimensions: string[], subjects: string[][]): GscAnalyticsRow[] {
  return subjects.map((keys) => {
    let h = 5381;
    for (const k of keys) for (let i = 0; i < k.length; i++) h = (h * 33) ^ k.charCodeAt(i);
    const impressions = 100 + ((h >>> 0) % 900);
    const clicks = Math.max(1, Math.floor(impressions / (3 + ((h >>> 8) % 20))));
    return {
      keys: keys.slice(0, Math.max(1, dimensions.length)),
      clicks,
      impressions,
      // Fraction, not percent — the single most commonly mis-read field in this envelope.
      ctr: Number((clicks / impressions).toFixed(6)),
      position: Number((1 + ((h >>> 16) % 4000) / 100).toFixed(2)),
    };
  });
}

export function gscSearchAnalyticsBody(rows: GscAnalyticsRow[] | null, aggregationType = "byProperty") {
  // `rows` ABSENT (not empty) when there is no data — see the header note.
  return rows && rows.length > 0
    ? { rows, responseAggregationType: aggregationType }
    : { responseAggregationType: aggregationType };
}
