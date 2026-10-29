// SCP-6a — `POST import/parse`'s reader (BFF §63.23.1), PURE: no database, no Cerbos. The workbooks are built here with exceljs and read back through
// the real `parseSheetBody`, so the dates, numbers, formulas, rich text, hidden sheets and limits are proved on what exceljs really hands over.
import { deflateRawSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { BadRequestException } from "@nestjs/common";
import ExcelJS from "exceljs";
import {
  MAX_SHEET_BYTES, MAX_XLSX_INFLATED_BYTES, SHEET_LIMITS, assertZipInflatesWithin, dateCellText, numberCellText, parseSheetBody, tabsFromCsv,
  tabsFromPaste, valueText,
} from "./sheet-parse";

/** The `{message, field}` of the 400 a call rejects with. */
async function refusal(fn: () => Promise<unknown> | unknown): Promise<{ message?: string; field?: string }> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof BadRequestException) return e.getResponse() as { message?: string; field?: string };
    throw e;
  }
  throw new Error("expected a 400");
}

async function xlsx(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const file = (name: string, bytes: Buffer | string) => ({ filename: name, contentBase64: Buffer.from(bytes).toString("base64") });

describe("the cell text rules", () => {
  it("a date is YYYY-MM-DD, with HH:MM when it has a time, from the UTC fields", () => {
    expect(dateCellText(new Date(Date.UTC(2026, 10, 3)))).toBe("2026-11-03");
    expect(dateCellText(new Date(Date.UTC(2026, 10, 3, 9, 30)))).toBe("2026-11-03 09:30");
    expect(dateCellText(new Date(Date.UTC(2026, 10, 3, 9, 29, 59, 999)))).toBe("2026-11-03 09:30"); // float noise from a fraction of a day
    expect(dateCellText(new Date(Date.UTC(1899, 11, 30, 9, 0)))).toBe("09:00"); // an Excel time-only cell
    expect(dateCellText(new Date(Number.NaN))).toBe("");
  });
  it("a number is its plain string: no thousands separator, no exponent", () => {
    expect(numberCellText(12)).toBe("12");
    expect(numberCellText(1234567.5)).toBe("1234567.5");
    expect(numberCellText(-3)).toBe("-3");
    expect(numberCellText(1e21)).toBe("1000000000000000000000");
    expect(numberCellText(0.0000001)).toBe("0.0000001");
    expect(numberCellText(Number.NaN)).toBe("");
  });
  it("every value shape exceljs hands over becomes text", () => {
    expect(valueText(null)).toBe("");
    expect(valueText(undefined)).toBe("");
    expect(valueText("plain")).toBe("plain");
    expect(valueText(true)).toBe("TRUE");
    expect(valueText(false)).toBe("FALSE");
    expect(valueText({ richText: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(valueText({ formula: "A1", result: 7 })).toBe("7");
    expect(valueText({ formula: "A1" })).toBe("");
    expect(valueText({ sharedFormula: "A1", result: "x" })).toBe("x");
    expect(valueText({ formula: "A1", result: new Date(Date.UTC(2026, 0, 2)) })).toBe("2026-01-02");
    expect(valueText({ text: "Site", hyperlink: "https://example.invalid/" })).toBe("Site");
    expect(valueText({ text: { richText: [{ text: "Rich " }, { text: "link" }] }, hyperlink: "https://example.invalid/" })).toBe("Rich link");
    expect(valueText({ error: "#N/A" })).toBe("#N/A");
    expect(valueText({ formula: "NA()", result: { error: "#DIV/0!" } })).toBe("#DIV/0!");
  });
});

describe("an .xlsx", () => {
  it("reads dates, a date-time, a time-only cell, numbers, a formula's cached result, rich text, a hyperlink, booleans and errors as text", async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet("Plan");
      ws.getCell("A1").value = "Date";
      ws.getCell("A2").value = new Date(Date.UTC(2026, 10, 3));
      ws.getCell("A3").value = new Date(Date.UTC(2026, 10, 3, 9, 30));
      ws.getCell("A4").value = new Date(Date.UTC(1899, 11, 30, 18, 15));
      ws.getCell("B1").value = "Number";
      ws.getCell("B2").value = 12;
      ws.getCell("B3").value = 1234567.5;
      ws.getCell("B4").value = { formula: "B2+B2", result: 24 };
      ws.getCell("C1").value = { richText: [{ text: "Rich " }, { text: "text", font: { bold: true } }] };
      ws.getCell("C2").value = { text: "Site", hyperlink: "https://example.invalid/" };
      ws.getCell("C3").value = true;
      ws.getCell("C4").value = { formula: "NA()", result: { error: "#N/A" } };
    });
    const { tabs } = await parseSheetBody(file("plan.xlsx", bytes));
    expect(tabs).toHaveLength(1);
    expect(tabs[0].name).toBe("Plan");
    expect(tabs[0].rows).toEqual([
      ["Date", "Number", "Rich text"],
      ["2026-11-03", "12", "Site"],
      ["2026-11-03 09:30", "1234567.5", "TRUE"],
      ["18:15", "24", "#N/A"],
    ]);
  });

  it("one tab per VISIBLE worksheet, in workbook order; hidden and very hidden sheets are left out", async () => {
    const bytes = await xlsx((wb) => {
      wb.addWorksheet("First").getCell("A1").value = "one";
      wb.addWorksheet("Secret", { state: "hidden" }).getCell("A1").value = "hidden";
      wb.addWorksheet("Deeper", { state: "veryHidden" }).getCell("A1").value = "very hidden";
      wb.addWorksheet("Last").getCell("A1").value = "two";
    });
    const { tabs } = await parseSheetBody(file("book.xlsx", bytes));
    expect(tabs.map((t) => t.name)).toEqual(["First", "Last"]);
    expect(tabs.map((t) => t.rows)).toEqual([[["one"]], [["two"]]]);
  });

  it("an empty cell is an empty string, interior blank rows and columns stay, trailing ones are trimmed", async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet("Gaps");
      ws.getCell("A1").value = "a";
      ws.getCell("C1").value = "c";
      ws.getCell("A3").value = "a3";
      // Empty but styled cells far to the right and below are still empty.
      ws.getCell("H9").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF0000" } };
      ws.getCell("F2").value = "   "; // whitespace only: empty for trimming
    });
    const { tabs } = await parseSheetBody(file("gaps.xlsx", bytes));
    expect(tabs[0].rows).toEqual([["a", "", "c"], ["", "", ""], ["a3", "", ""]]);
  });

  it("a sheet with nothing in it is one tab with no rows", async () => {
    const bytes = await xlsx((wb) => { wb.addWorksheet("Blank"); });
    const { tabs } = await parseSheetBody(file("blank.xlsx", bytes));
    expect(tabs).toEqual([{ name: "Blank", rows: [] }]);
  });

  it("the slave cells of a merged range are empty: the value sits in the top-left cell", async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet("Merged");
      ws.getCell("A1").value = "Title";
      ws.mergeCells("A1:C1");
      ws.getCell("A2").value = "x";
      ws.getCell("C2").value = "z";
    });
    const { tabs } = await parseSheetBody(file("merged.xlsx", bytes));
    expect(tabs[0].rows).toEqual([["Title", "", ""], ["x", "", "z"]]);
  });

  it("the limits: 20 tabs pass, 21 do not; 2,000 rows pass, 2,001 do not; 60 columns pass, 61 do not; 5,000 characters pass, 5,001 do not", async () => {
    const tabs = (n: number) => xlsx((wb) => { for (let i = 0; i < n; i++) wb.addWorksheet(`S${i}`).getCell("A1").value = "x"; });
    expect((await parseSheetBody(file("t.xlsx", await tabs(20)))).tabs).toHaveLength(20);
    expect(await refusal(async () => parseSheetBody(file("t.xlsx", await tabs(21))))).toEqual({ message: "sheet_too_large", field: "tabs" });

    const rows = (n: number) => xlsx((wb) => { wb.addWorksheet("R").getCell(`A${n}`).value = "last"; });
    expect((await parseSheetBody(file("r.xlsx", await rows(SHEET_LIMITS.rows)))).tabs[0].rows).toHaveLength(SHEET_LIMITS.rows);
    expect(await refusal(async () => parseSheetBody(file("r.xlsx", await rows(SHEET_LIMITS.rows + 1))))).toEqual({ message: "sheet_too_large", field: "rows" });

    const cols = (n: number) => xlsx((wb) => { wb.addWorksheet("C").getCell(1, n).value = "last"; });
    expect((await parseSheetBody(file("c.xlsx", await cols(SHEET_LIMITS.columns)))).tabs[0].rows[0]).toHaveLength(SHEET_LIMITS.columns);
    expect(await refusal(async () => parseSheetBody(file("c.xlsx", await cols(SHEET_LIMITS.columns + 1))))).toEqual({ message: "sheet_too_large", field: "columns" });

    const cell = (n: number) => xlsx((wb) => { wb.addWorksheet("L").getCell("A1").value = "x".repeat(n); });
    expect((await parseSheetBody(file("l.xlsx", await cell(SHEET_LIMITS.cell)))).tabs[0].rows[0][0]).toHaveLength(SHEET_LIMITS.cell);
    expect(await refusal(async () => parseSheetBody(file("l.xlsx", await cell(SHEET_LIMITS.cell + 1))))).toEqual({ message: "sheet_too_large", field: "cell" });
  });

  it("trailing empty rows past the limit are trimmed first, so a styled empty row 3,000 is not too large", async () => {
    const bytes = await xlsx((wb) => {
      const ws = wb.addWorksheet("Styled");
      ws.getCell("A1").value = "x";
      ws.getCell("A3000").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00FF00" } };
    });
    expect((await parseSheetBody(file("styled.xlsx", bytes))).tabs[0].rows).toEqual([["x"]]);
  });

  it("400 unreadable_sheet when exceljs cannot open the file", async () => {
    expect(await refusal(() => parseSheetBody(file("bad.xlsx", "this is not a zip file")))).toEqual({ message: "unreadable_sheet" });
    const good = await xlsx((wb) => { wb.addWorksheet("S").getCell("A1").value = "x"; });
    expect(await refusal(() => parseSheetBody(file("cut.xlsx", good.subarray(0, 40))))).toEqual({ message: "unreadable_sheet" });
    expect(await refusal(() => parseSheetBody(file("empty.xlsx", "")))).toEqual({ message: "unreadable_sheet" });
  });

  it("the extension is matched in any case", async () => {
    const bytes = await xlsx((wb) => { wb.addWorksheet("S").getCell("A1").value = "x"; });
    expect((await parseSheetBody(file("BOOK.XLSX", bytes))).tabs[0].rows).toEqual([["x"]]);
  });
});

