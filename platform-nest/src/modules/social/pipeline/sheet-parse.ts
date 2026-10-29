// SCP-6a — `POST import/parse`: a sheet read into tabs of text cells (BFF §63.23.1; plan §8 SCP-6, SCP-D10). Writes nothing and touches no table:
// the controller (`sheet-import.controller.ts`) authorizes first and then calls `parseSheetBody`.
//
// THREE SOURCES, ONE SHAPE. An `.xlsx` (one tab per VISIBLE worksheet, read with `exceljs`), a `.csv` (one tab named after the file) and pasted
// text (one tab named `Pasted`; rows copied from Google Sheets or Excel arrive tab-separated, with a quoted cell keeping its newlines). Every cell
// becomes TEXT, so the import's own readers (`sheet-import.ts`) are the one place that decides what a cell means.
//
// THE CELLS (xlsx). A date cell is `YYYY-MM-DD`, with ` HH:MM` when it has a time part (exceljs hands dates over as UTC wall time, so the UTC
// fields ARE what the sheet shows). An Excel time-only cell is a date on 1899-12-30, which is not a date the team meant: it becomes just `HH:MM`.
// A number is its plain string (no thousands separator, no exponent). A formula is its cached result, rich text its plain text, a hyperlink its
// text, an error its code (`#N/A`), a boolean `TRUE`/`FALSE`, an empty cell `""`. The slave cells of a merged range are `""`: the value sits in
// the range's top-left cell only.
//
// THE LIMITS (400 `sheet_too_large` with `field`; an .xlsx past 32 MiB unpacked is `file`, see THE ZIP BOMB): 20 tabs, 2,000 rows and 60 columns per tab (after trailing empty rows and columns are trimmed),
// 5,000 characters per cell. A non-empty cell past row 2,000 or column 60 is refused while the sheet is read, so a huge sheet is never held whole.
//
// THE ZIP BOMB. exceljs inflates the whole workbook in memory, so a 2 MiB upload could expand to gigabytes and take platform-nest down with it.
// `assertZipInflatesWithin` inflates every part first under a hard budget (`MAX_XLSX_INFLATED_BYTES`, 32 MiB) and refuses past it (400
// `sheet_too_large`, `field: "file"`) before exceljs sees a byte.
import { inflateRawSync } from "node:zlib";
import { BadRequestException } from "@nestjs/common";
import { parseCsvRows, UnterminatedQuoteError } from "../../../core/csv";

/** The decoded size of an uploaded sheet, and of pasted text as UTF-8 (BFF §63.23.1). `upload-body-limits.ts` derives the route's body limit from it. */
export const MAX_SHEET_BYTES = 2 * 1024 * 1024;
export const SHEET_LIMITS = { tabs: 20, rows: 2000, columns: 60, cell: 5000 } as const;

export interface SheetTab {
  name: string;
  rows: string[][];
}

const invalid = (field: string): never => {
  throw new BadRequestException({ message: "invalid_field", field });
};
const tooLarge = (field: "tabs" | "rows" | "columns" | "cell" | "file"): never => {
  throw new BadRequestException({ message: "sheet_too_large", field });
};
const unreadable = (): never => {
  throw new BadRequestException({ message: "unreadable_sheet" });
};

// ── cell text ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** A date value as the sheet shows it, from its UTC fields (see the header). Rounded to the minute: a time that came from a fraction of a day carries float noise. */
export function dateCellText(d: Date): string {
  const t = d.getTime();
  if (!Number.isFinite(t)) return "";
  const r = new Date(Math.round(t / 60000) * 60000);
  const day = `${String(r.getUTCFullYear()).padStart(4, "0")}-${pad2(r.getUTCMonth() + 1)}-${pad2(r.getUTCDate())}`;
  const hm = `${pad2(r.getUTCHours())}:${pad2(r.getUTCMinutes())}`;
  if (day === "1899-12-30") return hm; // an Excel time-only cell
  return hm === "00:00" ? day : `${day} ${hm}`;
}

/** A number as its plain string: no thousands separator, no exponent. */
export function numberCellText(n: number): string {
  if (!Number.isFinite(n)) return "";
  const s = String(n);
  return /e/i.test(s) ? n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : s;
}

