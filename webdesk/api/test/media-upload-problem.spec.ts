// WSK-43a follow-up: every refusal of the public upload route (POST|OPTIONS /v1/t/:tenantSlug/media/upload/:token)
// answers application/problem+json with a stable `type` slug, not Nest's {statusCode, message, error}. One case per
// refusal; each asserts the status (unchanged from before), the content type, the slug, the CORS header (the browser
// reads these cross-origin) and that the token appears nowhere in the body or the headers. The existing
// media-upload-token.spec.ts keeps owning the behaviour (what is stored, what is spent); this file owns the SHAPE.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { PassThrough } from "node:stream";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { LightMyRequestResponse } from "fastify";
import { asPlatform, buildContentApp, createContentFixture, type ContentFixture } from "./content-test-kit";
import { buildEicarPdf, buildJpeg, buildPng, expireUploadToken, mintOk, preflight, uploadFile } from "./media-library-kit";
import { ClamAvService } from "../src/media/clamav.service";
import { MediaService } from "../src/media/media.service";
import { MediaUploadService, readBounded } from "../src/media/media-upload.service";
import { uploadProblemOf } from "../src/media/upload-problem";

const BASE = "https://webdesk.gaiada.online/errors/";
const ERP = "https://erp.test.example";
const CAP = 65_536;

