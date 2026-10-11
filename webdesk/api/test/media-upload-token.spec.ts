// WSK-43a (owner rulings WSK-D53/D54) — media.uploadToken (the control command) and the PUBLIC upload route it
// feeds: POST /v1/t/:tenantSlug/media/upload/:token. Real Postgres (migrations through 0014), real Redis,
// real RustFS, real ClamAV, the real AppModule with the REAL Layer-3/4 PDP (content-test-kit.ts).
//
// This is an untrusted-input surface on the public internet (a bearer token, a body of the caller's choosing),
// so the suite is adversarial about what the route must NOT do:
//   - store a byte before the token is proven, the size is within the cap and the type is allowed;
//   - let one token upload twice, even under concurrency;
//   - tell a caller WHY a token failed (every cause is one identical 404);
//   - hold the plaintext token anywhere at rest (the table, the idempotency record, the audit rows).
// Doctrine (estate memory: "validation pre-empts authz"): every denial sends a request that is valid for its
// command and is paired with a positive control that sends the IDENTICAL request and succeeds.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asPlatform, asTenant, buildContentApp, createContentFixture, hdr, type ContentFixture } from "./content-test-kit";
import { dumpAudit, dumpIdempotency, setDomains } from "./preview-test-kit";
import {
  MEDIA_BUCKET,
  PROBLEM,
  assetUrl,
  auditRows,
  buildEicarPdf,
  buildJpeg,
  buildPng,
  dumpAssets,
  dumpTokens,
  expireUploadToken,
  getAsset,
  listVersions,
  liveObjectKeysUnderTenant,
  mediaBase,
  mintOk,
  mintUploadToken,
  objectKeysUnderTenant,
  preflight,
  sha256Hex,
  sleep,
  uploadFile,
  type MintedUpload,
} from "./media-library-kit";
import { storageConfig } from "../src/storage/storage.config";
import { QuotaService } from "../src/media/quota.service";
import { MediaService } from "../src/media/media.service";
import { DbService } from "../src/db/db.service";

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const CAP = 65_536;

