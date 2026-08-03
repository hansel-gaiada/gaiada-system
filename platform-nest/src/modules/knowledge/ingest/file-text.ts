// Text extraction for attached files, used by the internal ERP ingester.
//
// ── WHAT IS AND IS NOT PARSED, AND WHY ───────────────────────────────────────────────────────────
// Plain-text-family formats (txt/md/csv/json/html/xml/yaml) are decoded directly, and spreadsheets
// go through `exceljs`, which platform-nest ALREADY depends on for report export — so nothing new
// enters the ERP core's attack surface here.
//
// PDF and DOCX are deliberately NOT parsed. Doing so means running binary document parsers
// (`pdf-parse`, `mammoth`) in-process against arbitrary user-uploaded bytes inside the service that
// holds every company's data. wa-chat-bot accepts that trade because it is an isolated,
// crypto-shredded surface; the ERP core is not the same risk position, and it is the user's call to
// make rather than a default worth slipping in. `extractFileText` returns "" for them, so those
// files are still INDEXED BY METADATA (name, type, what they are attached to) and remain findable —
// only their body text is missing. To enable: add the parsers, extend the switch below; nothing else
// in the pipeline changes.
import { storage } from "../../../core/storage";

/** Skip anything bigger than this: a 200MB export would be minutes of embedding for one file. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Cap the extracted text per file for the same reason the transcript cap exists. */
const MAX_TEXT_CHARS = 40_000;

const TEXTUAL = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|sql))/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|html?|log|sql)$/i;
const SHEET = /(spreadsheetml|ms-excel)/i;
const SHEET_EXT = /\.(xlsx|xlsm)$/i;

/** Decode a spreadsheet into "Sheet / row" lines. Cell values only — formatting carries no meaning
 *  for retrieval, and formulas would index the formula rather than the answer. */
async function sheetToText(bytes: Buffer): Promise<string> {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const lines: string[] = [];
  wb.eachSheet((sheet) => {
    lines.push(`Sheet: ${sheet.name}`);
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) return;
        if (typeof v === "object" && "result" in (v as object)) cells.push(String((v as { result: unknown }).result ?? ""));
        else if (typeof v === "object" && "text" in (v as object)) cells.push(String((v as { text: unknown }).text ?? ""));
        else cells.push(String(v));
      });
      if (cells.length > 0) lines.push(cells.join(" | "));
    });
  });
  return lines.join("\n");
}

/** Best-effort text for one stored file. Returns "" for anything unparseable — never throws, because
 *  one unreadable attachment must not fail a whole tenant's ingest run. */
export async function extractFileText(storageKey: string, contentType: string, filename: string): Promise<string> {
  try {
    const bytes = await storage().get(storageKey);
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as Uint8Array);
    if (buf.byteLength > MAX_FILE_BYTES) return "";

    if (TEXTUAL.test(contentType) || TEXT_EXT.test(filename)) {
      return buf.toString("utf8").slice(0, MAX_TEXT_CHARS);
    }
    if (SHEET.test(contentType) || SHEET_EXT.test(filename)) {
      return (await sheetToText(buf)).slice(0, MAX_TEXT_CHARS);
    }
    return ""; // pdf/docx/images/binaries — metadata-only, see the file header
  } catch {
    return "";
  }
}
