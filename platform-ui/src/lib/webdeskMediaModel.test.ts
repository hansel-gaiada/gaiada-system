import { describe, it, expect } from "vitest";
import {
  altFor, assetLabel, bucketFor, checkFileAgainstToken, failureFromMint, failureFromUploadResponse, formatBytes, isUsableUploadUrl,
  MediaShapeError, mediaValueFor, normalizeTags, originOf, parseMediaDeleted, parseMediaList, parseMediaUpdated, parseMediaUsage, parseUploadedAsset,
  parseUploadToken, previewUrl, usageLabel, type MediaAsset,
} from "./webdeskMediaModel";

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  assetId: "11111111-1111-4111-8111-111111111111", url: "/v1/t/gaiada/media/11111111-1111-4111-8111-111111111111", mime: "image/png", sizeBytes: 2048,
  scanStatus: "clean", title: "Hero", alt: { en: "A villa in Ubud", id: "Vila di Ubud" }, tags: ["hero"], originalFilename: "hero.png", width: 1200, height: 800,
  createdBy: "u1", createdAt: "2026-10-11T08:00:00.000Z", updatedAt: "2026-10-11T08:00:00.000Z", deletedAt: null, ...over,
});
const wireAsset = (over: Record<string, unknown> = {}) => ({ ...asset(), bucket: "media", bucketKey: "media/x", ...over });
const PAGE = { cursor: null, hasMore: false, limit: 48 };

