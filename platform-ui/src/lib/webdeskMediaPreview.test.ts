import { describe, it, expect } from "vitest";
import { isPreviewableMime, mediaTypeOf, noPreviewCopy, PREVIEW_RASTER_MIMES, previewHref, previewRefusalMessage, previewResponseHeaders } from "./webdeskMediaPreview";

// M5-W1q2 (WSK-D84): the pure parts of the reviewer's preview. The allow-list and the six headers are the same as the platform's
// (platform-nest webdesk-media-preview.ts) and WebDesk's; a change to one is a change to all three.
describe("the preview allow-list", () => {
  it("is exactly the five raster types; everything else (svg, html, pdf, video, a lookalike, a different case) is not previewable", () => {
    expect([...PREVIEW_RASTER_MIMES]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
    for (const m of PREVIEW_RASTER_MIMES) expect(isPreviewableMime(m)).toBe(true);
    for (const m of ["image/svg+xml", "text/html", "application/pdf", "video/mp4", "image/x-icon", "image/*", "IMAGE/PNG", "image/png; charset=x", "", null, undefined]) {
      expect(isPreviewableMime(m as string), String(m)).toBe(false);
    }
  });

  it("reduces a Content-Type header to its media type", () => {
    expect(mediaTypeOf("Image/PNG; charset=binary")).toBe("image/png");
    expect(mediaTypeOf("")).toBeNull();
    expect(mediaTypeOf(null)).toBeNull();
  });
});

describe("the six response headers", () => {
  it("are exactly six, with exact values, and the file name is fixed by the type", () => {
    expect(previewResponseHeaders("image/png")).toEqual({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "content-disposition": 'inline; filename="preview.png"',
      "cache-control": "private, no-store",
      "cross-origin-resource-policy": "same-origin",
    });
    const ext: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
    for (const m of PREVIEW_RASTER_MIMES) {
      const h = previewResponseHeaders(m);
      expect(Object.keys(h)).toHaveLength(6);
      expect(h["content-disposition"]).toBe(`inline; filename="preview.${ext[m]}"`);
      expect(h["content-disposition"]).not.toMatch(/attachment/);
    }
  });
});

describe("the links and the words", () => {
  it("builds the pass-through href with every segment encoded", () => {
    expect(previewHref({ tenantSlug: "gaiada", siteId: "s-1" }, "a-1")).toBe("/api/webdesk-media-preview/gaiada/s-1/a-1");
    expect(previewHref({ tenantSlug: "a/b", siteId: "c?d", }, "e f")).toBe("/api/webdesk-media-preview/a%2Fb/c%3Fd/e%20f");
  });

  it("says 'No preview for <mime>' and gives every refusal status a sentence", () => {
    expect(noPreviewCopy("image/svg+xml")).toBe("No preview for image/svg+xml");
    for (const s of [400, 401, 403, 404, 413, 415, 502]) expect(previewRefusalMessage(s).length).toBeGreaterThan(15);
  });
});
