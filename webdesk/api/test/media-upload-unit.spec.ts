// WSK-43a — the pure pieces of the upload surface, no database and no network: image dimensions read from
// untrusted header bytes, the bounded body reader, the filename and content-type cleaners, the token helpers
// and the log-redaction rule for the upload path.
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { readImageDimensions } from "../src/media/image-dimensions";
import { baseContentType, cleanOriginalFilename, readBounded } from "../src/media/media-upload.service";
import { hashUploadToken, isUploadPath, mintUploadToken, UPLOAD_TOKEN_RE, UPLOAD_TOKEN_TTL_SECONDS, uploadPathFor } from "../src/media/media-upload-token";
import { redactPreviewToken } from "../src/delivery/preview-token";
import { canonicalAssetPath } from "../src/media/library-asset";
import { allowedMimesForBucket, UPLOADABLE_MIME_TYPES } from "../src/media/mime-allowlist";
import { buildJpeg, buildPng } from "./media-library-kit";

describe("readImageDimensions (untrusted bytes)", () => {
  it("PNG: IHDR width and height", () => {
    expect(readImageDimensions(buildPng(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    expect(readImageDimensions(buildPng(1, 1), "image/png")).toEqual({ width: 1, height: 1 });
  });

  it("GIF: logical screen width and height (little endian)", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([0x20, 0x03, 0x58, 0x02]), Buffer.alloc(8)]);
    expect(readImageDimensions(gif, "image/gif")).toEqual({ width: 800, height: 600 });
  });

  it("JPEG: walks the segments to the frame header (an APP0 first, a comment, then SOF0 / SOF2)", () => {
    const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0", "ascii"), Buffer.alloc(9)]);
    const com = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x05]), Buffer.from("hi!", "ascii")]);
    const sof = (marker: number) => Buffer.from([0xff, marker, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
    for (const marker of [0xc0, 0xc2]) {
      const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, com, sof(marker), Buffer.from([0xff, 0xd9])]);
      expect(readImageDimensions(jpg, "image/jpeg"), `SOF${marker & 0xf}`).toEqual({ width: 640, height: 480 });
    }
    // DHT (0xc4) is not a frame header: it is skipped, not read as one
    const dht = Buffer.concat([Buffer.from([0xff, 0xc4, 0x00, 0x04, 0x00, 0x00])]);
    expect(readImageDimensions(Buffer.concat([Buffer.from([0xff, 0xd8]), dht, sof(0xc0)]), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });

  it("WebP: lossy (VP8), lossless (VP8L) and extended (VP8X)", () => {
    const riff = (chunk: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from("WEBP", "ascii"), Buffer.from(chunk, "ascii"), Buffer.alloc(4), data]);
      const out = Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), body]);
      out.writeUInt32LE(body.length, 4);
      out.writeUInt32LE(data.length, 16);
      return out;
    };
    const vp8 = Buffer.alloc(10);
    vp8.set([0x9d, 0x01, 0x2a], 3);
    vp8.writeUInt16LE(1024, 6);
    vp8.writeUInt16LE(768, 8);
    expect(readImageDimensions(riff("VP8 ", vp8), "image/webp")).toEqual({ width: 1024, height: 768 });
    const vp8l = Buffer.alloc(5);
    vp8l[0] = 0x2f;
    vp8l.writeUInt32LE((299 & 0x3fff) | ((199 & 0x3fff) << 14), 1); // 300 x 200 (stored minus one)
    expect(readImageDimensions(riff("VP8L", vp8l), "image/webp")).toEqual({ width: 300, height: 200 });
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(1919, 4, 3); // 1920
    vp8x.writeUIntLE(1079, 7, 3); // 1080
    expect(readImageDimensions(riff("VP8X", vp8x), "image/webp")).toEqual({ width: 1920, height: 1080 });
  });

  it("anything that does not parse cleanly is null: truncated, zero, absurd, the wrong format for the sniffed type, a type with no dimensions", () => {
    expect(readImageDimensions(buildPng(640, 480).subarray(0, 20), "image/png")).toBeNull();
    expect(readImageDimensions(buildPng(0, 480), "image/png")).toBeNull();
    expect(readImageDimensions(buildPng(640, 0), "image/png")).toBeNull();
    expect(readImageDimensions(buildPng(4_000_000_000, 10), "image/png")).toBeNull();
    expect(readImageDimensions(buildPng(100_001, 10), "image/png")).toBeNull();
    expect(readImageDimensions(buildPng(100_000, 100_000), "image/png")).toEqual({ width: 100_000, height: 100_000 });
    expect(readImageDimensions(buildPng(10, 10), "image/jpeg")).toBeNull(); // PNG bytes read as the jpeg they are not
    expect(readImageDimensions(buildJpeg(), "image/jpeg")).toBeNull(); // a jpeg with no frame header
    expect(readImageDimensions(buildPng(10, 10), "application/pdf")).toBeNull();
    expect(readImageDimensions(Buffer.alloc(0), "image/png")).toBeNull();
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
  });

  it("NEVER THROWS on hostile input: random buffers, truncated headers and jpeg length fields that point past the end", () => {
    for (const mime of ["image/png", "image/gif", "image/jpeg", "image/webp"]) {
      for (let i = 0; i < 500; i++) {
        const len = Math.floor(Math.random() * 80);
        const b = randomBytes(len);
        expect(() => readImageDimensions(b, mime)).not.toThrow();
        if (len > 12) {
          const jpegish = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff]), b]);
          expect(() => readImageDimensions(jpegish, mime)).not.toThrow();
        }
      }
    }
    // a jpeg whose segment length is 0xffff but the buffer ends: null, not an exception
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0x00]), "image/jpeg")).toBeNull();
  });
});

