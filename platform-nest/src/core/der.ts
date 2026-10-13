// PV5-07 — a minimal DER (ASN.1 Distinguished Encoding Rules) writer and reader, for exactly two jobs: the self-issued
// certificate of a company sealing key, and the CAdES SignedData inside a sealed PDF (document-seal.ts).
//
// WHY HAND-WRITTEN AND NOT node-forge (or @signpdf/signer-p12, which wraps it): PAdES baseline (ETSI EN 319 142-1) needs
// the ESS `signing-certificate-v2` signed attribute and forbids the CMS `signing-time` attribute (the time lives in the
// signature dictionary's /M). node-forge's PKCS#7 builder can emit only contentType, messageDigest and signingTime, so a
// forge-built seal would be a plain `adbe.pkcs7.detached` signature, not PAdES. What DER needs is small and fully
// specified (X.690 §8, §10): tag, definite length, content; SET OF sorted by encoding. The cryptography itself is
// Node's own (`node:crypto` sign/verify, X509Certificate). The PDF side (placeholder, byte ranges) is @signpdf's.
//
// Scope, deliberately narrow: single-byte tags (every tag CMS and X.509 need here), definite lengths only (DER forbids
// indefinite), no REAL, no multi-byte tag numbers. The reader refuses anything outside that rather than guessing.

/** A DER element read back: its tag byte, where its content starts and ends in `buf`, and (when constructed) children. */
export interface DerNode {
  tag: number;
  /** Offset of the tag byte. */
  start: number;
  /** Offset of the first content byte. */
  contentStart: number;
  /** Offset one past the last content byte (= one past the element). */
  end: number;
  /** The whole element (tag, length, content), a view into the parsed buffer. */
  raw: Buffer;
  /** The content bytes only. */
  content: Buffer;
  /** Children, for a constructed element (tag bit 0x20). Primitive elements have none. */
  children: DerNode[];
}

// ── writer ───────────────────────────────────────────────────────────────────────────────────────

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | out.length, ...out]);
}

/** One element: tag byte, definite length, content. */
export function tlv(tag: number, content: Buffer): Buffer {
  if (tag < 0 || tag > 0xff || (tag & 0x1f) === 0x1f) throw new Error("der: only single-byte tags are supported");
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

export const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));

/** SET OF, in DER order: elements sorted by their encodings (X.690 §11.6). */
export const setOf = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat([...items].sort(Buffer.compare)));

/** [n] constructed context-specific (EXPLICIT wrapper, or IMPLICIT SET/SEQUENCE of already-encoded members). */
export const ctx = (n: number, ...items: Buffer[]): Buffer => tlv(0xa0 | n, Buffer.concat(items));

export const nul = (): Buffer => Buffer.from([0x05, 0x00]);
export const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const octets = (b: Buffer): Buffer => tlv(0x04, b);
export const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
/** BIT STRING with a leading unused-bits count. */
export const bits = (b: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), b]));

/** INTEGER from a non-negative number or big-endian unsigned bytes, in minimal two's-complement form. */
export function int(v: number | Buffer): Buffer {
  let b: Buffer;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error("der: int() takes a non-negative safe integer");
    const out: number[] = [];
    let n = v;
    do {
      out.unshift(n & 0xff);
      n = Math.floor(n / 256);
    } while (n > 0);
    b = Buffer.from(out);
  } else {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    b = v.subarray(i);
    if (b.length === 0) b = Buffer.from([0]);
  }
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

/** OBJECT IDENTIFIER from dotted form. */
export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map((s) => {
    if (!/^\d+$/.test(s)) throw new Error(`der: bad OID ${dotted}`);
    return Number(s);
  });
  if (arcs.length < 2) throw new Error(`der: bad OID ${dotted}`);
  const out: number[] = [];
  const push = (n: number) => {
    const chunk: number[] = [n & 0x7f];
    let v = Math.floor(n / 128);
    while (v > 0) {
      chunk.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...chunk);
  };
  push(arcs[0] * 40 + arcs[1]);
  for (const a of arcs.slice(2)) push(a);
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime for 1950-2049, GeneralizedTime otherwise (RFC 5280 §4.1.2.5). Always UTC, whole seconds. */
export function time(d: Date): Buffer {
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const y = d.getUTCFullYear();
  const body = iso.slice(5, 7) + iso.slice(8, 10) + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + "Z";
  if (y >= 1950 && y < 2050) return tlv(0x17, Buffer.from(String(y).slice(2) + body, "ascii"));
  return tlv(0x18, Buffer.from(String(y).padStart(4, "0") + body, "ascii"));
}

// ── reader ───────────────────────────────────────────────────────────────────────────────────────

/** Parse ONE element starting at `offset`. Trailing bytes after it are the caller's business (a signature placeholder
 *  is zero-padded after the DER, so `parse(buf).end` is where the real structure stops). */
export function parse(buf: Buffer, offset = 0, depth = 0): DerNode {
  if (depth > 64) throw new Error("der: nesting too deep");
  if (offset + 2 > buf.length) throw new Error("der: truncated element");
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new Error("der: multi-byte tags are not supported");
  let p = offset + 1;
  const first = buf[p++];
  let len: number;
  if (first < 0x80) {
    len = first;
  } else {
    const n = first & 0x7f;
    if (n === 0) throw new Error("der: indefinite length is not DER");
    if (n > 4) throw new Error("der: length too large");
    if (p + n > buf.length) throw new Error("der: truncated length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  const contentStart = p;
  const end = contentStart + len;
  if (end > buf.length) throw new Error("der: element runs past the buffer");
  const node: DerNode = {
    tag,
    start: offset,
    contentStart,
    end,
    raw: buf.subarray(offset, end),
    content: buf.subarray(contentStart, end),
    children: [],
  };
  if (tag & 0x20) {
    let q = contentStart;
    while (q < end) {
      const child = parse(buf, q, depth + 1);
      node.children.push(child);
      q = child.end;
    }
  }
  return node;
}

/** Dotted form of an OBJECT IDENTIFIER node. */
export function readOid(node: DerNode): string {
  if (node.tag !== 0x06) throw new Error("der: not an OID");
  const b = node.content;
  const arcs: number[] = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      if (arcs.length === 0) {
        const a0 = v < 80 ? Math.floor(v / 40) : 2;
        arcs.push(a0, v - a0 * 40);
      } else {
        arcs.push(v);
      }
      v = 0;
    }
  }
  return arcs.join(".");
}

/** The element with the given tag among `node`'s children (the first one), or undefined. */
export function child(node: DerNode, tag: number): DerNode | undefined {
  return node.children.find((c) => c.tag === tag);
}
