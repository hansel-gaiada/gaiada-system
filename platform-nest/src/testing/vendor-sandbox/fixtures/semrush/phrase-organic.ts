// UNVERIFIED-VENDOR-FIXTURE: authored from docs 2026-07-29; superseded by SM-41 recordings
//
// Semrush `phrase_organic` (organic rankings for ONE keyword) semicolon-delimited envelope —
// semrush.ts requests `export_columns: "Po,Ur,Dn"` and reads Po (position) / Ur (ranking URL);
// Dn (domain) is requested but not read back into SerpResult. Header row + CRLF line endings match
// semrush.ts's own documented example format (see that file's header comment).
export function phraseOrganicText(keyword: string): string {
  const slug = keyword.trim().toLowerCase().replace(/\s+/g, "-");
  return [
    "Po;Ur;Dn",
    `1;https://sandbox-one.example/${slug};sandbox-one.example`,
    `2;https://sandbox-two.example/${slug};sandbox-two.example`,
  ].join("\r\n");
}