describe("cleanOriginalFilename / baseContentType", () => {
  it("keeps the last path segment, drops control characters, trims, caps at 255 characters; nothing left is null", () => {
    expect(cleanOriginalFilename("hero.png")).toBe("hero.png");
    expect(cleanOriginalFilename("C:\\Users\\me\\hero.png")).toBe("hero.png");
    expect(cleanOriginalFilename("../../etc/passwd")).toBe("passwd");
    expect(cleanOriginalFilename("  spaced name .png  ")).toBe("spaced name .png");
    expect(cleanOriginalFilename("a\u0000b\u0007c\u007f.png")).toBe("abc.png");
    expect(cleanOriginalFilename("é日本語.png")).toBe("é日本語.png");
    expect(Array.from(cleanOriginalFilename("x".repeat(300)) as string)).toHaveLength(255);
    for (const nothing of ["", "   ", ".", "..", "dir/", undefined, null, 5, ["a"], {}]) expect(cleanOriginalFilename(nothing), JSON.stringify(nothing)).toBeNull();
  });

  it("baseContentType lower-cases and drops parameters", () => {
    expect(baseContentType("image/png")).toBe("image/png");
    expect(baseContentType("IMAGE/PNG; charset=binary")).toBe("image/png");
    expect(baseContentType("  image/jpeg  ;x=y")).toBe("image/jpeg");
    expect(baseContentType("")).toBeNull();
    expect(baseContentType(undefined)).toBeNull();
    expect(baseContentType(";")).toBeNull();
  });
});

describe("readBounded (the body is never held past the cap)", () => {
  const chunks = (n: number, size: number) => Readable.from(Array.from({ length: n }, () => Buffer.alloc(size, 0x61)), { objectMode: false });

  it("reads a body within the cap, exactly at it, and an empty one", async () => {
    expect((await readBounded(chunks(3, 100), 300, 5000)).length).toBe(300);
    expect((await readBounded(chunks(1, 10), 300, 5000)).length).toBe(10);
    expect((await readBounded(Readable.from([]), 300, 5000)).length).toBe(0);
  });

  it("refuses 413 the moment the count passes the cap, and stops pulling", async () => {
    let pulled = 0;
    const src = new Readable({
      read() {
        pulled++;
        this.push(pulled > 20_000 ? null : Buffer.alloc(100, 0x61));
      },
    });
    await expect(readBounded(src, 250, 5000)).rejects.toMatchObject({ status: 413 });
    await new Promise((r) => setTimeout(r, 50));
    // The reader stopped consuming at the cap (a Readable still fills its OWN internal buffer, a few
    // high-water marks' worth, which is why this is not "3"): nowhere near the 20000 chunks (2 MB) offered.
    expect(pulled).toBeLessThan(2000);
  });

  it("a stalled sender is cut off at the deadline (408), and a sender that goes away mid-body is 400", async () => {
    const stalled = new PassThrough();
    stalled.write(Buffer.from("partial"));
    await expect(readBounded(stalled, 1000, 80)).rejects.toMatchObject({ status: 408 });
    const aborted = new PassThrough();
    const p = readBounded(aborted, 1000, 5000);
    aborted.write(Buffer.from("partial"));
    aborted.destroy();
    await expect(p).rejects.toMatchObject({ status: 400 });
  });

  it("a stream error rejects with that error", async () => {
    const s = new PassThrough();
    const p = readBounded(s, 1000, 5000);
    s.destroy(new Error("socket reset"));
    await expect(p).rejects.toThrow(/socket reset/);
  });
});

