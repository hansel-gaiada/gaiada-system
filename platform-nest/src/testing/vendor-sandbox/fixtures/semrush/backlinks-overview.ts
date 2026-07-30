// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Semrush `backlinks_overview` semicolon-delimited envelope — semrush.ts requests
// `export_columns: "ascore,total,domains_num"` and reads all three columns directly.
export interface BacklinksOverviewParams {
  ascore: number;
  total: number;
  domains_num: number;
}

export function backlinksOverviewText(params: BacklinksOverviewParams): string {
  return ["ascore;total;domains_num", `${params.ascore};${params.total};${params.domains_num}`].join("\r\n");
}