/** A zip built by hand, so a test can make one exceljs never would: a bomb, or one that lies about its sizes. `declared` overrides the
 *  uncompressed size the headers state. */
function zip(entries: Array<{ name: string; data: Buffer; deflate?: boolean; declared?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate === false ? e.data : deflateRawSync(e.data);
    const name = Buffer.from(e.name);
    const size = e.declared ?? e.data.length;
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(e.deflate === false ? 0 : 8, 8);
    loc.writeUInt32LE(body.length, 18); loc.writeUInt32LE(size, 22); loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(e.deflate === false ? 0 : 8, 10);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(size, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    centrals.push(cen, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("the zip bomb (an .xlsx is a zip; exceljs unpacks it whole)", () => {
  const over = Buffer.alloc(MAX_XLSX_INFLATED_BYTES + 1024 * 1024); // zeros: deflates to a few KiB

  it("a part that inflates past the budget is 400 sheet_too_large on the file, before exceljs runs", async () => {
    const bomb = zip([{ name: "xl/worksheets/sheet1.xml", data: over }]);
    expect(bomb.length).toBeLessThan(MAX_SHEET_BYTES);
    expect(await refusal(() => parseSheetBody(file("bomb.xlsx", bomb)))).toEqual({ message: "sheet_too_large", field: "file" });
  });

  it("the bound is on what zlib produces, not on what the zip declares", async () => {
    const liar = zip([{ name: "a.xml", data: over, declared: 10 }]);
    expect(await refusal(() => assertZipInflatesWithin(liar, MAX_XLSX_INFLATED_BYTES))).toEqual({ message: "sheet_too_large", field: "file" });
  });

  it("the parts count together: many parts each under the budget still refuse past it", () => {
    const quarter = Buffer.alloc(MAX_XLSX_INFLATED_BYTES / 4 + 1);
    const many = zip([0, 1, 2, 3].map((i) => ({ name: `p${i}.xml`, data: quarter })));
    expect(() => assertZipInflatesWithin(many, MAX_XLSX_INFLATED_BYTES)).toThrow(BadRequestException);
    const three = zip([0, 1, 2].map((i) => ({ name: `p${i}.xml`, data: quarter })));
    expect(() => assertZipInflatesWithin(three, MAX_XLSX_INFLATED_BYTES)).not.toThrow();
  });

  it("a stored (uncompressed) part counts too, and an unknown method is unreadable_sheet", async () => {
    expect(() => assertZipInflatesWithin(zip([{ name: "s.xml", data: Buffer.alloc(100), deflate: false }]), 99)).toThrow(BadRequestException);
    expect(() => assertZipInflatesWithin(zip([{ name: "s.xml", data: Buffer.alloc(100), deflate: false }]), 100)).not.toThrow();
    const odd = zip([{ name: "a.xml", data: Buffer.from("x") }]);
    odd.writeUInt16LE(12, odd.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10); // bzip2 in the central directory
    expect(await refusal(() => assertZipInflatesWithin(odd, 1000))).toEqual({ message: "unreadable_sheet" });
  });

  it("a real workbook passes, and still reads", async () => {
    const bytes = await xlsx((wb) => { wb.addWorksheet("S").getCell("A1").value = "x"; });
    expect(() => assertZipInflatesWithin(bytes, MAX_XLSX_INFLATED_BYTES)).not.toThrow();
    expect((await parseSheetBody(file("ok.xlsx", bytes))).tabs[0].rows).toEqual([["x"]]);
  });
});

describe("a .csv", () => {
  it("one tab named after the file without its extension, RFC 4180 quoting kept", async () => {
    const csv = 'Client,Note\r\n"Mock Bakery, Bali","He said ""hi"""\r\nDemo Studio,"two\nlines"\r\n';
    const { tabs } = await parseSheetBody(file("Clients 2026.csv", csv));
    expect(tabs).toEqual([{ name: "Clients 2026", rows: [["Client", "Note"], ["Mock Bakery, Bali", 'He said "hi"'], ["Demo Studio", "two\nlines"]] }]);
  });

  it("a path in the filename is dropped from the tab name", async () => {
    expect((await parseSheetBody(file("C:\\Users\\mock\\Plan.csv", "a\n1"))).tabs[0].name).toBe("Plan");
    expect((await parseSheetBody(file("exports/plan.CSV", "a\n1"))).tabs[0].name).toBe("plan");
  });

  it("a BOM is dropped", () => {
    expect(tabsFromCsv("\uFEFFa,b\n1,2\n", "x")[0].rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("the separator is , or ;, whichever the first line holds more of", () => {
    expect(tabsFromCsv("a;b;c\n1;2;3\n", "x")[0].rows).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
    expect(tabsFromCsv("a,b;c\n1,2;3\n", "x")[0].rows).toEqual([["a", "b;c"], ["1", "2;3"]]); // a tie is a comma
    expect(tabsFromCsv("a,b,c;d\n", "x")[0].rows).toEqual([["a", "b", "c;d"]]);
    // A separator inside a quoted header does not vote.
    expect(tabsFromCsv('"a,b,c,d";e\n1;2\n', "x")[0].rows).toEqual([["a,b,c,d", "e"], ["1", "2"]]);
    // A ; inside a quoted cell of a comma file stays text.
    expect(tabsFromCsv('a,b\n"x;y",z\n', "x")[0].rows).toEqual([["a", "b"], ["x;y", "z"]]);
  });

  it("trailing empty rows and columns are trimmed, the table is made rectangular", () => {
    expect(tabsFromCsv("a,b,,\n1,,,\n,,,\n\n", "x")[0].rows).toEqual([["a", "b"], ["1", ""]]);
    expect(tabsFromCsv("a\n1,2,3\n", "x")[0].rows).toEqual([["a", "", ""], ["1", "2", "3"]]);
    expect(tabsFromCsv("", "x")[0].rows).toEqual([]);
  });

  it("the limits: 2,000 rows and 60 columns pass, one more does not; a cell of 5,001 characters does not", () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`).join("\n");
    expect(tabsFromCsv(rows(2000), "x")[0].rows).toHaveLength(2000);
    expect(() => tabsFromCsv(rows(2001), "x")).toThrow(BadRequestException);
    const cols = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`).join(",");
    expect(tabsFromCsv(cols(60), "x")[0].rows[0]).toHaveLength(60);
    expect(() => tabsFromCsv(cols(61), "x")).toThrow(BadRequestException);
    expect(tabsFromCsv("x".repeat(5000), "x")[0].rows[0][0]).toHaveLength(5000);
    expect(() => tabsFromCsv("x".repeat(5001), "x")).toThrow(BadRequestException);
  });

  it("an unterminated quote is 400 unreadable_sheet", async () => {
    expect(await refusal(() => parseSheetBody(file("q.csv", 'a,"b\n1,2')))).toEqual({ message: "unreadable_sheet" });
  });
});

describe("pasted text", () => {
  it("one tab named Pasted; tab-separated when the first line holds a tab", async () => {
    const { tabs } = await parseSheetBody({ text: "Client\tPosts\nMock Bakery\t12\nDemo Studio\t8\n" });
    expect(tabs).toEqual([{ name: "Pasted", rows: [["Client", "Posts"], ["Mock Bakery", "12"], ["Demo Studio", "8"]] }]);
  });

  it("a quoted cell keeps its newlines and its tabs: what Google Sheets puts on the clipboard", () => {
    const text = 'Client\tCaption\r\nMock Bakery\t"Line one\nLine two\twith a tab"\r\nDemo Studio\t"say ""hi"""\r\n';
    expect(tabsFromPaste(text)[0].rows).toEqual([["Client", "Caption"], ["Mock Bakery", "Line one\nLine two\twith a tab"], ["Demo Studio", 'say "hi"']]);
  });

  it("with no tab in the first line it follows the csv rule", () => {
    expect(tabsFromPaste("a,b\n1,2")[0].rows).toEqual([["a", "b"], ["1", "2"]]);
    expect(tabsFromPaste("a;b\n1;2")[0].rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("a tab in a LATER line does not make the paste tab-separated", () => {
    expect(tabsFromPaste("a,b\n1\t2,3")[0].rows).toEqual([["a", "b"], ["1\t2", "3"]]);
  });

  it("a quoted first header containing a tab is not a separator", () => {
    expect(tabsFromPaste('"a\tb",c\n1,2')[0].rows).toEqual([["a\tb", "c"], ["1", "2"]]);
  });

  it("keeps empty cells between tabs", () => {
    expect(tabsFromPaste("a\t\tc\n1\t2\t3")[0].rows).toEqual([["a", "", "c"], ["1", "2", "3"]]);
  });

  it("an unterminated quote is 400 unreadable_sheet", async () => {
    expect(await refusal(() => parseSheetBody({ text: 'a\t"b\n1\t2' }))).toEqual({ message: "unreadable_sheet" });
  });
});

describe("the body", () => {
  it("400 invalid_field body when neither a file nor text is given, or both, or the body is not an object", async () => {
    expect(await refusal(() => parseSheetBody({}))).toEqual({ message: "invalid_field", field: "body" });
    expect(await refusal(() => parseSheetBody(null))).toEqual({ message: "invalid_field", field: "body" });
    expect(await refusal(() => parseSheetBody([]))).toEqual({ message: "invalid_field", field: "body" });
    expect(await refusal(() => parseSheetBody({ ...file("a.csv", "a"), text: "a" }))).toEqual({ message: "invalid_field", field: "body" });
    expect(await refusal(() => parseSheetBody({ filename: "a.csv" }))).toMatchObject({ field: "contentBase64" });
    expect(await refusal(() => parseSheetBody({ contentBase64: "YQ==" }))).toMatchObject({ field: "filename" });
  });

  it("400 invalid_field filename for any other extension, or none", async () => {
    for (const name of ["plan.xls", "plan.txt", "plan.xlsx.exe", "plan", "plan.csv.zip", ""]) {
      expect(await refusal(() => parseSheetBody({ filename: name, contentBase64: "YQ==" })), name).toEqual({ message: "invalid_field", field: "filename" });
    }
    expect(await refusal(() => parseSheetBody({ filename: 5, contentBase64: "YQ==" }))).toEqual({ message: "invalid_field", field: "filename" });
  });

  it("400 invalid_field contentBase64 when it is not base64, or decodes over 2 MiB", async () => {
    for (const bad of ["not base64!", "YQ=", "a", "YQ==YQ==", 12 as unknown as string]) {
      expect(await refusal(() => parseSheetBody({ filename: "a.csv", contentBase64: bad })), String(bad)).toEqual({ message: "invalid_field", field: "contentBase64" });
    }
    // Exactly 2 MiB is accepted by the size rule (it then fails as a workbook: these bytes are not a zip); one byte more never gets that far.
    const atLimit = Buffer.alloc(MAX_SHEET_BYTES, 0x61).toString("base64");
    expect(await refusal(() => parseSheetBody({ filename: "a.xlsx", contentBase64: atLimit }))).toEqual({ message: "unreadable_sheet" });
    const over = Buffer.alloc(MAX_SHEET_BYTES + 1, 0x61).toString("base64");
    expect(await refusal(() => parseSheetBody({ filename: "a.xlsx", contentBase64: over }))).toEqual({ message: "invalid_field", field: "contentBase64" });
    expect(await refusal(() => parseSheetBody({ filename: "a.csv", contentBase64: over }))).toEqual({ message: "invalid_field", field: "contentBase64" });
  });

  it("base64 with line breaks is accepted", async () => {
    const wrapped = Buffer.from("a,b\n1,2").toString("base64").replace(/(.{4})/g, "$1\n");
    expect((await parseSheetBody({ filename: "a.csv", contentBase64: wrapped })).tabs[0].rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("400 invalid_field text when it is over 2 MiB as UTF-8 (counted in bytes, not characters), or not a string", async () => {
    expect(await refusal(() => parseSheetBody({ text: "x".repeat(MAX_SHEET_BYTES + 1) }))).toEqual({ message: "invalid_field", field: "text" });
    // 3-byte characters: 700,000 of them are 2.1 MB.
    expect(await refusal(() => parseSheetBody({ text: "\u20ac".repeat(700_000) }))).toEqual({ message: "invalid_field", field: "text" });
    expect(await refusal(() => parseSheetBody({ text: 5 }))).toEqual({ message: "invalid_field", field: "text" });
    expect((await parseSheetBody({ text: "" })).tabs).toEqual([{ name: "Pasted", rows: [] }]);
  });
});