describe("upload token helpers", () => {
  it("mintUploadToken: 43-char base64url, fresh each time; hashUploadToken: sha256 hex; the TTL is ten minutes", () => {
    const a = mintUploadToken();
    const b = mintUploadToken();
    expect(a).toMatch(UPLOAD_TOKEN_RE);
    expect(a).not.toBe(b);
    expect(hashUploadToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashUploadToken(a)).toBe(hashUploadToken(a));
    expect(hashUploadToken(a)).not.toBe(hashUploadToken(b));
    expect(UPLOAD_TOKEN_TTL_SECONDS).toBe(600);
    for (const bad of ["", "abc", `${a}x`, a.slice(1), `${a.slice(0, 42)}!`, `${a.slice(0, 42)}=`, `${a.slice(0, 41)}/ `]) expect(UPLOAD_TOKEN_RE.test(bad), bad).toBe(false);
  });

  it("uploadPathFor and isUploadPath agree; the canonical asset URL is the media route", () => {
    const token = mintUploadToken();
    const path = uploadPathFor("acme", token);
    expect(path).toBe(`/v1/t/acme/media/upload/${token}`);
    expect(isUploadPath(path)).toBe(true);
    for (const other of ["/v1/t/acme/media/media", "/v1/t/acme/media/upload", "/v1/t/acme/media/upload/", "/v1/t/acme/preview/x", "/control/v1/t/acme/media/upload/x", "/v1/t/acme/media/upload/x/y", "/v1/t//media/upload/x"]) {
      expect(isUploadPath(other), other).toBe(false);
    }
    expect(canonicalAssetPath("acme", "abc")).toBe("/v1/t/acme/media/abc");
  });

  it("the upload path is redacted for logs and problem `instance` (like the preview path); other paths are untouched", () => {
    expect(redactPreviewToken("/v1/t/acme/media/upload/SECRETSECRET")).toBe("/v1/t/acme/media/upload/:token");
    expect(redactPreviewToken("/v1/t/acme/media/upload/SECRETSECRET/")).toBe("/v1/t/acme/media/upload/:token/");
    expect(redactPreviewToken("/v1/t/acme/%6Dedia/%75pload/SECRETSECRET")).toBe("/v1/t/acme/%6Dedia/%75pload/:token"); // encoded segments too
    expect(redactPreviewToken("/v1/t/acme/preview/SECRETSECRET")).toBe("/v1/t/acme/preview/:token"); // the preview rule is intact
    for (const same of ["/v1/t/acme/media/upload", "/v1/t/acme/media/media", "/v1/t/acme/media/abc/transform", "/v1/t/acme/news/upload/x", "/control/v1/tenants/acme/sites/s/media/upload-token"]) {
      expect(redactPreviewToken(same), same).toBe(same);
    }
  });

  it("the parser's media types are exactly the types the public buckets admit", () => {
    expect([...UPLOADABLE_MIME_TYPES].sort()).toEqual([...new Set([...allowedMimesForBucket("media"), ...allowedMimesForBucket("video")])].sort());
    expect(UPLOADABLE_MIME_TYPES).not.toContain("image/svg+xml");
    expect(UPLOADABLE_MIME_TYPES).not.toContain("text/html");
  });
});
