// SCP-6b1 (BFF §63.23.9): an `.xlsx` with its pictures left out, made in the browser before upload.
//
// WHY. The team's monthly file has every design pasted over the cells, so it weighs over a hundred MB, while the import reads text only. An `.xlsx` is a
// zip; the pictures are the entries under `xl/media/`. Dropping them leaves a file of a few hundred KB, which is what the server's 2 MiB cap and
// zip-bomb check (`sheet-parse.ts`) are then asked to read. The drawings that still point at a missing picture are ignored by the server's reader.
//
// HOW, WITHOUT INFLATING ANYTHING. Each kept entry is copied verbatim, from its local header up to the next local header (so its data and any data
// descriptor come along), then a new central directory with corrected offsets and a new end-of-central-directory record are written. ZIP64 and a
// malformed zip throw: the page then says it cannot read the file.

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const MEDIA_PREFIX = "xl/media/";

/** Thrown for a zip this code will not (ZIP64) or cannot (malformed) rewrite. */
export class XlsxStripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxStripError";
  }
}

const bad = (why: string): never => {
  throw new XlsxStripError(why);
};

interface Entry {
  name: string;
  /** Offset of the entry's local header in the source. */
  local: number;
  /** The entry's central-directory record, copied as it is (its offset is patched on output). */
  central: Uint8Array;
}

/** `bytes` without the entries under `xl/media/`. Pure; throws `XlsxStripError` for ZIP64 or a zip it cannot read. */
export function stripXlsxMedia(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  if (len < 22) return bad("not a zip");

  // The end-of-central-directory record: 22 bytes, then a comment of at most 65,535 bytes.
  let eocd = -1;
  for (let i = len - 22; i >= Math.max(0, len - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return bad("no end of central directory");
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIG) return bad("zip64");
  const entryCount = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return bad("zip64");
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) return bad("a zip in several parts");
  if (cdOffset + cdSize > eocd) return bad("central directory out of range");

  const decoder = new TextDecoder("utf-8");
  const entries: Entry[] = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== CEN_SIG) return bad("bad central directory entry");
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const total = 46 + nameLen + extraLen + commentLen;
    if (p + total > cdOffset + cdSize) return bad("bad central directory entry");
    const local = view.getUint32(p + 42, true);
    if (local === 0xffffffff) return bad("zip64");
    if (local + 30 > cdOffset || view.getUint32(local, true) !== LOC_SIG) return bad("bad local header");
    entries.push({ name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)), local, central: bytes.subarray(p, p + total) });
    p += total;
  }

  // Each entry's bytes run from its local header to the next local header (the last one to the central directory).
  const order = [...entries].sort((a, b) => a.local - b.local);
  const ends = new Map<Entry, number>();
  order.forEach((e, i) => {
    const end = i + 1 < order.length ? order[i + 1].local : cdOffset;
    if (end <= e.local) bad("overlapping entries");
    ends.set(e, end);
  });

  const kept = entries.filter((e) => !e.name.startsWith(MEDIA_PREFIX));
  let total = 22;
  for (const e of kept) total += ends.get(e)! - e.local + e.central.length;
  if (total >= 0xffffffff) return bad("too large");

  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  let at = 0;
  const newLocal = new Map<Entry, number>();
  for (const e of kept) {
    newLocal.set(e, at);
    out.set(bytes.subarray(e.local, ends.get(e)!), at);
    at += ends.get(e)! - e.local;
  }
  const newCdOffset = at;
  for (const e of kept) {
    out.set(e.central, at);
    outView.setUint32(at + 42, newLocal.get(e)!, true);
    at += e.central.length;
  }
  outView.setUint32(at, EOCD_SIG, true);
  outView.setUint16(at + 8, kept.length, true);
  outView.setUint16(at + 10, kept.length, true);
  outView.setUint32(at + 12, at - newCdOffset, true);
  outView.setUint32(at + 16, newCdOffset, true);
  return out;
}
