// SCP-2b — the resize behind a design's stored thumbnail (design-thumbs.ts), with no database and no storage: the real
// `sharp` on small generated images. The database half (a thumbnail row, `thumb_file_id`, the reads) is design-thumbs.db.test.ts.
import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import { isThumbnailable, loadSharp, makeThumbnail, thumbName, THUMB_MAX_PX } from "./design-thumbs";

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#336699" } }).png().toBuffer();

describe("SCP-2b · the thumbnail resize", () => {
  it("a large image is shrunk to fit inside 640 x 640, keeping its proportions, and comes out as WebP", async () => {
    const out = await makeThumbnail(await png(2000, 1000));
    expect(out).not.toBeNull();
    const meta = await sharp(out!).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([THUMB_MAX_PX, 320]);
    const tall = await sharp((await makeThumbnail(await png(900, 1800)))!).metadata();
    expect([tall.width, tall.height]).toEqual([320, THUMB_MAX_PX]);
  });

  it("a small image is not enlarged (still re-encoded as WebP)", async () => {
    const meta = await sharp((await makeThumbnail(await png(120, 80)))!).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([120, 80]);
  });

  it("the EXIF orientation is applied: a sideways photo comes out upright", async () => {
    // 200 x 100 pixels stored with orientation 6 (rotate 90 degrees): upright it is 100 x 200.
    const sideways = await sharp({ create: { width: 200, height: 100, channels: 3, background: "#888888" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const meta = await sharp((await makeThumbnail(sideways))!).metadata();
    expect([meta.width, meta.height]).toEqual([100, 200]);
  });

  it("bytes that are not an image throw (the caller counts the design as failed, never crashes)", async () => {
    await expect(makeThumbnail(Buffer.from("this is not an image"))).rejects.toThrow();
  });

  it("a sharp that will not load is caught: no thumbnail, no throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await makeThumbnail(await png(10, 10), async () => null)).toBeNull();
      // And the real loader, when the import itself fails, answers null after one `[scp]` warning.
      vi.doMock("sharp", () => { throw new Error("the native binary is missing"); });
      vi.resetModules();
      const fresh = await import("./design-thumbs");
      expect(await fresh.loadSharp()).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[scp] thumbnails are off"));
    } finally {
      vi.doUnmock("sharp");
      vi.resetModules();
      warn.mockRestore();
    }
  });

  it("the real loader gives the sharp function", async () => {
    expect(typeof (await loadSharp())).toBe("function");
  });

  it("only raster images are thumbnailed: a video, an SVG and a non-image are skipped", () => {
    for (const ct of ["image/png", "image/jpeg", "image/webp", "image/gif", "IMAGE/PNG", "image/png; charset=binary"]) expect(isThumbnailable(ct), ct).toBe(true);
    for (const ct of ["video/mp4", "image/svg+xml", "application/pdf", "", null, undefined]) expect(isThumbnailable(ct), String(ct)).toBe(false);
  });

  it("the thumbnail's name is the design file's name with its extension replaced", () => {
    expect(thumbName("Autumn bouquet.final.jpg")).toBe("Autumn bouquet.final-thumb.webp");
    expect(thumbName("design")).toBe("design-thumb.webp");
    expect(thumbName("")).toBe("design-thumb.webp");
    expect(thumbName(null)).toBe("design-thumb.webp");
    expect(thumbName("a/b\\c.png")).toBe("a_b_c-thumb.webp");
  });
});
