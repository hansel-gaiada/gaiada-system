// The shared RFC 4180 tokenizer. It started life as `parseCsvRows` inside the keyword import (SM-32, `search/keyword-import.ts`) and was
// moved here, unchanged in behaviour, when the Social sheet import (SCP-6a, BFF §63.23) needed the same quote-aware split. Pure, no I/O.
//
// The keyword import calls it with no options (`,` as the separator, the BOM left alone: its behaviour and tests do not change). The sheet
// import passes `{ separator }` (`,` or `;`) and `{ dropBom: true }`.

/** Thrown by parseCsvRows when the input ends while still inside an open quoted field — reject with
 *  a clear error rather than silently mangling or hanging (SM-32 AC). The controller converts this
 *  into a 400. */
export class UnterminatedQuoteError extends Error {
  constructor(what = "keyword import CSV") {
    super(`unterminated quoted field in ${what} (a \" was opened but never closed)`);
    this.name = "UnterminatedQuoteError";
  }
}

export interface CsvOptions {
  /** The field separator, one character. Default `,`. */
  separator?: string;
  /** Drop a leading U+FEFF (the byte-order mark Excel writes on "CSV UTF-8"). Default false. */
  dropBom?: boolean;
  /** Named in the `UnterminatedQuoteError` message. Default the keyword import (the message its callers already show). */
  what?: string;
}

/** Minimal RFC4180-style quote-aware CSV tokenizer, operating on the WHOLE input (not pre-split by
 *  line) so a quoted field may itself contain a comma or a literal newline without being corrupted:
 *   - a field is "quoted" only when its FIRST character is `"` (mirrors the old stripQuotes()
 *     semantics of "strip a quote pair that wraps the whole value", just applied correctly — a
 *     stray `"` elsewhere in an unquoted field is kept as a literal character, not a mode switch);
 *   - inside a quoted field, the separator and `\n`/`\r\n` are literal content, not separators;
 *   - `""` inside a quoted field is an escaped literal `"`;
 *   - `\r\n` and bare `\n` both end a row (outside quotes);
 *   - an input that ends still inside an open quote throws UnterminatedQuoteError.
 */
export function parseCsvRows(input: string, opts: CsvOptions = {}): string[][] {
  const sep = opts.separator ?? ",";
  const raw = opts.dropBom && input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
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
    if (ch === sep) {
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
  if (inQuotes) throw new UnterminatedQuoteError(opts.what);
  if (field.length > 0 || row.length > 0) endRow();
  return rows;
}