describe("WSK-43a media.uploadToken and POST /v1/t/:tenantSlug/media/upload/:token", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let other: ContentFixture;
  const saved: Record<string, string | undefined> = {};
  /** The app listens on a real socket the first time a test needs one (inject does not exercise streaming or concurrency faithfully). */
  let listening: number | null = null;
  const serverPort = async (): Promise<number> => {
    if (listening === null) {
      await app.listen(0, "127.0.0.1");
      listening = (app.getHttpServer().address() as { port: number }).port;
    }
    return listening;
  };

  beforeAll(async () => {
    saved.cap = process.env.WEBDESK_MEDIA_MAX_UPLOAD_BYTES;
    process.env.WEBDESK_MEDIA_MAX_UPLOAD_BYTES = String(CAP);
    app = await buildContentApp();
    fx = await createContentFixture("upl");
    other = await createContentFixture("upl-other");
  });
  afterAll(async () => {
    await app?.close();
    if (saved.cap === undefined) delete process.env.WEBDESK_MEDIA_MAX_UPLOAD_BYTES;
    else process.env.WEBDESK_MEDIA_MAX_UPLOAD_BYTES = saved.cap;
  });

  // ==============================================================================================
  // Mint
  // ==============================================================================================
  describe("media.uploadToken (mint)", () => {
    it("201 { tokenId, token, uploadPath, expiresAt } for a ten-minute token, defaulting to the bucket's allowlist and the media config's cap", async () => {
      const before = Date.now();
      const res = await mintUploadToken(app, fx, { bucket: "media" });
      expect(res.statusCode).toBe(201);
      const b = res.json<MintedUpload>();
      for (const k of ["tokenId", "token", "uploadPath", "expiresAt"]) expect(b).toHaveProperty(k);
      expect(b.replayed).toBe(false);
      expect(b.token).toMatch(BASE64URL_43); // 32 random bytes, base64url, no padding
      expect(b.uploadPath).toBe(`/v1/t/${fx.slug}/media/upload/${b.token}`);
      const ttl = Date.parse(b.expiresAt) - before;
      expect(ttl).toBeGreaterThan(600_000 - 5_000);
      expect(ttl).toBeLessThan(600_000 + 15_000);
      expect(b.bucket).toBe("media");
      expect(b.maxBytes).toBe(CAP);
      expect([...b.allowedMimes].sort()).toEqual(["application/pdf", "image/gif", "image/jpeg", "image/png", "image/webp"]);
    });

    it("two mints give two different tokens", async () => {
      const a = await mintOk(app, fx);
      const b = await mintOk(app, fx);
      expect(a.token).not.toBe(b.token);
      expect(a.tokenId).not.toBe(b.tokenId);
    });

    it("STORED AS A HASH ONLY: the row holds sha256(token), the plaintext is in no column, created_by is the editorial principal", async () => {
      const { token, tokenId } = await mintOk(app, fx, { bucket: "media", maxBytes: 5000, mime: "image/png" });
      const rows = await dumpTokens(fx);
      const row = rows.find((r) => r.id === tokenId) as Record<string, unknown>;
      expect(row.token_hash).toBe(sha256Hex(token));
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      for (const r of rows) expect(JSON.stringify(r)).not.toContain(token);
      expect(row).toMatchObject({ tenant_id: fx.tenantId, site_id: fx.siteId, bucket: "media", created_by: "user-editor-1", used_at: null });
      expect(Number(row.max_bytes)).toBe(5000);
      expect(row.allowed_mimes).toEqual(["image/png"]);
    });

    it("THE PLAINTEXT APPEARS ONLY IN THE RESPONSE: not in control_idempotency_keys, not in audit_entries", async () => {
      const idem = `idem-${randomUUID()}`;
      const res = await mintUploadToken(app, fx, { bucket: "media" }, { idem });
      const { token, tokenId, uploadPath } = res.json<MintedUpload>();
      const idemRows = await dumpIdempotency(fx);
      const mine = idemRows.filter((r) => String(r.scope_key).endsWith(`:media.uploadToken:${idem}`));
      expect(mine).toHaveLength(1);
      expect(mine[0].status).toBe("completed");
      for (const r of idemRows) {
        expect(JSON.stringify(r)).not.toContain(token);
        expect(JSON.stringify(r)).not.toContain(uploadPath);
      }
      expect(mine[0].response).toMatchObject({ tokenId, secretWithheld: true });
      expect((mine[0].response as Record<string, unknown>).token).toBeUndefined();
      expect((mine[0].response as Record<string, unknown>).uploadPath).toBeUndefined();
      for (const r of await dumpAudit(fx)) expect(JSON.stringify(r)).not.toContain(token);
      expect((await dumpAudit(fx)).some((r) => r.action === "control.media.uploadToken")).toBe(true);
    });

    it("a REPLAY (same Idempotency-Key, same request) is 409 idempotency-response-withheld, mints nothing, returns no token; a changed body under the key is idempotency-key-reused", async () => {
      const idem = `idem-${randomUUID()}`;
      const first = await mintUploadToken(app, fx, { bucket: "media", maxBytes: 4000 }, { idem });
      expect(first.statusCode).toBe(201);
      const rowsBefore = (await dumpTokens(fx)).length;
      const replay = await mintUploadToken(app, fx, { bucket: "media", maxBytes: 4000 }, { idem });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
      expect(replay.body).not.toContain(first.json().token);
      expect((await dumpTokens(fx)).length).toBe(rowsBefore);
      const reused = await mintUploadToken(app, fx, { bucket: "media", maxBytes: 4001 }, { idem });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().type).toBe(`${PROBLEM}idempotency-key-reused`);
      expect((await mintUploadToken(app, fx, { bucket: "media", maxBytes: 4000 })).statusCode).toBe(201); // fresh key
    });

    it("maxBytes is honoured when smaller than the config cap and CAPPED by it when larger", async () => {
      expect((await mintOk(app, fx, { bucket: "media", maxBytes: 1234 })).maxBytes).toBe(1234);
      expect((await mintOk(app, fx, { bucket: "media", maxBytes: CAP })).maxBytes).toBe(CAP);
      expect((await mintOk(app, fx, { bucket: "media", maxBytes: CAP * 100 })).maxBytes).toBe(CAP);
    });

    it("a bad maxBytes is 400 invalid-request (never guessed at): 0, negative, fractional, a string, a boolean", async () => {
      for (const maxBytes of [0, -5, 1.5, "100", true, {}]) {
        const res = await mintUploadToken(app, fx, { bucket: "media", maxBytes });
        expect(res.statusCode, JSON.stringify(maxBytes)).toBe(400);
        expect(res.json().type).toBe(`${PROBLEM}invalid-request`);
      }
      expect((await mintUploadToken(app, fx, { bucket: "media", maxBytes: 100 })).statusCode).toBe(201);
    });

    it("mime narrows the allowed set (a string or an array) and can never go beyond the bucket's allowlist", async () => {
      expect((await mintOk(app, fx, { bucket: "media", mime: "image/png" })).allowedMimes).toEqual(["image/png"]);
      expect((await mintOk(app, fx, { bucket: "media", mime: ["image/png", "image/webp", "image/png"] })).allowedMimes.sort()).toEqual(["image/png", "image/webp"]);
      for (const mime of ["text/html", "image/svg+xml", "video/mp4", ["image/png", "application/x-msdownload"], [], 5, [5], ""]) {
        const res = await mintUploadToken(app, fx, { bucket: "media", mime });
        expect(res.statusCode, JSON.stringify(mime)).toBe(400);
        expect(res.json().type).toBe(`${PROBLEM}invalid-request`);
      }
      // the video bucket: video types only
      expect((await mintOk(app, fx, { bucket: "video" })).allowedMimes.sort()).toEqual(["video/mp4", "video/webm"]);
      expect((await mintUploadToken(app, fx, { bucket: "video", mime: "image/png" })).statusCode).toBe(400);
    });

    it("only the PUBLIC library buckets take a token: uploads (private form attachments), artifacts, unknown and missing are 400", async () => {
      for (const bucket of ["uploads", "artifacts", "nope", "", 5, null]) {
        const res = await mintUploadToken(app, fx, { bucket });
        expect(res.statusCode, JSON.stringify(bucket)).toBe(400);
        expect(res.json().type).toBe(`${PROBLEM}invalid-request`);
      }
      expect((await mintUploadToken(app, fx, {})).statusCode).toBe(400);
      expect((await mintUploadToken(app, fx, { bucket: "media" })).statusCode).toBe(201);
    });

    it("an unknown body key or a route-param key is 400; a non-object body is 400", async () => {
      for (const body of [{ bucket: "media", extra: 1 }, { bucket: "media", siteId: fx.siteId }, { bucket: "media", tenantSlug: fx.slug }, { bucket: "media", assetId: randomUUID() }]) {
        const res = await mintUploadToken(app, fx, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json().type).toBe(`${PROBLEM}invalid-request`);
      }
      const res = await app.inject({ method: "POST", url: `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/media/upload-token`, headers: { ...hdr(), "content-type": "application/json" }, payload: "[1]" });
      expect(res.statusCode).toBe(400);
    });

    it("an unknown tenant slug or site is 404 site-not-found; a site of ANOTHER tenant is the same 404, and writes no token", async () => {
      const wrongSite = await app.inject({ method: "POST", url: `/control/v1/tenants/${fx.slug}/sites/${randomUUID()}/media/upload-token`, headers: hdr(), payload: { bucket: "media" } });
      expect(wrongSite.statusCode).toBe(404);
      expect(wrongSite.json().type).toBe(`${PROBLEM}site-not-found`);
      const foreignSite = await app.inject({ method: "POST", url: `/control/v1/tenants/${fx.slug}/sites/${other.siteId}/media/upload-token`, headers: hdr(), payload: { bucket: "media" } });
      expect(foreignSite.statusCode).toBe(404);
      expect(foreignSite.json().type).toBe(`${PROBLEM}site-not-found`);
      const wrongTenant = await app.inject({ method: "POST", url: `/control/v1/tenants/no-such-tenant/sites/${fx.siteId}/media/upload-token`, headers: hdr(), payload: { bucket: "media" } });
      expect(wrongTenant.statusCode).toBe(404);
      expect((await dumpTokens(other)).length).toBe(0);
    });

    describe("gates (L1/L2 stubbed -> L3 scope -> L2e editorial -> validation); valid bodies, positive controls", () => {
      it("without an editorial principal -> 401 editorial-assertion-missing, nothing written; the identical request WITH one -> 201", async () => {
        const tokensBefore = (await dumpTokens(fx)).length;
        const auditBefore = (await dumpAudit(fx)).length;
        const denied = await mintUploadToken(app, fx, { bucket: "media", maxBytes: 3000 }, { editorial: null });
        expect(denied.statusCode).toBe(401);
        expect(denied.json().type).toBe(`${PROBLEM}editorial-assertion-missing`);
        expect((await dumpTokens(fx)).length).toBe(tokensBefore);
        expect((await dumpAudit(fx)).length).toBe(auditBefore);
        expect((await mintUploadToken(app, fx, { bucket: "media", maxBytes: 3000 })).statusCode).toBe(201);
      });

      it("a scopeless token -> 403 and a read-only token -> 403 (L3); the operate scope -> 201", async () => {
        const scopeless = await mintUploadToken(app, fx, { bucket: "media" }, { scopes: [] });
        expect(scopeless.statusCode).toBe(403);
        expect(scopeless.json().message).toMatch(/lacks required scope/);
        expect((await mintUploadToken(app, fx, { bucket: "media" }, { scopes: ["webdesk:read"] })).statusCode).toBe(403);
        expect((await mintUploadToken(app, fx, { bucket: "media" }, { scopes: ["webdesk:operate"] })).statusCode).toBe(201);
      });

      it("a malformed editorial principal -> 401; a well-formed agent principal -> 201 and the token is attributed to IT", async () => {
        const bad = await mintUploadToken(app, fx, { bucket: "media" }, { editorial: '{"sub": 5}' });
        expect(bad.statusCode).toBe(401);
        expect(bad.json().type).toBe(`${PROBLEM}editorial-assertion-malformed`);
        const ok = await mintUploadToken(app, fx, { bucket: "media" }, { editorial: '{"sub":"bot-9","pk":"agent","agt":"webdev-writer"}' });
        expect(ok.statusCode).toBe(201);
        expect((await dumpTokens(fx)).find((r) => r.id === ok.json().tokenId)?.created_by).toBe("bot-9");
      });

      it("gate ORDER: L3 before L2e; L2e before validation (an invalid body with no principal is 401, not 400)", async () => {
        expect((await mintUploadToken(app, fx, { bucket: "media" }, { scopes: [], editorial: null })).statusCode).toBe(403);
        expect((await mintUploadToken(app, fx, { bucket: "nope" }, { editorial: null })).statusCode).toBe(401);
        expect((await mintUploadToken(app, fx, { bucket: "nope" })).statusCode).toBe(400);
        expect((await mintUploadToken(app, fx, { bucket: "media" })).statusCode).toBe(201);
      });

      it("requires an Idempotency-Key (400 without one); with one -> 201. MEDIUM: no WS4 assertion needed and none claimed", async () => {
        const noKey = await mintUploadToken(app, fx, { bucket: "media" }, { idem: null });
        expect(noKey.statusCode).toBe(400);
        expect(noKey.json().type).toBe(`${PROBLEM}invalid-request`);
        expect((await mintUploadToken(app, fx, { bucket: "media" })).statusCode).toBe(201);
        expect((await dumpAudit(fx)).filter((r) => r.action === "control.media.uploadToken" && r.ws4_approval_id !== null)).toHaveLength(0);
      });
    });
  });

  // ==============================================================================================
  // Upload: the happy path
  // ==============================================================================================
  describe("upload: the happy path", () => {
    it("a clean PNG: 201 with the asset and its canonical URL; the row, the object, the audit row and the spent token all agree", async () => {
      const t = await mintOk(app, fx, { bucket: "media", mime: ["image/png"] });
      const png = buildPng(640, 480, 4096);
      const res = await uploadFile(app, fx.slug, t.token, png, { filename: "Hero Banner.png" });
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json();
      expect(a.url).toBe(`/v1/t/${fx.slug}/media/${a.assetId}`);
      expect(a).toMatchObject({ bucket: "media", mime: "image/png", sizeBytes: 4096, scanStatus: "clean", width: 640, height: 480, originalFilename: "Hero Banner.png", title: null, alt: {}, tags: [], createdBy: "user-editor-1" });
      expect(res.headers["cache-control"]).toBe("no-store");

      const row = (await getAsset(fx, a.assetId)) as Record<string, any>;
      expect(row).toMatchObject({ tenant_id: fx.tenantId, site_id: fx.siteId, mime: "image/png", scan_status: "clean", original_filename: "Hero Banner.png", created_by: "user-editor-1", width: 640, height: 480, deleted_at: null, purged_at: null });
      expect(Number(row.size_bytes)).toBe(4096);
      expect(a.bucketKey).toBe(row.bucket_key);
      const objectKey = String(row.bucket_key).slice("media/".length);
      expect(objectKey.startsWith(`t/${fx.tenantId}/${fx.siteId}/`)).toBe(true);
      expect((await listVersions(MEDIA_BUCKET, objectKey)).versions).toHaveLength(1); // really stored

      const token = (await dumpTokens(fx)).find((r) => r.id === t.tokenId) as Record<string, unknown>;
      expect(token.used_at).not.toBeNull();
      const audit = (await auditRows(fx, "webdesk.media.upload")).filter((r) => r.actor === "user-editor-1");
      expect(audit.length).toBeGreaterThan(0);
    });

    it("the canonical URL serves the bytes through the existing public media route (the URL an editor writes into a media field works)", async () => {
      const t = await mintOk(app, fx);
      const png = buildPng(10, 20, 600);
      const a = (await uploadFile(app, fx.slug, t.token, png)).json();
      const served = await app.inject({ method: "GET", url: a.url });
      expect(served.statusCode).toBe(200);
      expect(Buffer.compare(served.rawPayload, png)).toBe(0);
      expect(served.headers["content-type"]).toBe("image/png");
    });

    it("no api key is needed, and an api key or other credential neither helps nor hurts", async () => {
      const t = await mintOk(app, fx);
      const res = await uploadFile(app, fx.slug, t.token, buildPng(), { extraHeaders: { authorization: "Bearer not-a-key", cookie: "x=1" } });
      expect(res.statusCode).toBe(201);
    });

    it("the filename is a label: the last path segment, control characters removed, at most 255 characters; the object key never carries it raw", async () => {
      const t1 = await mintOk(app, fx);
      const a1 = (await uploadFile(app, fx.slug, t1.token, buildPng(), { filename: "../../etc/pass wd\u0007.png" })).json();
      expect(a1.originalFilename).toBe("pass wd.png");
      expect(a1.bucketKey).not.toContain("..");
      expect(a1.bucketKey).not.toContain(" ");
      const t2 = await mintOk(app, fx);
      const a2 = (await uploadFile(app, fx.slug, t2.token, buildPng(), { filename: "x".repeat(400) + ".png" })).json();
      expect(Array.from(a2.originalFilename as string)).toHaveLength(255);
      const t3 = await mintOk(app, fx);
      const a3 = (await uploadFile(app, fx.slug, t3.token, buildPng())).json();
      expect(a3.originalFilename).toBeNull(); // no filename given: none recorded
    });

    it("dimensions are recorded when cheaply known (png) and null for a type that has none (pdf)", async () => {
      const t = await mintOk(app, fx, { bucket: "media", mime: ["application/pdf"] });
      const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF", "ascii");
      const res = await uploadFile(app, fx.slug, t.token, pdf, { contentType: "application/pdf", filename: "doc.pdf" });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toMatchObject({ mime: "application/pdf", width: null, height: null });
    });
  });

  // ==============================================================================================
  // Upload: one token, one upload
  // ==============================================================================================
  describe("upload: a token uploads exactly once", () => {
    it("the second use of a token is 404, and creates no second asset", async () => {
      const f = await createContentFixture("once");
      const t = await mintOk(app, f);
      expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(201);
      const again = await uploadFile(app, f.slug, t.token, buildPng());
      expect(again.statusCode).toBe(404);
      expect((await dumpAssets(f)).length).toBe(1);
      expect((await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).length).toBe(1);
    });

    it("CONCURRENT uploads with one token: exactly one succeeds, the other is 404 AT ONCE (it does not wait on the winner), one asset, one object (repeated, so a lucky interleaving cannot pass)", async () => {
      const f = await createContentFixture("race");
      for (let round = 0; round < 6; round++) {
        const t = await mintOk(app, f);
        const results = await Promise.all([0, 1].map((i) => uploadFile(app, f.slug, t.token, buildPng(100 + i, 100, 2048 + i), { filename: `race-${round}-${i}.png` })));
        expect(results.map((r) => r.statusCode).sort(), `round ${round}`).toEqual([201, 404]);
      }
      expect((await dumpAssets(f)).length).toBe(6); // one per round
      expect((await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).length).toBe(6); // and only the winners' objects were stored
    }, 60_000);

    it("a request that arrives while another holds the token does not queue behind it: while a slow upload is in flight (real socket), the same token answers 404 immediately (it is already spent: the claim is committed before the body is read)", async () => {
      const f = await createContentFixture("noqueue");
      const t = await mintOk(app, f, { bucket: "media", mime: ["image/png"] });
      const port = await serverPort();
      // a slow sender: headers and a first piece, then nothing until we say so
      const slow = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/t/${f.slug}/media/upload/${t.token}`, headers: { "content-type": "image/png", "transfer-encoding": "chunked" } });
      slow.on("error", () => undefined);
      const slowDone = new Promise<number>((resolve) => slow.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
      slow.write(buildPng(1, 1, 128));
      await sleep(400); // the server has claimed the token and is waiting for the rest of the body
      const t0 = Date.now();
      const second = await fetch(`http://127.0.0.1:${port}/v1/t/${f.slug}/media/upload/${t.token}`, { method: "POST", headers: { "content-type": "image/png" }, body: buildPng(2, 2, 300) });
      expect(second.status).toBe(404);
      expect(Date.now() - t0, "no waiting on the row lock").toBeLessThan(2000);
      // the slow sender completes a valid file: it is the one that wins
      slow.end(Buffer.alloc(64, 0x61));
      expect(await slowDone).toBe(201);
      expect((await dumpAssets(f)).length).toBe(1);
    }, 30_000);

    it("a refusal the HEADERS decide (a declared size over the cap, a type outside the token's set) does not spend the token: the same token then uploads a good file", async () => {
      const f = await createContentFixture("unspent");
      const t = await mintOk(app, f, { bucket: "media", maxBytes: 1000, mime: ["image/png"] });
      expect((await uploadFile(app, f.slug, t.token, buildPng(1, 1, 5000))).statusCode).toBe(413);
      expect((await uploadFile(app, f.slug, t.token, Buffer.from("%PDF-1.4 x"), { contentType: "application/pdf" })).statusCode).toBe(415);
      expect((await dumpTokens(f))[0].used_at).toBeNull();
      expect((await uploadFile(app, f.slug, t.token, buildPng(1, 1, 500))).statusCode).toBe(201);
      expect((await dumpTokens(f))[0].used_at).not.toBeNull();
    });
  });

  // ==============================================================================================
  // Upload: size, type, scan, quota: refused BEFORE anything is stored
  // ==============================================================================================
  describe("upload: refusals happen before a byte is stored", () => {
    it("over the token's cap with a declared Content-Length: 413, no row, NO OBJECT in storage", async () => {
      const f = await createContentFixture("cap");
      const t = await mintOk(app, f, { bucket: "media", maxBytes: 2000 });
      const res = await uploadFile(app, f.slug, t.token, buildPng(1, 1, 2001));
      expect(res.statusCode).toBe(413);
      expect((await dumpAssets(f)).length).toBe(0);
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
      // positive control: exactly the cap is fine
      expect((await uploadFile(app, f.slug, t.token, buildPng(1, 1, 2000))).statusCode).toBe(201);
    });

    it("a STREAMED body with no Content-Length is cut off at the cap while it arrives (a REAL socket): 413 before the sender is read to the end, nothing stored", async () => {
      const f = await createContentFixture("stream");
      const t = await mintOk(app, f, { bucket: "media", maxBytes: 4096 });
      const addr = { port: await serverPort() };
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const totalChunks = 3200; // 200 MB offered, generated lazily: nothing is held here
      let produced = 0;
      const body = new Readable({
        read() {
          if (produced >= totalChunks) return this.push(null);
          produced++;
          this.push(produced === 1 ? Buffer.concat([buildPng(1, 1, 64), chunk.subarray(64)]) : chunk);
        },
      });
      const started = Date.now();
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: addr.port, method: "POST", path: `/v1/t/${f.slug}/media/upload/${t.token}`, headers: { "content-type": "image/png", "transfer-encoding": "chunked" } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", (e) => (produced > 0 ? undefined : reject(e))); // the server may hang up while we are still writing: the response is what counts
        body.pipe(req);
      });
      expect(status).toBe(413);
      body.destroy();
      // The server stopped reading at the cap, so the sender blocked on a full socket long before 200 MB. (Kernel
      // socket buffers decide how far past the cap it got; a server that buffered the body would take it all.)
      expect(produced * chunk.length, "bytes the sender managed to push").toBeLessThan(64 * 1024 * 1024);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect((await dumpAssets(f)).length).toBe(0);
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
      // the claim was committed before the body was read, so the token is spent (fail closed): a new one is needed
      expect((await dumpTokens(f))[0].used_at).not.toBeNull();
      const retry = await fetch(`http://127.0.0.1:${addr.port}/v1/t/${f.slug}/media/upload/${t.token}`, { method: "POST", headers: { "content-type": "image/png" }, body: buildPng(2, 2, 300) });
      expect(retry.status).toBe(404);
      const fresh = await mintOk(app, f, { bucket: "media", maxBytes: 4096 });
      const ok = await fetch(`http://127.0.0.1:${addr.port}/v1/t/${f.slug}/media/upload/${fresh.token}`, { method: "POST", headers: { "content-type": "image/png" }, body: buildPng(2, 2, 300) });
      expect(ok.status).toBe(201);
    }, 60_000);

    it("a streamed body with no Content-Length over the cap is 413 through inject too (the same code path, no socket)", async () => {
      const f = await createContentFixture("stream-inject");
      const t = await mintOk(app, f, { bucket: "media", maxBytes: 4096 });
      const body = Readable.from([buildPng(1, 1, 3000), Buffer.alloc(3000, 0x61)]);
      expect((await uploadFile(app, f.slug, t.token, body)).statusCode).toBe(413);
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
    });

    it("a token's cap can be lower than the service cap but never higher: the service cap still applies", async () => {
      const f = await createContentFixture("svccap");
      const t = await mintOk(app, f, { bucket: "media", maxBytes: CAP * 100 }); // capped to CAP at mint
      expect(t.maxBytes).toBe(CAP);
      expect((await uploadFile(app, f.slug, t.token, buildPng(1, 1, CAP + 1))).statusCode).toBe(413);
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
    });

    it("a disallowed type is refused: not in the token's set -> 415, with no object; a type with no parser at all -> 415; the same token still works for an allowed one", async () => {
      const f = await createContentFixture("mime");
      const t = await mintOk(app, f, { bucket: "media", mime: ["image/png"] });
      const pdf = Buffer.from("%PDF-1.4 hello", "ascii");
      const r1 = await uploadFile(app, f.slug, t.token, pdf, { contentType: "application/pdf" });
      expect(r1.statusCode).toBe(415);
      const r2 = await uploadFile(app, f.slug, t.token, buildJpeg(), { contentType: "image/jpeg" });
      expect(r2.statusCode).toBe(415);
      const r3 = await uploadFile(app, f.slug, t.token, "<script>alert(1)</script>", { contentType: "text/html" });
      expect(r3.statusCode).toBe(415);
      const r4 = await uploadFile(app, f.slug, t.token, "{}", { contentType: "application/json" });
      expect([400, 415]).toContain(r4.statusCode); // JSON is parsed by the default parser, then refused as not a type this token takes
      const r5 = await uploadFile(app, f.slug, t.token, buildPng(), { contentType: null });
      expect([400, 415]).toContain(r5.statusCode); // no content type at all
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
      expect((await dumpAssets(f)).length).toBe(0);
      expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(201); // positive control
    });

    it("the declared type must match the bytes: a JPEG sent as image/png is 400, nothing stored", async () => {
      const f = await createContentFixture("sniff");
      const t = await mintOk(app, f, { bucket: "media", mime: ["image/png"] });
      const res = await uploadFile(app, f.slug, t.token, buildJpeg(), { contentType: "image/png" });
      expect(res.statusCode).toBe(400);
      expect(String(res.json().message)).toMatch(/does not match the file's actual signature/);
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
      expect((await dumpTokens(f))[0].used_at).not.toBeNull(); // body-level refusal: the token was claimed before the body was read
      expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(404);
      expect((await uploadFile(app, f.slug, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201); // a new token works
    });

    it("an empty body is 400", async () => {
      const f = await createContentFixture("empty");
      const t = await mintOk(app, f);
      const res = await uploadFile(app, f.slug, t.token, Buffer.alloc(0));
      expect(res.statusCode).toBe(400);
      expect((await dumpTokens(f))[0].used_at).not.toBeNull(); // consumed (fail closed)
      expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(404);
    });

    it("an INFECTED file (EICAR) follows the existing scan behaviour: 403 'malware scan matched', no row, no object, the refusal audited; the token is spent (fail closed)", async () => {
      const f = await createContentFixture("eicar");
      const t = await mintOk(app, f, { bucket: "media", mime: ["application/pdf", "image/png"] });
      const res = await uploadFile(app, f.slug, t.token, buildEicarPdf(), { contentType: "application/pdf", filename: "eicar.pdf" });
      expect(res.statusCode).toBe(403);
      expect(String(res.json().message)).toMatch(/malware scan matched/i);
      expect(String(res.json().message)).toMatch(/eicar/i);
      expect((await dumpAssets(f)).length).toBe(0);
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
      const refused = await auditRows(f, "webdesk.media.uploadRefused");
      expect(refused).toHaveLength(1);
      expect(refused[0].actor).toBe("user-editor-1");
      expect((await dumpTokens(f))[0].used_at).not.toBeNull();
      expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(404);
      expect((await uploadFile(app, f.slug, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201); // a new token takes a clean file
    });

    it("over the tenant's storage quota: 403, nothing stored, token spent (the existing quota check, counting bytes held)", async () => {
      const f = await createContentFixture("quota");
      const t = await mintOk(app, f);
      const prev = process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES;
      process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES = "1000";
      try {
        const res = await uploadFile(app, f.slug, t.token, buildPng(1, 1, 2048));
        expect(res.statusCode).toBe(403);
        expect(String(res.json().message)).toMatch(/quota/i);
        expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
        expect((await dumpTokens(f))[0].used_at).not.toBeNull();
        const fits = await uploadFile(app, f.slug, (await mintOk(app, f)).token, buildPng(1, 1, 900)); // positive control: a new token, a file that fits
        expect(fits.statusCode).toBe(201);
        expect(await app.get(QuotaService).usedBytes(f.tenantId)).toBe(900);
      } finally {
        if (prev === undefined) delete process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES;
        else process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES = prev;
      }
    });
  });

  // ==============================================================================================
  // Upload: NO pooled connection is held while bytes stream
  // ==============================================================================================
  describe("upload: the database is used in short steps, never across the transfer", () => {
    it("while TWO slow uploads are mid-body (a real socket, bytes trickling) the pool has ZERO connections checked out; both tokens are already spent (the claim committed before the body); the api serves other requests; the uploads then complete", async () => {
      const f = await createContentFixture("noconn");
      const pool = app.get(DbService).pool;
      const inUse = () => pool.totalCount - pool.idleCount;
      const [t1, t2] = [await mintOk(app, f), await mintOk(app, f)];
      const port = await serverPort();
      await sleep(200);
      expect(inUse(), "baseline").toBe(0);
      const slow = (token: string) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/t/${f.slug}/media/upload/${token}`, headers: { "content-type": "image/png", "transfer-encoding": "chunked" } });
        req.on("error", () => undefined);
        const done = new Promise<number>((resolve) => req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
        req.write(buildPng(1, 1, 128));
        return { req, done };
      };
      const a = slow(t1.token);
      const b = slow(t2.token);
      for (let i = 0; i < 6; i++) {
        await sleep(200);
        a.req.write(Buffer.alloc(8, 0x61)); // the body trickles in
        b.req.write(Buffer.alloc(8, 0x61));
        expect(inUse(), `checked-out connections while streaming (tick ${i})`).toBe(0);
      }
      const rows = await dumpTokens(f);
      expect(rows.filter((r) => r.used_at !== null)).toHaveLength(2); // claimed, committed, before the body ended
      // the rest of the api is not starved: a control read answers while both uploads are open
      expect((await app.inject({ method: "GET", url: `/control/v1/tenants/${f.slug}/sites/${f.siteId}/media`, headers: hdr({ editorial: null, idem: null }) })).statusCode).toBe(200);
      a.req.end(Buffer.alloc(16, 0x61));
      b.req.end(Buffer.alloc(16, 0x61));
      expect(await a.done).toBe(201);
      expect(await b.done).toBe(201);
      await sleep(300); // the response can leave a moment before the last connection is returned to the pool
      expect(inUse()).toBe(0);
      expect((await dumpAssets(f)).length).toBe(2);
    }, 30_000);

    it("a STORAGE failure after the claim: 500, the token is consumed (fail closed), no row, no object; the same token is then 404 and a new one works", async () => {
      const f = await createContentFixture("store-fail");
      const t = await mintOk(app, f);
      const spy = vi.spyOn(app.get(MediaService), "storeObject").mockRejectedValueOnce(new Error("simulated storage outage"));
      try {
        const res = await uploadFile(app, f.slug, t.token, buildPng());
        expect(res.statusCode).toBe(500);
        expect(res.body).not.toContain("simulated storage outage"); // the thrown message is not echoed
      } finally {
        spy.mockRestore();
      }
      expect((await dumpTokens(f))[0].used_at).not.toBeNull();
      expect((await dumpAssets(f)).length).toBe(0);
      expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
      expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(404);
      expect((await uploadFile(app, f.slug, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201);
    });

    it("a ROW-INSERT failure after the object was stored: 500, the object is deleted (no live object), and a soft-deleted tombstone row remembers it so media-purge can free the locked version; nothing appears in the library", async () => {
      const f = await createContentFixture("row-fail");
      const t = await mintOk(app, f);
      const spy = vi.spyOn(app.get(MediaService), "recordAsset").mockRejectedValueOnce(new Error("simulated insert failure"));
      try {
        expect((await uploadFile(app, f.slug, t.token, buildPng(1, 1, 700), { filename: "orphan.png" })).statusCode).toBe(500);
      } finally {
        spy.mockRestore();
      }
      expect((await dumpTokens(f))[0].used_at).not.toBeNull();
      expect(await liveObjectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]); // deleted
      const keys = await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId);
      expect(keys.length).toBe(2); // the locked version and its delete marker remain until the retention lapses
      const assets = await dumpAssets(f);
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ created_by: "user-editor-1", purged_at: null });
      expect(assets[0].deleted_at).not.toBeNull();
      expect(assets[0].purge_after).not.toBeNull(); // the purge job frees the locked version
      expect(String(assets[0].bucket_key)).toBe(`media/${keys[0]}`);
      expect(Number(assets[0].size_bytes)).toBe(700);
      const list = await app.inject({ method: "GET", url: `/control/v1/tenants/${f.slug}/sites/${f.siteId}/media`, headers: hdr({ editorial: null, idem: null }) });
      expect(list.json().assets).toEqual([]); // hidden: soft-deleted
      expect(await app.get(QuotaService).usedBytes(f.tenantId)).toBe(700); // still held until purged
    });
  });

  // ==============================================================================================
  // Upload: slots (a slow sender cannot drain the shared connection pool)
  // ==============================================================================================
  describe("upload: at most a few uploads in flight per process and per tenant", () => {
    it("with the per-tenant limit (2) taken by two slow senders, a THIRD upload of that tenant is 503 with Retry-After, whatever its token; another tenant is unaffected; when a slot frees, uploads work again", async () => {
      const f = await createContentFixture("slots");
      const g = await createContentFixture("slots-b");
      const [t1, t2, t3] = [await mintOk(app, f), await mintOk(app, f), await mintOk(app, f)];
      const tg = await mintOk(app, g);
      const port = await serverPort();
      const slowOne = (token: string) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/t/${f.slug}/media/upload/${token}`, headers: { "content-type": "image/png", "transfer-encoding": "chunked" } });
        req.on("error", () => undefined);
        const done = new Promise<number>((resolve) => req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
        req.write(buildPng(1, 1, 128));
        return { req, done };
      };
      const a = slowOne(t1.token);
      const b = slowOne(t2.token);
      await sleep(500); // both are inside the route, holding their slots
      const post = (slug: string, token: string) => fetch(`http://127.0.0.1:${port}/v1/t/${slug}/media/upload/${token}`, { method: "POST", headers: { "content-type": "image/png" }, body: buildPng(3, 3, 200) });
      const full = await post(f.slug, t3.token);
      expect(full.status).toBe(503);
      expect(full.headers.get("retry-after")).toBe("5");
      // no oracle: a bogus token meets the same answer while the house is full (the slot is checked first)
      expect((await post(f.slug, randomBytes(32).toString("base64url"))).status).toBe(503);
      // another tenant has its own allowance
      expect((await post(g.slug, tg.token)).status).toBe(201);
      // the two slow senders finish and free their slots
      a.req.end(Buffer.alloc(16, 0x61));
      b.req.end(Buffer.alloc(16, 0x61));
      expect(await a.done).toBe(201);
      expect(await b.done).toBe(201);
      expect((await post(f.slug, t3.token)).status).toBe(201); // the 503'd token was never touched: it is still good
    }, 30_000);

    it("a stalled sender is cut off at the read deadline (408), its token stays spent (fail closed), and its slot is freed", async () => {
      const f = await createContentFixture("deadline");
      const t = await mintOk(app, f);
      const prev = process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS;
      process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS = "1000";
      try {
        const port = await serverPort();
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/v1/t/${f.slug}/media/upload/${t.token}`, headers: { "content-type": "image/png", "transfer-encoding": "chunked" } });
        req.on("error", () => undefined);
        const status = new Promise<number>((resolve) => req.on("response", (res) => { res.resume(); resolve(res.statusCode ?? 0); }));
        req.write(buildPng(1, 1, 128)); // ... and then silence
        expect(await status).toBe(408);
        expect((await dumpTokens(f))[0].used_at).not.toBeNull();
        expect(await objectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).toEqual([]);
        process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS = prev ?? "";
        expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(404);
        expect((await uploadFile(app, f.slug, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201); // the slot was freed
      } finally {
        if (prev === undefined) delete process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS;
        else process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS = prev;
      }
    }, 30_000);

    it("the limits are configurable and validated: out of range is a 500 (refusing loudly), never silently the default", async () => {
      const f = await createContentFixture("slots-cfg");
      const t = await mintOk(app, f);
      const prev = process.env.WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT;
      try {
        for (const bad of ["0", "9", "abc", "-1", "2.5"]) {
          process.env.WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT = bad;
          expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode, bad).toBe(500);
        }
        process.env.WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT = "";
        expect((await uploadFile(app, f.slug, t.token, buildPng())).statusCode).toBe(201); // empty = the default
      } finally {
        if (prev === undefined) delete process.env.WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT;
        else process.env.WEBDESK_MEDIA_UPLOAD_MAX_CONCURRENT = prev;
      }
    });
  });

  // ==============================================================================================
  // Upload: the identical 404
  // ==============================================================================================
  describe("upload: every invalid-token cause is ONE identical 404", () => {
    const probe = async (slug: string, token: string) => {
      const r = await uploadFile(app, slug, token, buildPng());
      return { status: r.statusCode, body: r.body, type: r.headers["content-type"], connection: r.headers.connection, cors: r.headers["access-control-allow-origin"], cache: r.headers["cache-control"] };
    };

    it("unknown, malformed, expired, spent, another tenant's token, an unknown slug and an archived tenant all answer the same bytes", async () => {
      const f = await createContentFixture("nf");
      const g = await createContentFixture("nf-b");
      const expired = await mintOk(app, f);
      await expireUploadToken(f, expired.tokenId);
      const spent = await mintOk(app, f);
      expect((await uploadFile(app, f.slug, spent.token, buildPng())).statusCode).toBe(201);
      const foreign = await mintOk(app, g); // minted for tenant G, presented under F's slug
      const archived = await createContentFixture("nf-arch");
      const archivedToken = await mintOk(app, archived);
      await asPlatform(async (c) => {
        await c.query(`UPDATE tenants SET status = 'archived' WHERE id = $1`, [archived.tenantId]);
      });

      const unknownToken = await probe(f.slug, randomBytes(32).toString("base64url"));
      expect(unknownToken.status).toBe(404);
      const causes: Record<string, { status: number; body: string; type?: unknown; connection?: unknown; cors?: unknown; cache?: unknown }> = {
        "malformed (too short)": await probe(f.slug, "abc"),
        "malformed (not base64url)": await probe(f.slug, "!".repeat(43)),
        "empty-ish": await probe(f.slug, "-"),
        expired: await probe(f.slug, expired.token),
        spent: await probe(f.slug, spent.token),
        "another tenant's token under this slug": await probe(f.slug, foreign.token),
        "unknown tenant slug": await probe("no-such-tenant-slug", randomBytes(32).toString("base64url")),
        "archived tenant": await probe(archived.slug, archivedToken.token),
        "a REAL token under an unknown slug": await probe("no-such-tenant-slug", (await mintOk(app, f)).token),
      };
      for (const [cause, r] of Object.entries(causes)) expect(r, cause).toEqual(unknownToken);
      expect(unknownToken.body).not.toMatch(/expired|spent|unknown|invalid|token/i); // says nothing about why
      // positive control: the foreign token works under ITS OWN slug
      expect((await uploadFile(app, g.slug, foreign.token, buildPng())).statusCode).toBe(201);
    });

    it("a refused-before-reading 404 ends the connection (Connection: close): a sender streaming a body nobody will read is cut off", async () => {
      const r = await uploadFile(app, fx.slug, randomBytes(32).toString("base64url"), buildPng());
      expect(r.statusCode).toBe(404);
      expect(String(r.headers.connection).toLowerCase()).toBe("close");
    });
  });

  // ==============================================================================================
  // Upload: CORS (the draft-preview rule: only the token's site's environment domains)
  // ==============================================================================================
  describe("upload: CORS is the draft-preview rule", () => {
    const STAGING = "https://staging.up-a.example.test";
    const PROD = "https://www.up-a.example.test";
    let c: ContentFixture;
    beforeAll(async () => {
      c = await createContentFixture("cors");
      await setDomains(c, { staging: "staging.up-a.example.test", production: "www.up-a.example.test" });
    });

    it("the response echoes an Origin that is https://<domain> of an environment of the token's site (staging and production)", async () => {
      for (const origin of [STAGING, PROD]) {
        const t = await mintOk(app, c);
        const res = await uploadFile(app, c.slug, t.token, buildPng(), { origin });
        expect(res.statusCode).toBe(201);
        expect(res.headers["access-control-allow-origin"]).toBe(origin);
        expect(res.headers.vary).toMatch(/Origin/i);
      }
    });

    it("no CORS header for any other Origin: another site, a port, http, a suffix, a sibling subdomain, null; and none without an Origin", async () => {
      for (const origin of ["https://evil.example", `${PROD}:8443`, "http://www.up-a.example.test", "https://www.up-a.example.test.evil.example", "https://x.www.up-a.example.test", "null", ""]) {
        const t = await mintOk(app, c);
        const res = await uploadFile(app, c.slug, t.token, buildPng(), { origin: origin || undefined });
        expect(res.statusCode, origin).toBe(201); // CORS governs who may READ the answer, not who may call
        expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
      }
    });

    it("an error AFTER the token is proven carries the CORS header too (the site's script can read why it failed); a 404 carries none", async () => {
      const t = await mintOk(app, c, { bucket: "media", mime: ["image/png"] });
      const refused = await uploadFile(app, c.slug, t.token, Buffer.from("%PDF-1.4 x"), { contentType: "application/pdf", origin: PROD });
      expect(refused.statusCode).toBe(415);
      expect(refused.headers["access-control-allow-origin"]).toBe(PROD);
      const nf = await uploadFile(app, c.slug, randomBytes(32).toString("base64url"), buildPng(), { origin: PROD });
      expect(nf.statusCode).toBe(404);
      expect(nf.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("the PREFLIGHT: a redeemable token + an allowed Origin -> 204 with the allow headers; a disallowed Origin -> 204 with none; and it spends nothing", async () => {
      const t = await mintOk(app, c);
      const ok = await preflight(app, c.slug, t.token, PROD);
      expect(ok.statusCode).toBe(204);
      expect(ok.headers["access-control-allow-origin"]).toBe(PROD);
      expect(ok.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
      expect(ok.headers["access-control-allow-headers"]).toBe("content-type");
      expect(ok.headers["access-control-max-age"]).toBe("600");
      expect(ok.headers["cache-control"]).toBe("no-store");
      const bad = await preflight(app, c.slug, t.token, "https://evil.example");
      expect(bad.statusCode).toBe(204);
      expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
      expect(bad.headers["access-control-allow-methods"]).toBeUndefined();
      const none = await preflight(app, c.slug, t.token);
      expect(none.statusCode).toBe(204);
      expect(none.headers["access-control-allow-origin"]).toBeUndefined();
      // still unspent after three preflights: the upload works
      expect((await uploadFile(app, c.slug, t.token, buildPng(), { origin: PROD })).statusCode).toBe(201);
    });

    it("the preflight of an unknown, expired, spent or another tenant's token is the same 404 as the upload's (no oracle through OPTIONS)", async () => {
      const spent = await mintOk(app, c);
      expect((await uploadFile(app, c.slug, spent.token, buildPng())).statusCode).toBe(201);
      const expired = await mintOk(app, c);
      await expireUploadToken(c, expired.tokenId);
      const foreign = await mintOk(app, fx);
      const reference = await uploadFile(app, c.slug, randomBytes(32).toString("base64url"), buildPng());
      for (const token of [randomBytes(32).toString("base64url"), "short", spent.token, expired.token, foreign.token]) {
        const r = await preflight(app, c.slug, token, PROD);
        expect(r.statusCode).toBe(404);
        expect(r.body).toBe(reference.body);
        expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      }
      expect((await preflight(app, "no-such-tenant-slug", spent.token, PROD)).statusCode).toBe(404);
    });
  });

  // ==============================================================================================
  // The body parser is scoped to the upload route
  // ==============================================================================================
  describe("the raw-body parser is scoped", () => {
    it("an image body sent to ANY other route is still 415, exactly as before: the control plane and the legacy upload do not start accepting it", async () => {
      const png = buildPng();
      const legacy = await app.inject({ method: "POST", url: `/v1/t/${fx.slug}/media/media`, headers: { "content-type": "image/png", authorization: "Bearer x" }, payload: png });
      expect(legacy.statusCode).toBe(415);
      const control = await app.inject({ method: "POST", url: `${mediaBase(fx)}/upload-token`, headers: { ...hdr(), "content-type": "image/png" }, payload: png });
      expect(control.statusCode).toBe(415);
      const byId = await app.inject({ method: "POST", url: `/v1/t/${fx.slug}/media/${randomUUID()}`, headers: { "content-type": "image/png" }, payload: png });
      expect([404, 405, 415]).toContain(byId.statusCode);
    });

    it("JSON still parses on the legacy upload (the parser did not touch it)", async () => {
      const res = await app.inject({ method: "POST", url: `/v1/t/${fx.slug}/media/media`, headers: { "content-type": "application/json" }, payload: { filename: "x.png" } });
      expect(res.statusCode).toBe(401); // reaches the api-key guard: the body parsed, auth refused
    });
  });

  // ==============================================================================================
  // The token never leaks into error bodies or the problem `instance`
  // ==============================================================================================
  it("a request to the upload path that the route does not serve (GET, PUT, DELETE, HEAD) is answered by the /v1 router with the token REDACTED from the problem `instance`", async () => {
    const token = randomBytes(32).toString("base64url");
    const path = `/v1/t/${fx.slug}/media/upload/${token}`;
    for (const method of ["GET", "PUT", "DELETE", "PATCH"] as const) {
      const r = await app.inject({ method, url: path });
      expect([401, 404, 405], method).toContain(r.statusCode);
      expect(r.body, method).not.toContain(token);
      expect(JSON.stringify(r.headers), method).not.toContain(token);
      expect(r.json().instance, method).toBe(`/v1/t/${fx.slug}/media/upload/:token`);
    }
  });

  it("no response of the route echoes the token (not in a 404, 413, 415 or 201 body, nor in any header)", async () => {
    const f = await createContentFixture("leak");
    const t = await mintOk(app, f, { bucket: "media", maxBytes: 1000, mime: ["image/png"] });
    const attempts = [
      await uploadFile(app, f.slug, t.token, buildPng(1, 1, 5000)), // 413
      await uploadFile(app, f.slug, t.token, Buffer.from("x"), { contentType: "application/pdf" }), // 415
      await uploadFile(app, f.slug, t.token, buildPng(1, 1, 500)), // 201
      await uploadFile(app, f.slug, t.token, buildPng(1, 1, 500)), // 404 (spent)
    ];
    expect(attempts.map((r) => r.statusCode)).toEqual([413, 415, 201, 404]);
    for (const r of attempts) {
      expect(r.body).not.toContain(t.token);
      expect(JSON.stringify(r.headers)).not.toContain(t.token);
    }
    // the stored config is read live, like every media setting
    expect(storageConfig.maxUploadSizeBytes).toBe(CAP);
    // and the DB again: nothing at rest holds it
    for (const r of await dumpTokens(f)) expect(JSON.stringify(r)).not.toContain(t.token);
    for (const r of await asTenant(f.tenantId, async (db) => (await db.query(`SELECT * FROM audit_entries WHERE tenant_id = $1`, [f.tenantId])).rows)) {
      expect(JSON.stringify(r)).not.toContain(t.token);
    }
    expect(assetUrl(f, "x")).toBe(`/v1/t/${f.slug}/media/x`);
    expect((await liveObjectKeysUnderTenant(MEDIA_BUCKET, f.tenantId)).length).toBe(1);
  });
});