/** One exceljs cell value as text (the header's table). Pure: the tests feed it the shapes exceljs hands over. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return dateCellText(v);
  if (typeof v === "number") return numberCellText(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: unknown }>).map((r) => (typeof r?.text === "string" ? r.text : "")).join("");
    if ("formula" in o || "sharedFormula" in o) return valueText(o.result); // the cached result; none cached is an empty cell
    if ("hyperlink" in o) return valueText(o.text);
    if (typeof o.error === "string") return o.error;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

// ── shaping: trim, then the limits ───────────────────────────────────────────────────────────────────────────────────────

const isBlank = (s: string): boolean => s.trim() === "";

/** Trailing empty rows and columns trimmed, the table made rectangular, and the limits applied. */
export function shapeTab(name: string, raw: string[][]): SheetTab {
  for (const row of raw) for (const cell of row) if ([...cell].length > SHEET_LIMITS.cell) tooLarge("cell");
  let lastRow = 0;
  let lastCol = 0;
  raw.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (isBlank(cell)) return;
      lastRow = Math.max(lastRow, r + 1);
      lastCol = Math.max(lastCol, c + 1);
    });
  });
  if (lastRow > SHEET_LIMITS.rows) tooLarge("rows");
  if (lastCol > SHEET_LIMITS.columns) tooLarge("columns");
  const rows: string[][] = [];
  for (let r = 0; r < lastRow; r++) {
    const src = raw[r] ?? [];
    const out: string[] = [];
    for (let c = 0; c < lastCol; c++) out.push(src[c] ?? "");
    rows.push(out);
  }
  return { name, rows };
}

// ── the three sources ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What an `.xlsx` may unpack to, every part together. A real 2,000-row sheet is a few MiB of XML; this leaves room for styles and images. */
export const MAX_XLSX_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * The zip-bomb check, run BEFORE exceljs (which unpacks the whole workbook in memory). An `.xlsx` is a zip: every entry the central directory lists
 * is inflated here with zlib's `maxOutputLength` set to what is left of `max`, so the bound holds on the bytes zlib actually produces, never on the
 * sizes the zip declares (a hostile zip may lie about those). Over the bound: 400 `sheet_too_large` with `field: "file"`. Not a zip, a truncated one,
 * a ZIP64 one or an unknown compression method: 400 `unreadable_sheet`, which exceljs would answer too.
 */
export function assertZipInflatesWithin(bytes: Buffer, max: number): void {
  const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;
  // The end-of-central-directory record: 22 bytes, followed by a comment of at most 65,535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return unreadable();
  const entries = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || p === 0xffffffff) return unreadable(); // ZIP64: no spreadsheet the team saves needs it
  let left = max;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== CEN) return unreadable();
    const method = bytes.readUInt16LE(p + 10);
    const compressed = bytes.readUInt32LE(p + 20);
    const local = bytes.readUInt32LE(p + 42);
    p += 46 + bytes.readUInt16LE(p + 28) + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOC) return unreadable();
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressed > bytes.length) return unreadable();
    const data = bytes.subarray(start, start + compressed);
    let produced: number;
    if (method === 0) produced = data.length;
    else if (method === 8) {
      try {
        produced = inflateRawSync(data, { maxOutputLength: left + 1 }).length;
      } catch (e) {
        if (e instanceof RangeError) return tooLarge("file");
        return unreadable();
      }
    } else return unreadable();
    left -= produced;
    if (left < 0) return tooLarge("file");
  }
}

/** An `.xlsx` as one tab per visible worksheet, in workbook order. 400 `unreadable_sheet` when exceljs cannot open it. */
export async function tabsFromXlsx(bytes: Buffer): Promise<SheetTab[]> {
  assertZipInflatesWithin(bytes, MAX_XLSX_INFLATED_BYTES);
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    return unreadable();
  }
  const visible = wb.worksheets.filter((ws) => ws.state === "visible");
  if (visible.length > SHEET_LIMITS.tabs) tooLarge("tabs");
  return visible.map((ws) => {
    const grid: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        // A merged range holds its value in the top-left cell only.
        const text = cell.isMerged && cell.master.address !== cell.address ? "" : valueText(cell.value);
        if (isBlank(text)) return;
        if (rowNumber > SHEET_LIMITS.rows) tooLarge("rows");
        if (colNumber > SHEET_LIMITS.columns) tooLarge("columns");
        while (cells.length < colNumber - 1) cells.push("");
        cells[colNumber - 1] = text;
      });
      if (cells.length === 0) return;
      while (grid.length < rowNumber - 1) grid.push([]);
      grid[rowNumber - 1] = cells.map((c) => c ?? "");
    });
    return shapeTab(ws.name, grid);
  });
}

