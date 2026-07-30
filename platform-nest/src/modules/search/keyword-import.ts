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
// SM-32 gate defect fix: row/column splitting is now quote-aware end to end (parseCsvRows below),
// replacing the previous `raw.split(/\r?\n/)` then `line.split(",")` pipeline, which ran BEFORE any
// quote-awareness existed and so corrupted any RFC4180-quoted field containing a comma or an
// embedded newline (see the fixed keyword-import.test.ts cases for exact before/after behaviour).
export interface ParsedKeywordRow {
  keyword: string;
  locale: string;
}

/** Thrown by parseCsvRows when the input ends while still inside an open quoted field — reject with
 *  a clear error rather than silently mangling or hanging (SM-32 AC). The controller converts this
 *  into a 400. */
export class UnterminatedQuoteError extends Error {
  constructor() {
    super("unterminated quoted field in keyword import CSV (a \" was opened but never closed)");
    this.name = "UnterminatedQuoteError";
  }
}

/** Minimal RFC4180-style quote-aware CSV tokenizer, operating on the WHOLE input (not pre-split by
 *  line) so a quoted field may itself contain a comma or a literal newline without being corrupted:
 *   - a field is "quoted" only when its FIRST character is `"` (mirrors the old stripQuotes()
 *     semantics of "strip a quote pair that wraps the whole value", just applied correctly — a
 *     stray `"` elsewhere in an unquoted field is kept as a literal character, not a mode switch);
 *   - inside a quoted field, `,` and `\n`/`\r\n` are literal content, not separators;
 *   - `""` inside a quoted field is an escaped literal `"`;
 *   - `\r\n` and bare `\n` both end a row (outside quotes);
 *   - an input that ends still inside an open quote throws UnterminatedQuoteError.
 */
function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = raw.length;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r" && raw[i + 1] === "\n") {
      endRow();
      i += 2;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (inQuotes) throw new UnterminatedQuoteError();
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}

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
