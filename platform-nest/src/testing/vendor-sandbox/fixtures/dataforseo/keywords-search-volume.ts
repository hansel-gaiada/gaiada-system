// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO /v3/keywords_data/google_ads/search_volume/live shape: dataforseo.ts's
// getKeywordMetrics reads `res.tasks?.[0]?.result` as an array of ROW objects directly (no nested
// `result[0].items`, unlike the SERP task_get shape) keyed by `row.keyword`.
export interface KeywordVolumeRow {
  keyword: string;
  search_volume: number;
  cpc: number;
  keyword_difficulty: number;
}

export function keywordsSearchVolumeEntry(rows: KeywordVolumeRow[]) {
  return {
    id: "dfs-sandbox-kw-task",
    status_code: 20000,
    status_message: "Ok.",
    result: rows,
  };
}