describe("parsers: a body that is not the spec'd shape is a MediaShapeError (drift), never data", () => {
  it("reads a list, and the extra WebDesk members (bucketKey, purgeAfter...) are ignored", () => {
    const body = parseMediaList({ assets: [wireAsset({ deletedAt: null, purgeAfter: null, purgedAt: null })], page: PAGE });
    expect(body.assets[0]).toEqual(asset());
    expect(body.page).toEqual(PAGE);
  });

  it("an upload's response has no deletedAt: still an asset, deletedAt null", () => {
    const { deletedAt: _d, ...noDeleted } = wireAsset();
    expect(parseUploadedAsset(noDeleted).deletedAt).toBeNull();
  });

  it.each([
    ["assets is not an array", { assets: {}, page: PAGE }, "media.assets"],
    ["page is missing", { assets: [] }, "media.page"],
    ["an asset lacks its url", { assets: [{ ...wireAsset(), url: undefined }], page: PAGE }, "media.assets[0].url"],
    ["alt is not a locale map of strings", { assets: [wireAsset({ alt: { en: 3 } })], page: PAGE }, "media.assets[0].alt.en"],
    ["sizeBytes is a string", { assets: [wireAsset({ sizeBytes: "2048" })], page: PAGE }, "media.assets[0].sizeBytes"],
  ])("drift: %s", (_n, body, path) => {
    expect(() => parseMediaList(body)).toThrow(MediaShapeError);
    try { parseMediaList(body); } catch (e) { expect((e as MediaShapeError).path).toBe(path); }
  });

  it("a drift message names the path and the type, never the value", () => {
    try { parseMediaList({ assets: [wireAsset({ sizeBytes: "secret-value" })], page: PAGE }); } catch (e) { expect((e as Error).message).not.toContain("secret-value"); }
  });

  it("usage, update and delete bodies", () => {
    const item = { itemId: "i1", collectionKey: "service", locale: "en", slug: "service.seo", in: "live" };
    expect(parseMediaUsage({ assetId: "a", url: "/v1/t/g/media/a", total: 3, items: [item] }).items).toEqual([item]);
    expect(parseMediaUpdated({ asset: wireAsset() }).asset.title).toBe("Hero");
    expect(parseMediaDeleted({ assetId: "a", deletedAt: "2026-10-11T08:00:00.000Z", purgeAfter: "2026-10-12T08:00:00.000Z", alreadyDeleted: false }).purgeAfter).toBe("2026-10-12T08:00:00.000Z");
    expect(() => parseMediaDeleted({ assetId: "a", deletedAt: "x" })).toThrow(MediaShapeError);
  });

  it("an upload token: exactly {uploadUrl, expiresAt, maxBytes, allowedMimes}; an unusable URL is drift and is never echoed", () => {
    const ok = parseUploadToken({ uploadUrl: "https://webdesk.example/v1/t/gaiada/media/upload/TOKEN", expiresAt: "2026-10-11T08:10:00Z", maxBytes: 5242880, allowedMimes: ["image/png"] });
    expect(ok.maxBytes).toBe(5242880);
    for (const bad of ["javascript:alert(1)", "http://evil.example/x", "https://user:pw@h.example/x", "not a url"]) {
      let thrown: unknown = null;
      try { parseUploadToken({ uploadUrl: bad, expiresAt: "t", maxBytes: 1, allowedMimes: [] }); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(MediaShapeError);
      expect((thrown as Error).message).not.toContain(bad);
    }
    expect(isUsableUploadUrl("http://127.0.0.1:3991/v1/t/g/media/upload/T")).toBe(true);
  });
});

describe("the media field's value", () => {
  it("is exactly {url, alt, width, height, mime}, alt being THIS locale's text", () => {
    expect(mediaValueFor(asset(), "en")).toEqual({ url: "/v1/t/gaiada/media/11111111-1111-4111-8111-111111111111", alt: "A villa in Ubud", width: 1200, height: 800, mime: "image/png" });
    expect(mediaValueFor(asset(), "id").alt).toBe("Vila di Ubud");
  });

  it("omits what the asset does not have: no alt for a locale without one (no fallback to another language), no dimensions for a PDF", () => {
    const v = mediaValueFor(asset({ alt: { en: "x" }, width: null, height: null, mime: "application/pdf" }), "id");
    expect(v).toEqual({ url: "/v1/t/gaiada/media/11111111-1111-4111-8111-111111111111", mime: "application/pdf" });
    expect("alt" in v).toBe(false);
    expect(Object.keys(mediaValueFor(asset({ alt: { en: "   " } }), "en"))).toEqual(["url", "width", "height", "mime"]);
  });

  it("helpers", () => {
    expect(altFor(asset(), "fr")).toBe("");
    expect(assetLabel(asset({ title: null }))).toBe("hero.png");
    expect(assetLabel(asset({ title: null, originalFilename: null }))).toBe("Asset 11111111");
    expect(formatBytes(512)).toBe("512 B"); expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(usageLabel("head")).toBe("Draft"); expect(usageLabel("live")).toBe("Live"); expect(usageLabel("scheduled")).toBe("Scheduled swap");
    expect(bucketFor("video/mp4")).toBe("video"); expect(bucketFor("image/png")).toBe("media");
    expect(normalizeTags(" Hero,  big  Image ,hero,,")).toEqual(["hero", "big image"]);
    expect(originOf("https://w.example/v1/t/g/media/upload/SECRET?x=1")).toBe("https://w.example");
  });

  it("previews need a base and an image; otherwise there is none (a tile, not a broken image)", () => {
    expect(previewUrl("https://w.example/", asset())).toBe("https://w.example/v1/t/gaiada/media/11111111-1111-4111-8111-111111111111");
    expect(previewUrl(null, asset())).toBeNull();
    expect(previewUrl("https://w.example", asset({ mime: "application/pdf" }))).toBeNull();
  });
});

describe("an upload refusal is told in plain words, by status and message (the public route has no problem slugs)", () => {
  const f = (status: number, message?: string, ctx = {}) => failureFromUploadResponse(status, message === undefined ? null : { statusCode: status, message }, ctx);

  it.each([
    [413, undefined, "too_large"],
    [415, "content-type 'image/svg+xml' is not allowed for this upload token", "type_not_allowed"],
    [400, "content-type 'x' is not allowed for bucket 'media'", "type_not_allowed"],
    [400, "declared content-type 'image/png' does not match the file's actual signature (unrecognized)", "type_mismatch"],
    [400, "empty upload", "empty"],
    [400, "upload exceeds the 5242880-byte limit (6000000 bytes)", "too_large"],
    [403, "upload refused: malware scan matched 'Eicar-Test-Signature'", "infected"],
    [403, "tenant storage quota exceeded", "quota"],
    [503, "malware scan unavailable - upload refused: Error", "scan_unavailable"],
    [503, "too many uploads are in progress; retry shortly", "busy"],
    [404, undefined, "token_expired"],
    [408, "the upload did not arrive in time", "timeout"],
    [500, "boom", "failed"],
  ])("HTTP %i %s -> %s", (status, message, kind) => {
    const out = f(status, message, { maxBytes: 5 * 1024 * 1024 });
    expect(out.kind).toBe(kind);
    expect(out.title.length).toBeGreaterThan(5);
    expect(JSON.stringify(out)).not.toMatch(/statusCode|TOKEN/);
  });

  it("too large names the limit; infected says it was not added; a spent token says retrying asks for a fresh one", () => {
    expect(f(413, undefined, { maxBytes: 5 * 1024 * 1024 }).detail).toBe("The limit is 5.0 MB.");
    expect(f(403, "upload refused: malware scan matched 'X'").detail).toContain("not added");
    expect(f(404).detail).toContain("fresh");
  });

  it("no answer at all (status 0): 'uploads aren't enabled for this site yet' with the operator's fix, or 'offline' when the browser is offline", () => {
    const a = f(0);
    expect(a.kind).toBe("not_enabled");
    expect(a.title).toBe("Uploads aren't enabled for this site yet.");
    expect(a.detail).toContain("WEBDESK_UPLOAD_CORS_ORIGINS");
    expect(f(0, undefined, { online: false }).kind).toBe("offline");
  });

  it("the mint's refusals: 403, public URL not configured, unavailable, drift", () => {
    expect(failureFromMint({ kind: "forbidden", reason: "no" }).kind).toBe("forbidden");
    const ne = failureFromMint({ kind: "unavailable", code: "editorial_unavailable", reason: "webdesk_public_url_not_configured" });
    expect(ne.kind).toBe("not_enabled"); expect(ne.title).toBe("Uploads aren't enabled for this site yet."); expect(ne.detail).toContain("WEBDESK_PUBLIC_BASE_URL");
    expect(failureFromMint({ kind: "unavailable", code: "editorial_unavailable", reason: "circuit_open" }).kind).toBe("unavailable");
    expect(failureFromMint({ kind: "unavailable", code: "contract_drift", reason: "upload-token.maxBytes: expected integer" }).kind).toBe("drift");
  });

  it("a file is checked against the token BEFORE any bytes are sent: empty, type, size", () => {
    const token = { maxBytes: 1000, allowedMimes: ["image/png", "application/pdf"] };
    expect(checkFileAgainstToken({ name: "a.png", type: "image/png", size: 500 }, token)).toBeNull();
    expect(checkFileAgainstToken({ name: "a.png", type: "image/png", size: 0 }, token)?.kind).toBe("empty");
    expect(checkFileAgainstToken({ name: "a.svg", type: "image/svg+xml", size: 10 }, token)).toMatchObject({ kind: "type_not_allowed", detail: expect.stringContaining("PNG image, PDF") });
    expect(checkFileAgainstToken({ name: "a", type: "", size: 10 }, token)?.detail).toContain("type is unknown");
    expect(checkFileAgainstToken({ name: "a.png", type: "image/png", size: 5000 }, token)).toMatchObject({ kind: "too_large", detail: "The limit is 1000 B." });
  });
});
