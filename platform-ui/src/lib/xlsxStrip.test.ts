// SCP-6b1 — `stripXlsxMedia`: the pictures of an .xlsx left out in the browser (BFF §63.23.9). The zips are built here, entry by entry: stored and deflated
// entries, one with the data-descriptor flag, a comment after the end record. A minimal reader (the central directory, then inflate) checks the result.
import { describe, it, expect } from "vitest";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { stripXlsxMedia, XlsxStripError } from "./xlsxStrip";

const te = new TextEncoder();
const td = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Spec { name: string; data: Uint8Array; deflate?: boolean; descriptor?: boolean }

function u16(n: number): number[] { return [n & 255, (n >> 8) & 255]; }
function u32(n: number): number[] { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }

function makeZip(specs: Spec[], comment = ""): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  for (const s of specs) {
    const offset = parts.length;
    const body = s.deflate ? new Uint8Array(deflateRawSync(s.data)) : s.data;
    const name = [...te.encode(s.name)];
    const crc = crc32(s.data);
    const flags = s.descriptor ? 0x0008 : 0;
    const method = s.deflate ? 8 : 0;
    // With a data descriptor the local header carries zeros and the real numbers follow the data.
    parts.push(...u32(0x04034b50), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0),
      ...u32(s.descriptor ? 0 : crc), ...u32(s.descriptor ? 0 : body.length), ...u32(s.descriptor ? 0 : s.data.length), ...u16(name.length), ...u16(0), ...name, ...body);
    if (s.descriptor) parts.push(...u32(0x08074b50), ...u32(crc), ...u32(body.length), ...u32(s.data.length));
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(flags), ...u16(method), ...u16(0), ...u16(0), ...u32(crc), ...u32(body.length), ...u32(s.data.length),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  const cdOffset = parts.length;
  const c = [...te.encode(comment)];
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(specs.length), ...u16(specs.length), ...u32(central.length), ...u32(cdOffset), ...u16(c.length), ...c];
  return Uint8Array.from([...parts, ...central, ...end]);
}

/** A minimal reader: every entry's name and inflated bytes, through the central directory only. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = zip.length - 22;
  while (eocd >= 0 && v.getUint32(eocd, true) !== 0x06054b50) eocd--;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extra = v.getUint16(p + 30, true);
    const cmt = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = td.decode(zip.subarray(p + 46, p + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw.slice();
    expect(data.length).toBe(usize);
    out.set(name, data);
    p += 46 + nameLen + extra + cmt;
  }
  return out;
}

const bytesOf = (s: string): Uint8Array => te.encode(s);
const sheetXml = "<worksheet>" + "cell ".repeat(200) + "</worksheet>";
const picture = new Uint8Array(5000).map((_, i) => (i * 7) & 255);

const SAMPLE: Spec[] = [
  { name: "[Content_Types].xml", data: bytesOf("<Types/>"), deflate: true },
  { name: "xl/media/image1.png", data: picture },
  { name: "xl/worksheets/sheet1.xml", data: bytesOf(sheetXml), deflate: true, descriptor: true },
  { name: "xl/media/image2.jpeg", data: picture, deflate: true, descriptor: true },
  { name: "xl/workbook.xml", data: bytesOf("<workbook/>") },
  { name: "xl/drawings/drawing1.xml", data: bytesOf("<xdr/>"), deflate: true },
];

describe("stripXlsxMedia", () => {
  it("drops every entry under xl/media/ and keeps the others, name and bytes, deflated, stored or with a data descriptor", () => {
    const out = stripXlsxMedia(makeZip(SAMPLE));
    const files = readZip(out);
    expect([...files.keys()]).toEqual(["[Content_Types].xml", "xl/worksheets/sheet1.xml", "xl/workbook.xml", "xl/drawings/drawing1.xml"]);
    expect(td.decode(files.get("xl/worksheets/sheet1.xml"))).toBe(sheetXml);
    expect(td.decode(files.get("xl/workbook.xml"))).toBe("<workbook/>");
    expect(td.decode(files.get("[Content_Types].xml"))).toBe("<Types/>");
    expect(out.length).toBeLessThan(makeZip(SAMPLE).length - 5000);
  });

  it("copies a kept entry byte for byte, its data descriptor included, without inflating it", () => {
    const out = stripXlsxMedia(makeZip(SAMPLE));
    const sheet = makeZip([SAMPLE[2]]);
    // The entry's local header + data + descriptor is a prefix of its own one-entry zip, and appears verbatim in the result.
    const localAndData = sheet.subarray(0, indexOfCentral(sheet));
    expect(contains(out, localAndData)).toBe(true);
  });

  it("answers a valid zip when nothing is left, when nothing is dropped, and when a comment follows the end record", () => {
    const only = stripXlsxMedia(makeZip([{ name: "xl/media/a.png", data: picture }]));
    expect(readZip(only).size).toBe(0);
    const none = stripXlsxMedia(makeZip([{ name: "a.xml", data: bytesOf("<a/>"), deflate: true }]));
    expect(td.decode(readZip(none).get("a.xml"))).toBe("<a/>");
    const commented = stripXlsxMedia(makeZip(SAMPLE, "made by a test"));
    expect(readZip(commented).size).toBe(4);
  });

  it("does not touch a name that merely contains media", () => {
    const out = stripXlsxMedia(makeZip([{ name: "xl/mediate.xml", data: bytesOf("<m/>") }, { name: "docProps/xl/media/x.png", data: picture }]));
    expect([...readZip(out).keys()]).toEqual(["xl/mediate.xml", "docProps/xl/media/x.png"]);
  });

  it("refuses what is not a zip, a truncated zip and a ZIP64 one", () => {
    expect(() => stripXlsxMedia(bytesOf("this is not a zip file at all, just text"))).toThrow(XlsxStripError);
    expect(() => stripXlsxMedia(new Uint8Array(3))).toThrow(XlsxStripError);
    const zip = makeZip(SAMPLE);
    expect(() => stripXlsxMedia(zip.subarray(0, zip.length - 30))).toThrow(XlsxStripError);
    const z64 = makeZip(SAMPLE);
    new DataView(z64.buffer).setUint16(z64.length - 22 + 10, 0xffff, true); // the entry count
    expect(() => stripXlsxMedia(z64)).toThrow(/zip64/);
  });
});

function indexOfCentral(zip: Uint8Array): number {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i < zip.length - 4; i++) if (v.getUint32(i, true) === 0x02014b50) return i;
  return -1;
}

function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
