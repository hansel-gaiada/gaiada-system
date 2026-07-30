// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Semrush `phrase_these` (batch Keyword Overview) semicolon-delimited envelope — semrush.ts requests
// `export_columns: "Ph,Nq,Cp,Kd"` (keyword, search volume, CPC, keyword difficulty) and keys rows
// back onto the requested keywords by the `Ph` column.
export interface PhraseTheseRow {
  keyword: string;
  volume: number;
  cpc: number;
  kd: number;
}

export function phraseTheseText(rows: PhraseTheseRow[]): string {
  const lines = rows.map((r) => `${r.keyword};${r.volume};${r.cpc};${r.kd}`);
  return ["Ph;Nq;Cp;Kd", ...lines].join("\r\n");
}
