// WSK-43a — pixel size of an uploaded image, read from the header bytes already in memory (the upload
// pipeline holds the whole, size-capped buffer). No decoder, no dependency: PNG, GIF, JPEG and WebP each
// carry their width and height in a few fixed bytes, and a library thumbnail grid only needs those two
// numbers. "Cheaply known" is the contract: anything that does not parse cleanly (a truncated header, an
// unknown marker layout, a zero or absurd size) answers null, and the asset simply has no dimensions. This
// reads attacker-controlled bytes, so every read is bounds-checked and nothing here can throw.
//
// It is called AFTER the magic-byte sniff (mime-allowlist.ts), with the sniffed type, so a file never gets
// dimensions parsed as a format it is not.

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Larger than any real image (and larger than Postgres integer would care for): treated as garbage. */
const MAX_DIMENSION = 100_000;

function valid(width: number, height: number): ImageDimensions | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}

function png(b: Buffer): ImageDimensions | null {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4 BE) height(4 BE).
  if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return null;
  return valid(b.readUInt32BE(16), b.readUInt32BE(20));
}

function gif(b: Buffer): ImageDimensions | null {
  // "GIF8?a" then the logical screen: width(2 LE) height(2 LE).
  if (b.length < 10) return null;
  return valid(b.readUInt16LE(6), b.readUInt16LE(8));
}

function jpeg(b: Buffer): ImageDimensions | null {
  // Walk the marker segments until a start-of-frame (SOF0..SOF15 except DHT/JPG/DAC): precision(1)
  // height(2 BE) width(2 BE).
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // markers with no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return valid(b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
    }
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): ImageDimensions | null {
  if (b.length < 21) return null;
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    if (b.length < 30) return null;
    // lossy: frame tag(3) start code 9d 01 2a, then width(2 LE, 14 bits) height(2 LE, 14 bits)
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return valid(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === "VP8L") {
    if (b.length < 25) return null;
    // lossless: signature 0x2f, then 14 bits width-1 and 14 bits height-1, packed little-endian
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return valid((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === "VP8X") {
    if (b.length < 30) return null;
    // extended: canvas width-1 and height-1 as 24-bit little-endian integers
    return valid(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  }
  return null;
}

/** Width and height in pixels of an image of the given SNIFFED mime type, or null when they are not cheaply known. */
export function readImageDimensions(buffer: Buffer, sniffedMime: string): ImageDimensions | null {
  try {
    switch (sniffedMime) {
      case "image/png":
        return png(buffer);
      case "image/gif":
        return gif(buffer);
      case "image/jpeg":
        return jpeg(buffer);
      case "image/webp":
        return webp(buffer);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