describe("the public upload route answers every refusal as problem+json", () => {
  let app: NestFastifyApplication;
  const saved: Record<string, string | undefined> = {};
  let listening: number | null = null;
  const serverPort = async (): Promise<number> => {
    if (listening === null) {
      await app.listen(0, "127.0.0.1");
      listening = (app.getHttpServer().address() as { port: number }).port;
    }
    return listening;
  };

  beforeAll(async () => {
    for (const k of ["WEBDESK_MEDIA_MAX_UPLOAD_BYTES", "WEBDESK_UPLOAD_CORS_ORIGINS"]) saved[k] = process.env[k];
    process.env.WEBDESK_MEDIA_MAX_UPLOAD_BYTES = String(CAP);
    process.env.WEBDESK_UPLOAD_CORS_ORIGINS = ERP;
    app = await buildContentApp();
  });
  afterAll(async () => {
    await app?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  type Answer = Pick<LightMyRequestResponse, "statusCode" | "headers" | "body">;

  /** status + problem+json + slug + CORS + the token nowhere. */
  function expectProblem(res: Answer, status: number, slug: string, token: string | string[]): Record<string, unknown> {
    expect(res.statusCode, res.body).toBe(status);
    expect(String(res.headers["content-type"])).toMatch(/^application\/problem\+json/);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.type).toBe(`${BASE}${slug}`);
    expect(body.status).toBe(status);
    expect(typeof body.title).toBe("string");
    expect(typeof body.detail).toBe("string");
    expect(body).not.toHaveProperty("statusCode"); // never Nest's default body
    expect(res.headers["access-control-allow-origin"]).toBe(ERP);
    expect(String(res.headers.vary)).toMatch(/Origin/i);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    for (const t of Array.isArray(token) ? token : [token]) {
      expect(res.body).not.toContain(t);
      expect(JSON.stringify(res.headers)).not.toContain(t);
    }
    return body;
  }

  const up = (f: ContentFixture, token: string, body: Parameters<typeof uploadFile>[3], extra: Parameters<typeof uploadFile>[4] = {}) =>
    uploadFile(app, f.slug, token, body, { origin: ERP, ...extra });

  it("the token is unknown, expired, spent, malformed, another tenant's or its tenant archived: 404 upload-not-found, one identical body; the preflight too", async () => {
    const f = await createContentFixture("prob-nf");
    const g = await createContentFixture("prob-nf-b");
    const expired = await mintOk(app, f);
    await expireUploadToken(f, expired.tokenId);
    const spent = await mintOk(app, f);
    expect((await up(f, spent.token, buildPng())).statusCode).toBe(201); // positive control: the same request succeeds once
    const foreign = await mintOk(app, g);
    const archived = await createContentFixture("prob-nf-arch");
    const archivedToken = await mintOk(app, archived);
    await asPlatform(async (c) => {
      await c.query(`UPDATE tenants SET status = 'archived' WHERE id = $1`, [archived.tenantId]);
    });
    const unknown = randomBytes(32).toString("base64url");
    const all = [spent.token, expired.token, foreign.token, archivedToken.token, unknown];
    const reference = expectProblem(await up(f, unknown, buildPng()), 404, "upload-not-found", all);
    const causes: [string, Answer][] = [
      ["malformed", await up(f, "abc", buildPng())],
      ["expired", await up(f, expired.token, buildPng())],
      ["spent", await up(f, spent.token, buildPng())],
      ["another tenants", await up(f, foreign.token, buildPng())],
      ["unknown slug", await uploadFile(app, "no-such-tenant-slug", unknown, buildPng(), { origin: ERP })],
      ["archived tenant", await uploadFile(app, archived.slug, archivedToken.token, buildPng(), { origin: ERP })],
    ];
    for (const [cause, res] of causes) {
      const body = expectProblem(res, 404, "upload-not-found", all);
      expect(body, cause).toEqual(reference);
      expect(res.body, cause).toBe(JSON.stringify(reference));
      expect(res.body, cause).not.toMatch(/expired|spent|unknown|invalid|token/i); // says nothing about why
      expect(res.headers.connection, cause).toBe("close");
    }
    const pre = await preflight(app, f.slug, expired.token, ERP);
    expectProblem(pre, 404, "upload-not-found", all);
    expect(JSON.parse(pre.body)).toEqual(reference);
  });

  it("a type outside the token's set, after the token is proven: 415 upload-type-not-allowed, the token stays good", async () => {
    const f = await createContentFixture("prob-415");
    const t = await mintOk(app, f, { bucket: "media", mime: ["image/png"] });
    expectProblem(await up(f, t.token, Buffer.from("%PDF-1.4 hello"), { contentType: "application/pdf" }), 415, "upload-type-not-allowed", t.token);
    expectProblem(await up(f, t.token, "{}", { contentType: "application/json" }), 415, "upload-type-not-allowed", t.token);
    expect((await up(f, t.token, buildPng())).statusCode).toBe(201); // positive control: the identical token takes a good file
  });

  it("a content type Fastify has no parser for, and no content type with a body (refused before the handler): 415 upload-type-not-allowed, with CORS", async () => {
    const f = await createContentFixture("prob-415b");
    const t = await mintOk(app, f, { bucket: "media", mime: ["image/png"] });
    expectProblem(await up(f, t.token, "<script>alert(1)</script>", { contentType: "text/html" }), 415, "upload-type-not-allowed", t.token);
    expectProblem(await up(f, t.token, buildPng(), { contentType: null }), 415, "upload-type-not-allowed", t.token);
    expect((await up(f, t.token, buildPng())).statusCode).toBe(201);
  });

  it("a malformed JSON body (refused before the handler): 400 invalid-request", async () => {
    const f = await createContentFixture("prob-json");
    const t = await mintOk(app, f);
    expectProblem(await up(f, t.token, "{bad", { contentType: "application/json" }), 400, "invalid-request", t.token);
    expect((await up(f, t.token, buildPng())).statusCode).toBe(201);
  });

  it("over the cap by a declared Content-Length: 413 upload-too-large, the token stays good", async () => {
    const f = await createContentFixture("prob-413");
    const t = await mintOk(app, f, { bucket: "media", maxBytes: 1000, mime: ["image/png"] });
    expectProblem(await up(f, t.token, buildPng(1, 1, 5000)), 413, "upload-too-large", t.token);
    expect((await up(f, t.token, buildPng(1, 1, 500))).statusCode).toBe(201); // positive control
  });

  it("over the cap by a streamed body with no Content-Length (counted while it arrives): 413 upload-too-large", async () => {
    const f = await createContentFixture("prob-413s");
    const t = await mintOk(app, f, { bucket: "media", maxBytes: 1000, mime: ["image/png"] });
    const stream = new PassThrough();
    stream.end(buildPng(1, 1, 5000));
    expectProblem(await up(f, t.token, stream), 413, "upload-too-large", t.token);
  });

  it("a type that does not match the bytes: 400 upload-type-mismatch", async () => {
    const f = await createContentFixture("prob-sniff");
    const t = await mintOk(app, f, { bucket: "media", mime: ["image/png"] });
    expectProblem(await up(f, t.token, buildJpeg(), { contentType: "image/png" }), 400, "upload-type-mismatch", t.token);
    expect((await up(f, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201);
  });

  it("an empty body: 400 upload-empty", async () => {
    const f = await createContentFixture("prob-empty");
    const t = await mintOk(app, f);
    expectProblem(await up(f, t.token, Buffer.alloc(0)), 400, "upload-empty", t.token);
    expect((await up(f, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201);
  });

  it("an infected file: 403 upload-infected, naming the signature", async () => {
    const f = await createContentFixture("prob-eicar");
    const t = await mintOk(app, f, { bucket: "media", mime: ["application/pdf", "image/png"] });
    const body = expectProblem(await up(f, t.token, buildEicarPdf(), { contentType: "application/pdf", filename: "eicar.pdf" }), 403, "upload-infected", t.token);
    expect(String(body.detail)).toMatch(/malware scan matched/i);
    expect((await up(f, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201);
  });

  it("over the tenant's storage quota: 403 upload-quota-exceeded", async () => {
    const f = await createContentFixture("prob-quota");
    const t = await mintOk(app, f);
    const prev = process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES;
    process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES = "1000";
    try {
      expectProblem(await up(f, t.token, buildPng(1, 1, 2048)), 403, "upload-quota-exceeded", t.token);
      expect((await up(f, (await mintOk(app, f)).token, buildPng(1, 1, 900))).statusCode).toBe(201); // positive control: fits
    } finally {
      if (prev === undefined) delete process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES;
      else process.env.WEBDESK_TENANT_STORAGE_QUOTA_BYTES = prev;
    }
  });

  it("a scanner that cannot be reached (fail closed): 503 upload-scan-unavailable, and the scanner's error is not echoed", async () => {
    const f = await createContentFixture("prob-scan");
    const t = await mintOk(app, f);
    const spy = vi.spyOn(app.get(ClamAvService), "scanBuffer").mockRejectedValueOnce(new Error("clamd at 10.9.8.7:3310 refused the connection"));
    try {
      const body = expectProblem(await up(f, t.token, buildPng()), 503, "upload-scan-unavailable", t.token);
      expect(JSON.stringify(body)).not.toContain("10.9.8.7");
    } finally {
      spy.mockRestore();
    }
    expect((await up(f, (await mintOk(app, f)).token, buildPng())).statusCode).toBe(201);
  });

  it("the tenant's upload slots are full: 503 upload-busy with Retry-After, for any token", async () => {
    const f = await createContentFixture("prob-busy");
    const t = await mintOk(app, f);
    const slots = app.get(MediaUploadService).slots;
    const held = [slots.tryAcquire(f.tenantId), slots.tryAcquire(f.tenantId)];
    try {
      expect(held.every((h) => h !== null)).toBe(true);
      const res = await up(f, t.token, buildPng());
      expectProblem(res, 503, "upload-busy", t.token);
      expect(res.headers["retry-after"]).toBe("5");
      const bogus = randomBytes(32).toString("base64url");
      expectProblem(await up(f, bogus, buildPng()), 503, "upload-busy", bogus);
    } finally {
      for (const h of held) h?.();
    }
    expect((await up(f, t.token, buildPng())).statusCode).toBe(201); // the 503'd token was never touched
  });

  it("a sender that stalls past the read deadline: 408 upload-timeout", async () => {
    const f = await createContentFixture("prob-408");
    const t = await mintOk(app, f);
    const prev = process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS;
    process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS = "1000";
    try {
      const port = await serverPort();
      const answer = await new Promise<Answer>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/v1/t/${f.slug}/media/upload/${t.token}`,
          headers: { "content-type": "image/png", "transfer-encoding": "chunked", origin: ERP },
        });
        req.on("error", reject);
        req.on("response", (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, headers: res.headers as Answer["headers"], body }));
        });
        req.write(buildPng(1, 1, 128)); // ...and then silence
      });
      expectProblem(answer, 408, "upload-timeout", t.token);
    } finally {
      if (prev === undefined) delete process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS;
      else process.env.WEBDESK_MEDIA_UPLOAD_TIMEOUT_MS = prev;
    }
  }, 30_000);

  it("an unexpected failure (storage down): 500 internal-error with a fixed detail, never the thrown message", async () => {
    const f = await createContentFixture("prob-500");
    const t = await mintOk(app, f);
    const spy = vi.spyOn(app.get(MediaService), "storeObject").mockRejectedValueOnce(new Error("simulated storage outage at s3.internal"));
    try {
      const body = expectProblem(await up(f, t.token, buildPng()), 500, "internal-error", t.token);
      expect(JSON.stringify(body)).not.toContain("simulated storage outage");
    } finally {
      spy.mockRestore();
    }
  });

  describe("pure: the interrupted sender, and the status-only fallbacks", () => {
    it("a body that is cut off mid-stream: 400 upload-interrupted", async () => {
      const stream = new PassThrough();
      const reading = readBounded(stream, 1000, 5000);
      stream.write(Buffer.from("abc"));
      stream.destroy();
      const err = await reading.catch((e: unknown) => e);
      expect(uploadProblemOf(err).body).toMatchObject({ type: `${BASE}upload-interrupted`, status: 400 });
    });

    it("an exception with no slug maps by status, and a non-HTTP error is a fixed 500", () => {
      expect(uploadProblemOf({ statusCode: 415, message: "Unsupported Media Type: x" }).body).toMatchObject({ type: `${BASE}upload-type-not-allowed`, status: 415 });
      expect(uploadProblemOf({ statusCode: 400, message: "bad" }).body).toMatchObject({ type: `${BASE}invalid-request`, status: 400 });
      const boom = uploadProblemOf(new Error("secret internals"));
      expect(boom.body).toMatchObject({ type: `${BASE}internal-error`, status: 500, detail: "The server could not complete this request." });
      expect(boom.unexpected).toBe(true);
    });
  });

  it("every other route keeps its own answer: the api-key upload still answers Nest's default body (the rewrite is scoped to the token route)", async () => {
    const f = await createContentFixture("prob-scope");
    const noKey = await app.inject({ method: "POST", url: `/v1/t/${f.slug}/media/media`, headers: { "content-type": "application/json" }, payload: { filename: "x.png" } });
    expect(noKey.statusCode).toBe(401);
    expect(String(noKey.headers["content-type"])).not.toMatch(/problem\+json/);
    const html = await app.inject({ method: "POST", url: `/v1/t/${f.slug}/media/media`, headers: { "content-type": "text/html" }, payload: "<b>" });
    expect(html.statusCode).toBe(415);
    expect(String(html.headers["content-type"])).not.toMatch(/problem\+json/);
  });
});
