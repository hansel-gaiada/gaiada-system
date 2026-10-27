// M5-W1q2 (owner ruling WSK-D84, approved 2026-10-27) -- the reviewer's BYTE PREVIEW of a quarantined upload, WebDesk half:
// `GET /control/v1/tenants/:t/sites/:s/media/:assetId/review-preview` (command media.reviewPreview, read / webdesk:read).
// Real Postgres (migrations through 0020), real RustFS, real ClamAV, the real AppModule with the REAL Layer-3/4 PDP
// (content-test-kit.ts). Needs the Linux gate (webdesk/qa/linux-gate.sh) or the CI `webdesk-api` job.
//
// The route returns the bytes of an unaccepted asset, so what it may return is a closed list, and each wall is proven beside a
// positive control that sends the SAME request and succeeds:
//   bytes     a quarantined, clean, undeleted PNG on the named site: 200, the exact bytes, the stored mime, nosniff, no-store
//   404       one shape (problem media-asset-not-found, the same body) for: unknown id, malformed id, another site, another
//             tenant's asset under this tenant's slug, accepted, rejected, deleted, scan pending, scan not clean
//   415       a quarantined clean asset of a type that is never previewed (svg, pdf), with only {mime}; bytes that do not bear the
//             stored raster mime's signature
//   413       over 10 MiB, by the row's size
//   auth      no control principal 401; a token without webdesk:read 403; no editorial principal needed; an unknown query key 400
//   no write  no audit row is written by a preview, and the asset is exactly as it was after one
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, hdr, type ContentFixture } from "./content-test-kit";
import { auditRows, buildJpeg, buildPng, getAsset, mediaBase, mintUploadToken, seedAsset, uploadFile } from "./media-library-kit";
import { MediaService } from "../src/media/media.service";
import { PREVIEW_MAX_BYTES } from "../src/control/content/media-review-preview";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const CONTRIBUTOR = JSON.stringify({ sub: "contrib-1", xc: true });