/** The separator of the first record: counts outside quotes, so a quoted `a,b` in the header does not vote. */
function firstRecordCounts(text: string): { tab: number; comma: number; semi: number } {
  const counts = { tab: 0, comma: 0, semi: 0 };
  let inQuotes = false;
  let fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === "\n" || ch === "\r") break;
    if (ch === '"' && fieldStart) { inQuotes = true; fieldStart = false; continue; }
    if (ch === "\t") { counts.tab++; fieldStart = true; continue; }
    if (ch === ",") { counts.comma++; fieldStart = true; continue; }
    if (ch === ";") { counts.semi++; fieldStart = true; continue; }
    fieldStart = false;
  }
  return counts;
}

function tokenize(text: string, separator: string): string[][] {
  try {
    return parseCsvRows(text, { separator, dropBom: true, what: "sheet" });
  } catch (e) {
    if (e instanceof UnterminatedQuoteError) return unreadable();
    throw e;
  }
}

/** A `.csv`'s text as one tab. The separator is `,` or `;`, whichever the first line holds more of (a tie is `,`). */
export function tabsFromCsv(text: string, name: string): SheetTab[] {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const c = firstRecordCounts(stripped);
  return [shapeTab(name, tokenize(stripped, c.semi > c.comma ? ";" : ","))];
}

/** Pasted text as the tab `Pasted`: tab-separated when the first line holds a tab, else the csv rule. */
export function tabsFromPaste(text: string): SheetTab[] {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const c = firstRecordCounts(stripped);
  const separator = c.tab > 0 ? "\t" : c.semi > c.comma ? ";" : ",";
  return [shapeTab("Pasted", tokenize(stripped, separator))];
}

// ── the route's body ─────────────────────────────────────────────────────────────────────────────────────────────────────

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** The decoded size of a base64 string, without decoding it. */
function base64DecodedBytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/**
 * `{filename, contentBase64}` or `{text}` (BFF §63.23.1): validated, then read into tabs. The 400s: `invalid_field` with `field` `body`, `contentBase64`,
 * `filename` or `text`; `sheet_too_large` with `field`; `unreadable_sheet`.
 */
export async function parseSheetBody(body: unknown): Promise<{ tabs: SheetTab[] }> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return invalid("body");
  const b = body as Record<string, unknown>;
  const hasFile = b.filename !== undefined || b.contentBase64 !== undefined;
  const hasText = b.text !== undefined;
  if (hasFile === hasText) return invalid("body"); // neither, or both

  if (hasText) {
    if (typeof b.text !== "string" || Buffer.byteLength(b.text, "utf8") > MAX_SHEET_BYTES) return invalid("text");
    return { tabs: tabsFromPaste(b.text) };
  }

  if (typeof b.filename !== "string") return invalid("filename");
  const ext = /\.(xlsx|csv)$/i.exec(b.filename.trim())?.[1]?.toLowerCase();
  if (!ext) return invalid("filename");
  if (typeof b.contentBase64 !== "string") return invalid("contentBase64");
  const b64 = b.contentBase64.replace(/\s+/g, "");
  // Padding, when present, must complete the last group; a lone trailing character cannot be base64 at all.
  if (!BASE64_RE.test(b64) || b64.length % 4 === 1 || (b64.includes("=") && b64.length % 4 !== 0) || base64DecodedBytes(b64) > MAX_SHEET_BYTES) {
    return invalid("contentBase64");
  }
  const bytes = Buffer.from(b64, "base64");

  if (ext === "xlsx") return { tabs: await tabsFromXlsx(bytes) };
  const base = b.filename.trim().split(/[\\/]/).pop() ?? "";
  return { tabs: tabsFromCsv(bytes.toString("utf8"), base.replace(/\.csv$/i, "") || "Sheet") };
}
