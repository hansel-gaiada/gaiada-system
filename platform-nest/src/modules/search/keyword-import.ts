// SM-09 — keyword import parsing (CSV / paste, design §12 SM-09). Pure, synchronous, no I/O: the
// controller owns the DB upsert (search.controller.ts follows the existing `withTenants` pattern),
// this file only turns raw pasted/uploaded text into a deduped, ordered list of {keyword, locale}.
//
// Supported input shapes (both are just lines of text — CSV is a special case of "line has a comma"):
//   - One keyword per line (plain paste): "running shoes\nbest running shoes"
//   - CSV with an optional header row whose first column is literally "keyword" (case-insensitive):
//       "keyword,locale\nrunning shoes,en-US\nsepatu lari,id-ID"
//   - CSV without a header: "running shoes,en-US"
// A line with no second column falls back to `defaultLocale`. Blank lines are skipped. Duplicate
// (keyword.lowercase(), locale) pairs are deduped, keeping first occurrence — so import is
// idempotent-ish against a pasted list that repeats a keyword under different casing.
//
// SM-32 gate defect fix: row/column splitting is now quote-aware end to end (parseCsvRows, now in core/csv.ts),
// replacing the previous `raw.split(/\r?\n/)` then `line.split(",")` pipeline, which ran BEFORE any
// quote-awareness existed and so corrupted any RFC4180-quoted field containing a comma or an
// embedded newline (see the fixed keyword-import.test.ts cases for exact before/after behaviour).
import { parseCsvRows, UnterminatedQuoteError } from "../../core/csv";

export interface ParsedKeywordRow {
  keyword: string;
  locale: string;
}

// The RFC 4180 tokenizer (`parseCsvRows`) and `UnterminatedQuoteError` now live in `core/csv.ts` (moved verbatim by SCP-6a, which shares them
// with the Social sheet import). Re-exported here so every existing import of the error from this file keeps working.
export { UnterminatedQuoteError };

export function parseKeywordImport(raw: string, defaultLocale = "id-ID"): ParsedKeywordRow[] {
  const rawRows = parseCsvRows(raw);
  // A "blank line" in the old line-based parser is now a row whose every column is blank once
  // trimmed — filter those out the same way the old `.filter((l) => l.length > 0)` did.
  const rows = rawRows.filter((cols) => cols.some((c) => c.trim().length > 0));
  if (rows.length === 0) return [];

  let start = 0;
  const firstCols = rows[0].map((c) => c.trim().toLowerCase());
  if (firstCols[0] === "keyword") start = 1;

  const out: ParsedKeywordRow[] = [];
  const seen = new Set<string>();
  for (let i = start; i < rows.length; i++) {
    const cols = rows[i];
    const keyword = (cols[0] ?? "").trim();
    if (!keyword) continue;
    const localeCol = cols[1] !== undefined ? cols[1].trim() : "";
    const locale = localeCol || defaultLocale;
    const dedupeKey = `${keyword.toLowerCase()}|${locale}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ keyword, locale });
  }
  return out;
}
