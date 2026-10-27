// M5-W1q2 (WSK-D84) -- the pure half of the reviewer's byte preview: the raster allow-list, the size cap and the signature table
// (src/control/content/media-review-preview.ts). No database, no storage: runs anywhere. The route itself is test/media-review-preview.spec.ts.
import { describe, expect, it } from "vitest";
import { isPreviewRasterMime, PREVIEW_MAX_BYTES, PREVIEW_RASTER_MIMES, rasterSignatureMatches } from "../src/control/content/media-review-preview";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const gif87 = Buffer.concat([Buffer.from("GIF87a", "latin1"), Buffer.alloc(16)]);
const gif89 = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBP", "latin1"), Buffer.alloc(16)]);
const wav = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([1, 0, 0, 0]), Buffer.from("WAVE", "latin1"), Buffer.alloc(16)]);
const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif", "latin1"), Buffer.alloc(16)]);
const avis = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavis", "latin1"), Buffer.alloc(16)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(16)]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const html = Buffer.from("<!doctype html><script>alert(1)</script>");
const pdf = Buffer.from("%PDF-1.4\n...");

describe("M5-W1q2 the preview's allow-list, cap and signature table", () => {
  it("the allow-list is exactly the five raster types, and the cap is 10 MiB", () => {
    expect([...PREVIEW_RASTER_MIMES]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
    expect(PREVIEW_MAX_BYTES).toBe(10 * 1024 * 1024);
    for (const m of ["image/svg+xml", "text/html", "application/pdf", "video/mp4", "video/webm", "image/*", "IMAGE/PNG", "", "image/png; charset=x"]) {
      expect(isPreviewRasterMime(m), m).toBe(false);
    }
  });

  it("each type matches its own signature", () => {
    expect(rasterSignatureMatches(png, "image/png")).toBe(true);
    expect(rasterSignatureMatches(jpeg, "image/jpeg")).toBe(true);
    expect(rasterSignatureMatches(gif87, "image/gif")).toBe(true);
    expect(rasterSignatureMatches(gif89, "image/gif")).toBe(true);
    expect(rasterSignatureMatches(webp, "image/webp")).toBe(true);
    expect(rasterSignatureMatches(avif, "image/avif")).toBe(true);
    expect(rasterSignatureMatches(avis, "image/avif")).toBe(true);
  });

  it("a mismatch is refused in every direction: other raster bytes, svg, html, pdf, a wav in a RIFF box, an mp4 for an avif", () => {
    const all = { "image/png": png, "image/jpeg": jpeg, "image/gif": gif89, "image/webp": webp, "image/avif": avif };
    for (const [mime] of Object.entries(all)) {
      for (const [otherMime, bytes] of Object.entries(all)) {
        if (otherMime !== mime) expect(rasterSignatureMatches(bytes, mime), `${otherMime} bytes as ${mime}`).toBe(false);
      }
      for (const [label, bytes] of Object.entries({ svg, html, pdf, wav, mp4 })) {
        expect(rasterSignatureMatches(bytes, mime), `${label} as ${mime}`).toBe(false);
      }
    }
  });

  it("truncated and empty buffers never match, and an unknown mime never matches", () => {
    for (const mime of PREVIEW_RASTER_MIMES) {
      expect(rasterSignatureMatches(Buffer.alloc(0), mime)).toBe(false);
      expect(rasterSignatureMatches(Buffer.from([0x89]), mime)).toBe(false);
    }
    expect(rasterSignatureMatches(png, "image/svg+xml")).toBe(false);
    expect(rasterSignatureMatches(png, "application/pdf")).toBe(false);
  });
});
