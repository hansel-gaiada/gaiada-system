// 5a.4: local extraction with REAL fixtures built in-test, plus the day-one guarantee
// extended to every new type (via the worker's scrub-before-persist path).
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import JSZip from "jszip";

const describeMedia = vi.fn(async (_b: Buffer, mime: string) => `[gateway:${mime}]`);
vi.mock("./llm", () => ({
  complete: vi.fn(async () => "ok"),
  describeMedia: (b: Buffer, m: string) => describeMedia(b, m),
}));

import { extractMediaText } from "./extract";
import { scrub } from "./scrub";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function buildDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

function buildXlsx(rows: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Budget");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function buildPdf(text: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length ${text.length + 30}>>stream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 6\ntrailer<</Size 6/Root 1 0 R>>\n%%EOF`,
  );
}

describe("extractMediaText (5a.4)", () => {
  beforeEach(() => describeMedia.mockClear());

  it("docx extracts locally — no Gateway call", async () => {
    const text = await extractMediaText(await buildDocx("Site handover checklist for tower two"), DOCX_MIME);
    expect(text).toContain("Site handover checklist");
    expect(describeMedia).not.toHaveBeenCalled();
  });

  it("xlsx extracts every sheet as labelled CSV locally", async () => {
    const text = await extractMediaText(buildXlsx([["item", "cost"], ["cement", "1200"]]), XLSX_MIME);
    expect(text).toContain("# Sheet: Budget");
    expect(text).toContain("cement,1200");
    expect(describeMedia).not.toHaveBeenCalled();
  });

  it("pdf with a text layer extracts locally — no Gateway call", async () => {
    const withText = await extractMediaText(
      buildPdf("invoice number 88 due friday for the generator service and site cleanup crew"),
      "application/pdf",
    );
    expect(withText).toContain("invoice number 88 due friday");
    expect(describeMedia).not.toHaveBeenCalled();
  });

  it("image-only pdf (no extractable text layer) falls back to Gateway OCR", async () => {
    const imageOnly = await extractMediaText(Buffer.from("%PDF-1.4 garbage-no-text"), "application/pdf");
    expect(imageOnly).toBe("[gateway:application/pdf]");
    expect(describeMedia).toHaveBeenCalledWith(expect.anything(), "application/pdf");
  });

  it("audio and images route to the Gateway chain (whisper-first handled there)", async () => {
    expect(await extractMediaText(Buffer.from("x"), "audio/ogg")).toBe("[gateway:audio/ogg]");
    expect(await extractMediaText(Buffer.from("x"), "image/jpeg")).toBe("[gateway:image/jpeg]");
  });

  it("video without ffmpeg fails with an observable, actionable error", async () => {
    const { ffmpegAvailable } = await import("./extract");
    if (await ffmpegAvailable()) return; // covered by the live path on hosts with ffmpeg
    await expect(extractMediaText(Buffer.from("x"), "video/mp4")).rejects.toThrow(/ffmpeg/);
  });

  it("the day-one guarantee holds for document-derived text (scrub the extraction)", async () => {
    const text = await extractMediaText(
      await buildDocx("pay supplier card 4111 1111 1111 1111 and NIK 3174012345678901"),
      DOCX_MIME,
    );
    const { clean } = scrub(text); // the media worker applies exactly this before persist
    expect(clean).toContain("[REDACTED-CARD]");
    expect(clean).toContain("[REDACTED-ID]");
    expect(clean).not.toContain("4111");
  });
});
