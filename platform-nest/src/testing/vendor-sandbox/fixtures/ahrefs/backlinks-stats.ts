// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Ahrefs /site-explorer/backlinks-stats shape — ahrefs.ts's own header flags the `metrics` wrapper
// key as ASSUMED (not independently confirmed). getBacklinkSummary reads `metrics.live` /
// `metrics.live_refdomains`.
export interface BacklinksStatsParams {
  live: number;
  live_refdomains: number;
}

export function backlinksStatsEnvelope(params: BacklinksStatsParams) {
  return { metrics: params };
}
