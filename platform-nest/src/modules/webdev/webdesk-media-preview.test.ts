// M5-W1q2 (WSK-D84) -- the pure half of the reviewer's byte preview, in the ERP: the raster allow-list, the signature table and the six
// headers (webdesk-media-preview.ts), and the raw-bytes read of the Zone B client seam (`WebdeskZoneB.readBytes`). No Postgres, no Cerbos,
// no network: runs anywhere. The route and its authorization are webdesk-media-review-preview.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { BadGatewayException, HttpException } from "@nestjs/common";
import {
  PREVIEW_MAX_BYTES,
  PREVIEW_RASTER_MIMES,
  isPreviewRasterMime,
  mediaTypeOf,
  previewHeaders,
  rasterSignatureMatches,
} from "./webdesk-media-preview";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { WebdeskProblem, WebdeskZoneB } from "./webdesk-content.service";
import { EditorialUnavailableError, WebdeskControlTransportError, type WebdeskControlClient, type WebdeskControlRequest, type WebdeskControlResponse } from "./webdesk-control-client";

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

describe("M5-W1q2 the ERP's allow-list, signature table and headers", () => {
  it("the allow-list is exactly the five raster types and the cap is 10 MiB (the same as WebDesk's and the page's)", () => {
    expect([...PREVIEW_RASTER_MIMES]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
    expect(PREVIEW_MAX_BYTES).toBe(10 * 1024 * 1024);
    for (const m of ["image/svg+xml", "text/html", "application/pdf", "video/mp4", "image/*", "IMAGE/PNG", "", "image/png; charset=x"]) {
      expect(isPreviewRasterMime(m), m).toBe(false);
    }
  });

  it("a Content-Type header reduces to its media type, or null", () => {
    expect(mediaTypeOf("image/png")).toBe("image/png");
    expect(mediaTypeOf(" Image/PNG ; charset=binary")).toBe("image/png");
    expect(mediaTypeOf("")).toBeNull();
    expect(mediaTypeOf(null)).toBeNull();
    expect(mediaTypeOf(undefined)).toBeNull();
  });

  it("each type matches its own signature: PNG, JPEG, GIF 87a and 89a, WEBP (RIFF....WEBP), AVIF (ftyp avif and avis)", () => {
    expect(rasterSignatureMatches(png, "image/png")).toBe(true);
    expect(rasterSignatureMatches(jpeg, "image/jpeg")).toBe(true);
    expect(rasterSignatureMatches(gif87, "image/gif")).toBe(true);
    expect(rasterSignatureMatches(gif89, "image/gif")).toBe(true);
    expect(rasterSignatureMatches(webp, "image/webp")).toBe(true);
    expect(rasterSignatureMatches(avif, "image/avif")).toBe(true);
    expect(rasterSignatureMatches(avis, "image/avif")).toBe(true);
  });

  it("a mismatch is refused in every direction: other raster bytes, svg, html, pdf, a wav in a RIFF box, an mp4 as avif", () => {
    const all = { "image/png": png, "image/jpeg": jpeg, "image/gif": gif89, "image/webp": webp, "image/avif": avif };
    for (const mime of Object.keys(all)) {
      for (const [otherMime, bytes] of Object.entries(all)) {
        if (otherMime !== mime) expect(rasterSignatureMatches(bytes, mime), `${otherMime} bytes as ${mime}`).toBe(false);
      }
      for (const [label, bytes] of Object.entries({ svg, html, pdf, wav, mp4 })) {
        expect(rasterSignatureMatches(bytes, mime), `${label} as ${mime}`).toBe(false);
      }
    }
    for (const mime of PREVIEW_RASTER_MIMES) {
      expect(rasterSignatureMatches(Buffer.alloc(0), mime)).toBe(false);
      expect(rasterSignatureMatches(Buffer.from([0x89]), mime)).toBe(false);
    }
    expect(rasterSignatureMatches(png, "image/svg+xml")).toBe(false);
    expect(rasterSignatureMatches(png, "application/pdf")).toBe(false);
  });

  it("the headers are EXACTLY six, with the exact values, and the file name is fixed by the type", () => {
    expect(previewHeaders("image/png")).toEqual({
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Disposition": 'inline; filename="preview.png"',
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    expect(Object.keys(previewHeaders("image/jpeg"))).toHaveLength(6);
    const names: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" };
    for (const [mime, ext] of Object.entries(names)) {
      const h = previewHeaders(mime as (typeof PREVIEW_RASTER_MIMES)[number]);
      expect(h["Content-Type"]).toBe(mime);
      expect(h["Content-Disposition"]).toBe(`inline; filename="preview.${ext}"`);
    }
  });
});

describe("M5-W1q2 WebdeskZoneB.readBytes: the same seam as read(), for a raw-bytes answer", () => {
  const sent: WebdeskControlRequest[] = [];
  const clientOf = (reply: WebdeskControlResponse | Error): WebdeskControlClient =>
    ({
      send: async (req: WebdeskControlRequest) => {
        sent.push(req);
        if (reply instanceof Error) throw reply;
        return reply;
      },
      close: () => undefined,
    }) as unknown as WebdeskControlClient;
  const use = (reply: WebdeskControlResponse | Error) => setWebdeskApprovedCommandDepsForTests({ client: clientOf(reply) });
  const req = { command: "media.reviewPreview", path: "/control/v1/tenants/:tenantSlug/sites/:siteId/media/:assetId/review-preview", params: { tenantSlug: "t", siteId: "s", assetId: "a" } };
  afterEach(() => {
    sent.length = 0;
    setWebdeskApprovedCommandDepsForTests(null);
  });

  it("a 2xx answer returns the bytes exactly as received and the content type; the client is asked with GET and the typed binaryResponse flag, and nothing else", async () => {
    use({ status: 200, contentType: "image/png", json: null, bodyText: "", bodyBytes: png });
    const got = await new WebdeskZoneB().readBytes(req);
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.bytes, png)).toBe(0);
    expect(got.contentType).toBe("image/png");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: "media.reviewPreview", method: "GET", binaryResponse: true, params: req.params });
    expect(sent[0].body).toBeUndefined();
    expect(sent[0].editorialAssertion).toBeUndefined();
    expect(sent[0].ws4).toBeUndefined();
    expect(sent[0].idempotencyKey).toBeUndefined();
  });

  it("a 2xx answer with no byte buffer is a 502, never an empty success", async () => {
    use({ status: 200, contentType: "image/png", json: null, bodyText: "" });
    await expect(new WebdeskZoneB().readBytes(req)).rejects.toBeInstanceOf(BadGatewayException);
  });

  it("a Zone B 4xx problem passes through UNTOUCHED, exactly as read() does (415 and 413 carry their bodies)", async () => {
    const problem = { type: "https://webdesk.gaiada.online/errors/media-preview-unsupported", title: "No preview for this type", status: 415, mime: "image/svg+xml" };
    use({ status: 415, contentType: "application/problem+json", json: problem, bodyText: JSON.stringify(problem) });
    const err = await new WebdeskZoneB().readBytes(req).catch((e) => e);
    expect(err).toBeInstanceOf(WebdeskProblem);
    expect((err as WebdeskProblem).getStatus()).toBe(415);
    expect((err as WebdeskProblem).problem).toEqual(problem);
  });

  it("Zone B refusing OUR credentials (401/403) is a 502, never forwarded as the user's; a 5xx is a 502; a 503 is the typed unavailable", async () => {
    for (const status of [401, 403]) {
      use({ status, contentType: "application/problem+json", json: { type: "https://webdesk.gaiada.online/errors/forbidden", status }, bodyText: "{}" });
      const err = await new WebdeskZoneB().readBytes(req).catch((e) => e);
      expect(err, String(status)).toBeInstanceOf(BadGatewayException);
    }
    use({ status: 500, contentType: "text/plain", json: null, bodyText: "boom" });
    expect(await new WebdeskZoneB().readBytes(req).catch((e) => e)).toBeInstanceOf(BadGatewayException);
    use({ status: 503, contentType: "application/problem+json", json: { type: "https://webdesk.gaiada.online/errors/unavailable", status: 503 }, bodyText: "{}" });
    const unavailable = await new WebdeskZoneB().readBytes(req).catch((e) => e);
    expect(unavailable).toBeInstanceOf(HttpException);
    expect((unavailable as HttpException).getStatus()).toBe(503);
  });

  it("a transport failure maps exactly as read() maps it: unreachable and the open breaker are 503s, no bytes", async () => {
    use(new WebdeskControlTransportError("link died", 3, false, "ECONNRESET"));
    const unreachable = await new WebdeskZoneB().readBytes(req).catch((e) => e);
    expect(unreachable).toBeInstanceOf(HttpException);
    expect((unreachable as HttpException).getStatus()).toBe(503);
    use(new EditorialUnavailableError(10_000));
    const open = await new WebdeskZoneB().readBytes(req).catch((e) => e);
    expect(open).toBeInstanceOf(HttpException);
    expect((open as HttpException).getStatus()).toBe(503);
  });
});
