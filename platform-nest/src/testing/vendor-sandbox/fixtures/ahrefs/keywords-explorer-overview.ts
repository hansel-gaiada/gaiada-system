// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Ahrefs /keywords-explorer/overview shape — ahrefs.ts's own header flags this wrapper key
// (`keywords`) as an ASSUMED pattern (only domain-rating's/serp-overview's shapes were independently
// confirmed by direct doc fetch). getKeywordMetrics keys rows back onto the requested keywords.
export interface KeywordsExplorerRow {
  keyword: string;
  volume: number;
  difficulty: number;
}

export function keywordsExplorerOverviewEnvelope(rows: KeywordsExplorerRow[]) {
  return { keywords: rows };
}
