// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// DataForSEO /v3/backlinks/summary/live shape: dataforseo.ts's getBacklinkSummary reads
// `res.tasks?.[0]?.result?.[0]` for target/backlinks/referring_domains/rank.
export interface BacklinksSummaryParams {
  target: string;
  backlinks: number;
  referring_domains: number;
  rank: number;
}

export function backlinksSummaryEntry(params: BacklinksSummaryParams) {
  return {
    id: "dfs-sandbox-bl-task",
    status_code: 20000,
    status_message: "Ok.",
    result: [params],
  };
}
