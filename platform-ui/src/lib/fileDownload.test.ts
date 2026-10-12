import { describe, it, expect } from "vitest";
import { downloadHeaders, fileDownloadHref, fileRefusalMessage, isPlausibleFileId } from "./fileDownload";

describe("fileDownload", () => {
  it("the href is the UI's own route, with the id encoded", () => {
    expect(fileDownloadHref("abc-123")).toBe("/api/files/abc-123");
    expect(fileDownloadHref("a/b")).toBe("/api/files/a%2Fb");
  });

  it("only plain tokens are plausible file ids", () => {
    expect(isPlausibleFileId("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    for (const bad of ["", "..", "a/b", "a b", "a.b", "a?b", "x".repeat(65)]) expect(isPlausibleFileId(bad)).toBe(false);
  });

  it("🔴 downloadHeaders forces attachment and nosniff whatever the upstream says, and never copies unknown headers", () => {
    const h = downloadHeaders(new Headers({ "content-type": "text/html", "content-disposition": "inline", "x-storage-url": "s3://bucket/key", "set-cookie": "a=b" }));
    expect(h["content-disposition"]).toMatch(/^attachment/);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toMatch(/sandbox/);
    expect(Object.keys(h)).not.toContain("x-storage-url");
    expect(Object.keys(h)).not.toContain("set-cookie");
  });

  it("keeps the platform's attachment filename, and falls back to a safe default content type", () => {
    const h = downloadHeaders(new Headers({ "content-disposition": `attachment; filename="MSA.pdf"` }));
    expect(h["content-disposition"]).toBe(`attachment; filename="MSA.pdf"`);
    expect(h["content-type"]).toBe("application/octet-stream");
  });

  it("every refusal status has a sentence", () => {
    for (const s of [400, 401, 403, 404, 500, 502]) expect(fileRefusalMessage(s).length).toBeGreaterThan(20);
  });
});