describe("M5-W1q2 the reviewer's byte preview (WSK-D84)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let other: ContentFixture;

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("w1q2");
    other = await createContentFixture("w1q2-other");
  });
  afterAll(async () => {
    await app?.close();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  const preview = (f: ContentFixture, assetId: string, opts: { scopes?: string[]; qs?: string; noPrincipal?: boolean; site?: ContentFixture } = {}) =>
    app.inject({
      method: "GET",
      url: `/control/v1/tenants/${f.slug}/sites/${(opts.site ?? f).siteId}/media/${assetId}/review-preview${opts.qs ?? ""}`,
      headers: opts.noPrincipal ? {} : hdr({ scopes: opts.scopes, editorial: null, idem: null }),
    });

  /** A contributor's REAL upload through the token route: a quarantined, clean PNG whose bytes are in storage. */
  async function quarantinedPng(f: ContentFixture = fx, png = buildPng(32, 24, 400)) {
    const minted = await mintUploadToken(app, f, { bucket: "media" }, { editorial: CONTRIBUTOR });
    expect(minted.statusCode, minted.body).toBe(201);
    const up = await uploadFile(app, f.slug, minted.json().token, png);
    expect(up.statusCode, up.body).toBe(201);
    expect(up.json().reviewState).toBe("quarantined");
    return { id: up.json().assetId as string, png };
  }

  /** A row that points at real stored bytes of ANY content (a seeded row names an object nobody stored unless told to). */
  async function seedWithBytes(f: ContentFixture, bytes: Buffer, o: Parameters<typeof seedAsset>[1]) {
    const stored = await app.get(MediaService).storeObject(f.tenantId, f.siteId, "media", { filename: "seed.bin", contentType: o?.mime ?? "image/png", buffer: bytes });
    return seedAsset(f, { ...o, objectKey: stored.objectKey, sizeBytes: bytes.length });
  }

  const expectNotFound = (r: { statusCode: number; json: () => any; headers: Record<string, unknown> }, label: string) => {
    expect(r.statusCode, label).toBe(404);
    expect(String(r.headers["content-type"]), label).toMatch(/application\/problem\+json/);
    expect(r.json(), label).toMatchObject({ type: `${PROBLEM}media-asset-not-found`, status: 404 });
  };

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the bytes", () => {
    it("a quarantined clean PNG returns exactly the stored bytes, as image/png, nosniff and never cached", async () => {
      const { id, png } = await quarantinedPng();
      const r = await preview(fx, id);
      expect(r.statusCode, r.body).toBe(200);
      expect(Buffer.compare(r.rawPayload, png)).toBe(0);
      expect(r.headers["content-type"]).toBe("image/png");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.headers["content-length"]).toBe(String(png.length));
    });

    it("an upper-cased id reads the same asset", async () => {
      const { id, png } = await quarantinedPng();
      const r = await preview(fx, id.toUpperCase());
      expect(r.statusCode, r.body).toBe(200);
      expect(Buffer.compare(r.rawPayload, png)).toBe(0);
    });

    it("a preview writes nothing: no audit row, and the asset row is unchanged", async () => {
      const { id } = await quarantinedPng();
      const before = await getAsset(fx, id);
      const auditBefore = (await auditRows(fx)).length;
      expect((await preview(fx, id)).statusCode).toBe(200);
      expect(await getAsset(fx, id)).toEqual(before);
      expect((await auditRows(fx)).length).toBe(auditBefore);
    });

    it("the public routes still refuse the same asset: the preview is a control read, not a way to serve it", async () => {
      const { id } = await quarantinedPng();
      expect((await preview(fx, id)).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/v1/t/${fx.slug}/media/${id}` })).statusCode).toBe(404);
      expect(await app.get(MediaService).getPublicAsset(fx.tenantId, id)).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("404: one shape for every asset that is not a quarantined, clean, undeleted asset of this site", () => {
    it("accepted, rejected, deleted, scan pending, scan not clean, unknown, malformed, another site, another tenant: all the same 404; the positive control is 200", async () => {
      const png = buildPng(16, 16, 300);
      const okRow = await seedWithBytes(fx, png, { reviewState: "quarantined", createdBy: "contrib-1" });
      expect((await preview(fx, okRow.id)).statusCode, "control").toBe(200);

      const accepted = await seedWithBytes(fx, png, { reviewState: "accepted" });
      const rejected = await seedWithBytes(fx, png, { reviewState: "rejected", deleted: { deletedAgo: "1 hour", purgeAfterAgo: "-1 day" } });
      const deletedQuarantined = await seedWithBytes(fx, png, { reviewState: "quarantined", deleted: { deletedAgo: "1 hour", purgeAfterAgo: "-1 day" } });
      const pending = await seedWithBytes(fx, png, { reviewState: "quarantined" });
      const infected = await seedWithBytes(fx, png, { reviewState: "quarantined" });
      await asTenant(fx.tenantId, async (db) => {
        await db.query(`UPDATE media_assets SET scan_status = 'pending' WHERE id = $1`, [pending.id]);
        await db.query(`UPDATE media_assets SET scan_status = 'infected' WHERE id = $1`, [infected.id]);
      });
      const otherSiteId = randomUUID();
      const foreign = await seedWithBytes(other, png, { reviewState: "quarantined" });

      const cases: Array<[string, string]> = [
        ["accepted", accepted.id],
        ["rejected", rejected.id],
        ["deleted (still quarantined)", deletedQuarantined.id],
        ["scan pending", pending.id],
        ["scan infected", infected.id],
        ["unknown id", randomUUID()],
        ["malformed id", "not-a-uuid"],
        ["another tenant's asset under this tenant's slug and site", foreign.id],
      ];
      const shapes = new Set<string>();
      for (const [label, id] of cases) {
        const r = await preview(fx, id);
        expectNotFound(r, label);
        shapes.add(JSON.stringify({ ...r.json(), instance: undefined }));
      }
      expect(shapes.size, "every refusal has byte-for-byte the same body").toBe(1);

      // another SITE: the same tenant's asset asked for under a site id it does not belong to is refused (the site is resolved first:
      // an unknown site is the control plane's site-not-found, itself a 404; the asset never leaves)
      const r = await app.inject({
        method: "GET",
        url: `/control/v1/tenants/${fx.slug}/sites/${otherSiteId}/media/${okRow.id}/review-preview`,
        headers: hdr({ editorial: null, idem: null }),
      });
      expect(r.statusCode).toBe(404);
      expect(Buffer.compare(r.rawPayload, png)).not.toBe(0);
      // and under ANOTHER TENANT's slug with that tenant's own site id: the asset is invisible (RLS), the one 404
      const x = await preview(other, okRow.id);
      expectNotFound(x, "this tenant's asset under another tenant's slug");
    });

    it("a quarantined row whose object is not in storage is the same 404 (a preview never errors with a storage detail)", async () => {
      const ghost = await seedAsset(fx, { reviewState: "quarantined", createdBy: "contrib-1" });
      expectNotFound(await preview(fx, ghost.id), "no object");
    });

    it("a library row in a bucket a quarantined upload never lands in is the same 404", async () => {
      const video = await seedAsset(fx, { reviewState: "quarantined", bucket: "video" });
      expectNotFound(await preview(fx, video.id), "video bucket");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("415 and 413: a quarantined clean asset that is never previewed", () => {
    it("a quarantined SVG and a quarantined PDF are 415 media-preview-unsupported carrying only the mime", async () => {
      for (const mime of ["image/svg+xml", "application/pdf", "text/html", "video/mp4"]) {
        const row = await seedAsset(fx, { mime, reviewState: "quarantined", originalFilename: "secret-name.svg", title: "secret title", createdBy: "contrib-1" });
        const r = await preview(fx, row.id);
        expect(r.statusCode, mime).toBe(415);
        expect(String(r.headers["content-type"]), mime).toMatch(/application\/problem\+json/);
        const body = r.json();
        expect(body, mime).toMatchObject({ type: `${PROBLEM}media-preview-unsupported`, status: 415, mime });
        // nothing else about the asset is in the problem: not its filename, its title, its uploader or its id
        const text = JSON.stringify(body);
        for (const leak of ["secret-name", "secret title", "contrib-1", row.id]) expect(text, `${mime} leaks ${leak}`).not.toContain(leak);
      }
    });

    it("over 10 MiB is 413 media-preview-too-large; exactly the cap is not refused for size", async () => {
      const big = await seedAsset(fx, { mime: "image/png", reviewState: "quarantined", sizeBytes: PREVIEW_MAX_BYTES + 1 });
      const r = await preview(fx, big.id);
      expect(r.statusCode).toBe(413);
      expect(r.json()).toMatchObject({ type: `${PROBLEM}media-preview-too-large`, status: 413 });
      const atCap = await seedAsset(fx, { mime: "image/png", reviewState: "quarantined", sizeBytes: PREVIEW_MAX_BYTES });
      // no object behind this row: it passes the size wall and meets the next one (no stored object: the same 404), not a 413
      expect((await preview(fx, atCap.id)).statusCode).toBe(404);
    });

    it("a row that declares a raster type its stored bytes do not bear is 415 and the bytes are not sent", async () => {
      const row = await seedWithBytes(fx, buildJpeg(200), { mime: "image/png", reviewState: "quarantined" });
      const r = await preview(fx, row.id);
      expect(r.statusCode).toBe(415);
      expect(r.json()).toMatchObject({ type: `${PROBLEM}media-preview-unsupported`, mime: "image/png" });
      expect(Buffer.compare(r.rawPayload, buildJpeg(200))).not.toBe(0);
      // HTML bytes behind a png row, the case a stored-XSS would need
      const html = Buffer.from("<html><script>alert(1)</script></html>");
      const row2 = await seedWithBytes(fx, html, { mime: "image/png", reviewState: "quarantined" });
      const r2 = await preview(fx, row2.id);
      expect(r2.statusCode).toBe(415);
      expect(r2.body).not.toContain("<script>");
    });

    it("every allow-listed raster type is previewed when its bytes carry its signature", async () => {
      const bytes: Record<string, Buffer> = {
        "image/png": buildPng(8, 8, 64),
        "image/jpeg": buildJpeg(64),
        "image/gif": Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(40, 0x01)]),
        "image/webp": Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBP", "latin1"), Buffer.alloc(40, 0x02)]),
        "image/avif": Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif", "latin1"), Buffer.alloc(40, 0x03)]),
      };
      for (const [mime, buf] of Object.entries(bytes)) {
        const row = await seedWithBytes(fx, buf, { mime, reviewState: "quarantined" });
        const r = await preview(fx, row.id);
        expect(r.statusCode, `${mime}: ${r.body.slice(0, 200)}`).toBe(200);
        expect(r.headers["content-type"], mime).toBe(mime);
        expect(Buffer.compare(r.rawPayload, buf), mime).toBe(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("auth: the route sits behind the control plane's own layers", () => {
    it("no control principal is 401; a token without webdesk:read is 403; with it 200; no editorial principal is needed; an unknown query key is 400", async () => {
      const { id } = await quarantinedPng();
      expect((await preview(fx, id, { noPrincipal: true })).statusCode).toBe(401);
      const none = await preview(fx, id, { scopes: [] });
      expect(none.statusCode).toBe(403);
      expect(none.json().message).toMatch(/lacks required scope 'webdesk:read'/);
      expect((await preview(fx, id, { scopes: ["webdesk:operate", "webdesk:promote", "webdesk:keys"] })).statusCode).toBe(403);
      expect((await preview(fx, id, { scopes: ["webdesk:read"] })).statusCode).toBe(200);
      expect((await preview(fx, id, { qs: "?size=full" })).statusCode).toBe(400);
    });

    it("a refused caller gets no bytes however the request is shaped", async () => {
      const { id, png } = await quarantinedPng();
      const r = await preview(fx, id, { noPrincipal: true });
      expect(Buffer.compare(r.rawPayload, png)).not.toBe(0);
    });
  });
});
