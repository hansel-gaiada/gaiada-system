// WSK-43b — the media library BFF (`/api/:tenantId/modules/webdev/content/sites/:slug/:site/media…`) and its five MCP tools.
//
// Real: Postgres (RLS, the activities ledger, the approval rows), Cerbos (the real `webdesk_media_asset` policy), the full
// NestJS app (`buildApp()`), the real `WebdeskMediaService`/`WebdeskZoneB`. Stand-in: Zone B, the in-process fake in
// `webdesk-content-testkit.ts`, which is strict where Zone B is (it decodes the editorial assertion and checks
// `cmd`/`ten`/`site`/`cmh`) and models the three media writes, `media.usage` and the filtered `media.list`.
//
// What this proves:
//   golden        every route and every MCP tool has a golden case; the two-row ledger; the editorial assertion's claims
//   token         the upload token is a one-time secret: the answer is exactly {uploadUrl, expiresAt, maxBytes, allowedMimes}, the URL is
//                 the PUBLIC WebDesk one, and the plaintext is in NO ledger row, approval row, outbox row, log line or error
//   in-use        `media-in-use` (409) reaches the caller untouched, with the list of using items (WSK-D54)
//   authz         per action: denied principals get 403 with a VALID body and nothing reaches Zone B; the allowed one succeeds with the same body;
//                 authorize precedes validation; read is held by everyone who may upload
//   wall          company A can never reach company B's site or assets, on every route; a positive control proves the wall is not a blanket 404
//   degraded      breaker open, no signer, no channel, no public URL, ambiguous writes: typed 503/502, nothing minted when it could not be handed out
//   tools         each tool's method + path template resolves to the SAME handler as the HTTP route; impact classes; the D14 pairing
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { EditorialUnavailableError } from "./webdesk-control-client";
import { setWebdeskApprovedCommandDepsForTests, NOT_CONFIGURED_EDITORIAL_SIGNER } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { webdeskPublicBase } from "./webdesk-media.service";
import { webdevModule } from "./index";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, problem, type FakeMediaAsset } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const PUBLIC_BASE = "https://webdesk.test";
const MEDIA_TOOLS = ["webdesk.media.list", "webdesk.media.usage", "webdesk.media.uploadToken", "webdesk.media.update", "webdesk.media.delete"];

describe("webdeskPublicBase(): where the browser uploads (WEBDESK_PUBLIC_BASE_URL)", () => {
  const prev = config.webdeskPublic.baseUrl;
  afterEach(() => {
    config.webdeskPublic.baseUrl = prev;
  });

  it("is the https origin (and any path prefix) without a trailing slash", () => {
    for (const [raw, want] of [
      ["https://webdesk.gaiada.online", "https://webdesk.gaiada.online"],
      ["https://webdesk.gaiada.online/", "https://webdesk.gaiada.online"],
      ["  https://api.example.test/webdesk//  ", "https://api.example.test/webdesk"],
      ["http://localhost:3300", "http://localhost:3300"],
      ["http://127.0.0.1:3300/", "http://127.0.0.1:3300"],
    ]) {
      config.webdeskPublic.baseUrl = raw;
      expect(webdeskPublicBase(), raw).toBe(want);
    }
  });

  it("unset is 503 webdesk_not_configured/webdesk_public_url_not_configured; every unusable value is webdesk_public_url_invalid", () => {
    config.webdeskPublic.baseUrl = "";
    expect(() => webdeskPublicBase()).toThrowError(expect.objectContaining({ response: { message: "webdesk_not_configured", reason: "webdesk_public_url_not_configured" } }));
    for (const bad of ["not a url", "http://webdesk.gaiada.online", "ftp://x.test", "https://u:p@webdesk.test", "https://webdesk.test/?a=1", "https://webdesk.test/#f", "javascript:alert(1)"]) {
      config.webdeskPublic.baseUrl = bad;
      expect(() => webdeskPublicBase(), bad).toThrowError(expect.objectContaining({ response: { message: "webdesk_not_configured", reason: "webdesk_public_url_invalid" } }));
    }
  });
});

describe.skipIf(!live)("WSK-43b · the media library BFF", () => {
  let app: NestFastifyApplication;
  let A: string; // company A: owns the `gaiada` tenant
  let B: string; // company B: owns the `othertenant` tenant
  let adminA: string, editorA: string, managerA: string, publisherA: string, memberA: string, adminB: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();
  const prevPublic = config.webdeskPublic.baseUrl;

  const base = (co = A) => `/api/${co}/modules/webdev/content`;
  const site = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${base(co)}/sites/${slug}/${siteId}`;
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, as: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...asUser(as), ...headers }, payload: payload as never });

  async function ledger(verbLike = "webdesk.media.%") {
    const { rows } = await adminPool().query<{ verb: string; actor_id: string; target_entity_id: string | null; metadata: Record<string, unknown> }>(
      `SELECT verb, actor_id, target_entity_id, metadata FROM activities WHERE tenant_id = $1 AND verb LIKE $2 ORDER BY occurred_at, id`,
      [A, verbLike],
    );
    return rows;
  }
  const clearLedger = () => adminPool().query(`DELETE FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A]);

  let asset: FakeMediaAsset; // an UNUSED asset in A's site
  let used: FakeMediaAsset; // an asset that two items use
  const USERS = [{ itemId: randomUUID(), collectionKey: "service", locale: "en", slug: "service.seo", in: "live" }, { itemId: randomUUID(), collectionKey: "post", locale: "id", slug: "post.satu", in: "head" }];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.webdeskPublic.baseUrl = PUBLIC_BASE;
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-43b Co A", ["webdev"]);
    B = await createCompany("WSK-43b Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "wsk43b-admin-a@ex.test", "company_admin");
    editorA = await mk(A, "wsk43b-editor-a@ex.test", "webdev_staff");
    managerA = await mk(A, "wsk43b-manager-a@ex.test", "manager");
    publisherA = await mk(A, "wsk43b-publisher-a@ex.test", "webdev_manager");
    memberA = await mk(A, "wsk43b-member-a@ex.test", "member");
    adminB = await mk(B, "wsk43b-admin-b@ex.test", "company_admin");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    config.webdeskPublic.baseUrl = PUBLIC_BASE;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    asset = zb.seedMedia({ siteId: GAIADA_SITE, title: "Hero", tags: ["hero"], originalFilename: "hero.png" });
    used = zb.seedMedia({ siteId: GAIADA_SITE, title: "Logo", tags: ["brand"], originalFilename: "logo.svg", mime: "image/svg+xml", usedBy: USERS });
    zb.seedMedia({ siteId: GAIADA_SITE, title: "Gone", tags: ["hero"], originalFilename: "gone.png", deletedAt: new Date().toISOString() });
    await clearLedger();
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    config.webdeskPublic.baseUrl = prevPublic;
    await app?.close();
    await teardownTestDb();
  });

  /** The signer was called with exactly the claims the design gives a MEDIUM command: no `apr`, no `req`. */
  function expectMediumClaims(cmd: string, actor: string) {
    const c = signer.calls.at(-1)!;
    expect(c).toMatchObject({ sub: actor, pk: "human", ten: GAIADA_SLUG, site: GAIADA_SITE, cmd });
    expect(c.cmh).toMatch(/^[0-9a-f]{64}$/);
    expect(c).not.toHaveProperty("apr");
    expect(c).not.toHaveProperty("req");
  }
  async function expectLedger(verb: string, actor: string, outcome: string) {
    const rows = await ledger(verb);
    expect(rows.map((r) => r.metadata.outcome)).toEqual(["attempted", outcome]);
    expect(rows.every((r) => r.actor_id === actor)).toBe(true);
    expect(rows[0].metadata).toMatchObject({ tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("golden cases: reads", () => {
    it("GET …/media (webdesk.media.list): the library, deleted assets hidden; ONLY allow-listed query keys are forwarded", async () => {
      const r = await call("GET", `${site()}/media`, editorA);
      expect(r.statusCode).toBe(200);
      const titles = (r.json().assets as Array<{ title: string }>).map((a) => a.title).sort();
      expect(titles).toEqual(["Hero", "Logo"]);
      expect(zb.calls.at(-1)).toMatchObject({ command: "media.list", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE } });
      expect(await ledger()).toHaveLength(0); // reads write nothing
    });

    it("filters q, tag, mime, includeDeleted, cursor, limit reach Zone B verbatim; an unknown key is a 400 and never forwarded", async () => {
      const r = await call("GET", `${site()}/media?q=hero&tag=hero&mime=image/*&includeDeleted=true&limit=20&cursor=abc`, editorA);
      expect(r.statusCode).toBe(200);
      expect(zb.calls.at(-1)!.query).toEqual({ q: "hero", tag: "hero", mime: "image/*", includeDeleted: "true", limit: "20", cursor: "abc" });
      const only = await call("GET", `${site()}/media?tag=hero&includeDeleted=true`, editorA);
      expect((only.json().assets as unknown[]).length).toBe(2); // Hero + the deleted one
      const calls = zb.calls.length;
      const bad = await call("GET", `${site()}/media?tenantSlug=othertenant`, editorA);
      expect(bad.statusCode).toBe(400);
      expect(zb.calls.length).toBe(calls);
      expect((await call("GET", `${site()}/media?tag=a&tag=b`, editorA)).statusCode).toBe(400); // a repeated key is refused too
    });

    it("GET …/media/:assetId/usage (webdesk.media.usage): where the asset is used", async () => {
      const r = await call("GET", `${site()}/media/${used.assetId}/usage`, editorA);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ assetId: used.assetId, total: 2, items: USERS });
      expect(zb.calls.at(-1)).toMatchObject({ command: "media.usage", params: { assetId: used.assetId } });
      const none = await call("GET", `${site()}/media/${asset.assetId}/usage`, editorA);
      expect(none.json()).toMatchObject({ total: 0, items: [] });
    });

    it("usage of an unknown or malformed asset id is Zone B's typed 404 media-asset-not-found (a malformed id never reaches Zone B)", async () => {
      const unknown = await call("GET", `${site()}/media/${randomUUID()}/usage`, editorA);
      expect(unknown.statusCode).toBe(404);
      expect(unknown.headers["content-type"]).toContain("application/problem+json");
      expect(unknown.json().type).toContain("/media-asset-not-found");
      const calls = zb.calls.length;
      const bad = await call("GET", `${site()}/media/not-a-uuid/usage`, editorA);
      expect(bad.statusCode).toBe(404);
      expect(bad.json().type).toContain("/media-asset-not-found");
      expect(zb.calls.length).toBe(calls);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("golden cases: writes (each with the two-row ledger and a correctly bound editorial assertion)", () => {
    it("POST …/media/upload-token (webdesk.media.uploadToken): 201 {uploadUrl, expiresAt, maxBytes, allowedMimes}; the PUBLIC url; no-store", async () => {
      const r = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media", maxBytes: 2_000_000, mime: ["image/png"] }, { "idempotency-key": "idem-wsk43b-mint-1" });
      expect(r.statusCode).toBe(201);
      expect(r.headers["cache-control"]).toBe("no-store");
      const body = r.json();
      expect(Object.keys(body).sort()).toEqual(["allowedMimes", "expiresAt", "maxBytes", "uploadUrl"]);
      expect(zb.mintedUploadTokens).toHaveLength(1);
      expect(body.uploadUrl).toBe(`${PUBLIC_BASE}/v1/t/${GAIADA_SLUG}/media/upload/${zb.mintedUploadTokens[0]}`);
      expect(body).toMatchObject({ maxBytes: 2_000_000, allowedMimes: ["image/png"] });
      expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false);
      const w = zb.writes.at(-1)!;
      expect(w).toMatchObject({ command: "media.uploadToken", method: "POST", idempotencyKey: "idem-wsk43b-mint-1" });
      expect(w.body).toEqual({ bucket: "media", maxBytes: 2_000_000, mime: ["image/png"] });
      expect(w.params).toEqual({ tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE });
      expectMediumClaims("media.uploadToken", editorA);
      await expectLedger("webdesk.media.uploadToken", editorA, "succeeded");
      expect((await ledger())[0].metadata).toMatchObject({ bucket: "media", maxBytes: 2_000_000 });
    });

    it("the mint: bucket is required (400); Zone B's own typed 400 for a bad bucket passes through; a body key outside the allow-list is a 400", async () => {
      expect((await call("POST", `${site()}/media/upload-token`, editorA, {})).statusCode).toBe(400);
      expect((await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media", filename: "x.png" })).statusCode).toBe(400);
      expect((await call("POST", `${site()}/media/upload-token`, editorA, [1])).statusCode).toBe(400);
      const bad = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "secrets" });
      expect(bad.statusCode).toBe(400);
      expect(bad.headers["content-type"]).toContain("application/problem+json");
      expect(bad.json().type).toContain("/invalid-request");
      expect(zb.mintedUploadTokens).toHaveLength(0);
    });

    it("a mint without an Idempotency-Key generates one per call (two mints are two tokens); a replay of ONE key is Zone B's 409 idempotency-response-withheld", async () => {
      const a = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" });
      const b = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" });
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(a.json().uploadUrl).not.toBe(b.json().uploadUrl);
      expect(zb.writes[0].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      const k = { "idempotency-key": "idem-wsk43b-replay-1" };
      expect((await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" }, k)).statusCode).toBe(201);
      const replay = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" }, k);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().type).toContain("/idempotency-response-withheld");
      expect(JSON.stringify(replay.json())).not.toContain(zb.mintedUploadTokens[2]);
      expect((await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" }, { "idempotency-key": "short" })).statusCode).toBe(400);
    });

    it("PATCH …/media/:assetId (webdesk.media.update): 200 {asset}; title, alt and tags; ledger records the FIELDS, never the values", async () => {
      const r = await call("PATCH", `${site()}/media/${asset.assetId}`, editorA, { title: "New hero", alt: { en: "A hero banner" }, tags: ["hero", "home"] }, { "idempotency-key": "idem-wsk43b-upd-1" });
      expect(r.statusCode).toBe(200);
      expect(r.json().asset).toMatchObject({ assetId: asset.assetId, title: "New hero", alt: { en: "A hero banner" }, tags: ["hero", "home"] });
      expect(zb.writes.at(-1)).toMatchObject({ command: "media.update", method: "PATCH", idempotencyKey: "idem-wsk43b-upd-1", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, assetId: asset.assetId } });
      expectMediumClaims("media.update", editorA);
      await expectLedger("webdesk.media.update", editorA, "succeeded");
      const rows = await ledger();
      expect(rows[0].metadata).toMatchObject({ assetId: asset.assetId, fields: ["title", "alt", "tags"] });
      expect(rows[0].target_entity_id).toBe(asset.assetId);
      expect(JSON.stringify(rows)).not.toContain("A hero banner"); // identifiers and outcomes only, never content values
      expect(JSON.stringify(rows)).not.toContain("New hero");
    });

    it("update: an empty body, an unknown key and a non-object are 400; a deleted asset is Zone B's typed 409; an unknown asset is 404", async () => {
      expect((await call("PATCH", `${site()}/media/${asset.assetId}`, editorA, {})).statusCode).toBe(400);
      expect((await call("PATCH", `${site()}/media/${asset.assetId}`, editorA, { bucket: "media" })).statusCode).toBe(400);
      expect((await call("PATCH", `${site()}/media/${asset.assetId}`, editorA, [1])).statusCode).toBe(400);
      expect(zb.writes).toHaveLength(0);
      const gone = [...zb.media.values()].find((a) => a.deletedAt)!;
      const deleted = await call("PATCH", `${site()}/media/${gone.assetId}`, editorA, { title: "x" });
      expect(deleted.statusCode).toBe(409);
      expect(deleted.json().type).toContain("/media-asset-deleted");
      expect((await call("PATCH", `${site()}/media/${randomUUID()}`, editorA, { title: "x" })).json().type).toContain("/media-asset-not-found");
      expect((await call("PATCH", `${site()}/media/not-a-uuid`, editorA, { title: "x" })).statusCode).toBe(404);
    });

    it("DELETE …/media/:assetId (webdesk.media.delete): a publisher soft-deletes an UNUSED asset; no body is sent; ledger rows; a repeat is alreadyDeleted", async () => {
      const r = await call("DELETE", `${site()}/media/${asset.assetId}`, publisherA, undefined, { "idempotency-key": "idem-wsk43b-del-1" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ assetId: asset.assetId, alreadyDeleted: false });
      expect(r.json().deletedAt).toEqual(expect.any(String));
      const w = zb.writes.at(-1)!;
      expect(w).toMatchObject({ command: "media.delete", method: "DELETE", idempotencyKey: "idem-wsk43b-del-1", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, assetId: asset.assetId } });
      expect(w.body).toBeUndefined();
      expectMediumClaims("media.delete", publisherA);
      await expectLedger("webdesk.media.delete", publisherA, "succeeded");
      const again = await call("DELETE", `${site()}/media/${asset.assetId}`, publisherA);
      expect(again.json()).toMatchObject({ alreadyDeleted: true });
      expect(zb.media.get(asset.assetId)!.deletedAt).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the upload token is a ONE-TIME SECRET: in the response once, and in no ledger row, approval row, outbox row, log line or error", () => {
    it("the plaintext appears exactly once, in the 201; nowhere else", async () => {
      const captured: string[] = [];
      const outWrite = process.stdout.write.bind(process.stdout);
      const errWrite = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (outWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        captured.push(String(chunk));
        return (errWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
      const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
        }),
      );
      let r: Awaited<ReturnType<typeof call>>;
      try {
        r = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" });
      } finally {
        process.stdout.write = outWrite as typeof process.stdout.write;
        process.stderr.write = errWrite as typeof process.stderr.write;
        consoleSpies.forEach((s) => s.mockRestore());
      }
      expect(r.statusCode).toBe(201);
      expect(zb.mintedUploadTokens).toHaveLength(1);
      const token = zb.mintedUploadTokens[0];
      expect(r.body.split(token)).toHaveLength(2); // exactly once

      const scan = async (table: string) => (await adminPool().query<{ t: string | null }>(`SELECT string_agg(x::text, E'\\n') AS t FROM ${table} x`)).rows[0].t ?? "";
      const activities = await scan("activities");
      expect(activities).toContain("webdesk.media.uploadToken"); // the scan sees the ledger rows …
      expect(activities).not.toContain(token); // … and none holds the secret
      expect(await scan("automation_approvals")).not.toContain(token);
      expect(await scan("outbox_events")).not.toContain(token);
      expect(captured.join("\n")).not.toContain(token);
    });

    it("a Zone B answer that is not the expected shape is a 502 upload_token_shape and the error never carries the answer", async () => {
      const token = "T".repeat(43);
      const shapes: unknown[] = [
        { token, uploadPath: "/v1/t/evil/media/upload/" + token, expiresAt: "2099-01-01T00:00:00Z", maxBytes: 1, allowedMimes: ["image/png"] }, // another tenant's path
        { token, uploadPath: `/v1/t/${GAIADA_SLUG}/media/upload/short`, expiresAt: "2099-01-01T00:00:00Z", maxBytes: 1, allowedMimes: ["image/png"] },
        { token, uploadPath: `https://evil.test/v1/t/${GAIADA_SLUG}/media/upload/${token}`, expiresAt: "2099-01-01T00:00:00Z", maxBytes: 1, allowedMimes: ["image/png"] },
        { token, expiresAt: "2099-01-01T00:00:00Z", maxBytes: 1, allowedMimes: ["image/png"] }, // no uploadPath
        { token, uploadPath: `/v1/t/${GAIADA_SLUG}/media/upload/${token}`, expiresAt: "2099-01-01T00:00:00Z", maxBytes: "1", allowedMimes: ["image/png"] },
        { token, uploadPath: `/v1/t/${GAIADA_SLUG}/media/upload/${token}`, expiresAt: "2099-01-01T00:00:00Z", maxBytes: 1, allowedMimes: [1] },
      ];
      for (const [i, json] of shapes.entries()) {
        zb.nextWriteResponse = { status: 201, contentType: "application/json", json, bodyText: JSON.stringify(json) };
        const r = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" });
        expect(r.statusCode, `shape ${i}`).toBe(502);
        expect(r.json(), `shape ${i}`).toMatchObject({ error: "webdesk_error", reason: "upload_token_shape" });
        expect(r.body, `shape ${i}`).not.toContain(token);
      }
    });

    it("no public URL configured: 503 webdesk_not_configured BEFORE anything is minted or ledgered; reads still work", async () => {
      config.webdeskPublic.baseUrl = "";
      const r = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: "webdesk_not_configured", reason: "webdesk_public_url_not_configured" });
      expect(zb.writes).toHaveLength(0);
      expect(zb.mintedUploadTokens).toHaveLength(0);
      expect(await ledger()).toHaveLength(0);
      expect((await call("GET", `${site()}/media`, editorA)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("media-in-use (WSK-D54): a delete of an asset content uses is Zone B's 409, with the using items, untouched", () => {
    it("409 application/problem+json with `items` exactly as Zone B sent them; the asset is NOT deleted; the ledger records a refusal", async () => {
      const r = await call("DELETE", `${site()}/media/${used.assetId}`, publisherA);
      expect(r.statusCode).toBe(409);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(r.json()).toEqual({
        type: "https://webdesk.gaiada.online/errors/media-in-use",
        title: "media-in-use",
        status: 409,
        detail: "The asset is used by content.",
        total: 2,
        items: USERS,
      });
      expect(zb.media.get(used.assetId)!.deletedAt).toBeNull();
      const rows = await ledger("webdesk.media.delete");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "refused"]);
      expect(rows[1].metadata).toMatchObject({ status: 409, problem: "media-in-use" });
      // after the editor removes the usage the same delete passes (the refusal is state, not a policy)
      used.usedBy = [];
      expect((await call("DELETE", `${site()}/media/${used.assetId}`, publisherA)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("authorization: authorize() is FIRST; denials send VALID bodies, each paired with an allowed control; read is held by everyone who may upload", () => {
    type Case = { name: string; method: "GET" | "POST" | "PATCH" | "DELETE"; verb: string; path: () => string; body?: () => unknown; allowed: () => string[]; denied: () => string[] };
    const cases: Case[] = [
      { name: "read (list)", method: "GET", verb: "none", path: () => `${site()}/media`, allowed: () => [editorA, managerA, publisherA, adminA], denied: () => [memberA] },
      { name: "read (usage)", method: "GET", verb: "none", path: () => `${site()}/media/${used.assetId}/usage`, allowed: () => [editorA, managerA, publisherA, adminA], denied: () => [memberA] },
      { name: "upload", method: "POST", verb: "webdesk.media.uploadToken", path: () => `${site()}/media/upload-token`, body: () => ({ bucket: "media" }), allowed: () => [editorA, managerA, publisherA, adminA], denied: () => [memberA] },
      { name: "update", method: "PATCH", verb: "webdesk.media.update", path: () => `${site()}/media/${asset.assetId}`, body: () => ({ title: "t" }), allowed: () => [editorA, managerA, publisherA, adminA], denied: () => [memberA] },
      // delete is the PUBLISHER tier: an editor and a company-scope `manager` are denied, the publisher and the admin allowed
      { name: "delete", method: "DELETE", verb: "webdesk.media.delete", path: () => `${site()}/media/${asset.assetId}`, allowed: () => [publisherA, adminA], denied: () => [editorA, managerA, memberA] },
    ];

    for (const c of cases) {
      it(`${c.name}: denied principals get 403 with a VALID body and NOTHING reaches Zone B; each allowed principal succeeds with the identical request`, async () => {
        for (const who of c.denied()) {
          zb.calls.length = 0;
          const r = await call(c.method, c.path(), who, c.body?.());
          expect(r.statusCode, `${c.name} as ${who}`).toBe(403);
          expect(zb.calls, `${c.name} as ${who}: no egress at all`).toHaveLength(0);
          expect(await ledger()).toHaveLength(0);
        }
        for (const who of c.allowed()) {
          if (c.name === "delete") zb.media.get(asset.assetId)!.deletedAt = null;
          const r = await call(c.method, c.path(), who, c.body?.());
          expect([200, 201], `${c.name} as ${who}: ${r.body}`).toContain(r.statusCode);
        }
      });
    }

    it("authorize precedes validation: a denied caller with an INVALID body is still 403, an authorized one is 400", async () => {
      expect((await call("POST", `${site()}/media/upload-token`, memberA, { nonsense: true })).statusCode).toBe(403);
      expect((await call("POST", `${site()}/media/upload-token`, editorA, { nonsense: true })).statusCode).toBe(400);
      expect((await call("PATCH", `${site()}/media/${asset.assetId}`, memberA, {})).statusCode).toBe(403);
      expect((await call("PATCH", `${site()}/media/${asset.assetId}`, editorA, {})).statusCode).toBe(400);
      expect((await call("GET", `${site()}/media?bogus=1`, memberA)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/media?bogus=1`, editorA)).statusCode).toBe(400);
      expect((await call("DELETE", `${site()}/media/not-a-uuid`, editorA)).statusCode).toBe(403);
      expect((await call("DELETE", `${site()}/media/not-a-uuid`, publisherA)).statusCode).toBe(404);
      expect(zb.writes).toHaveLength(0);
    });

    it("requires authentication (401) and the webdev module on the company (404)", async () => {
      expect((await app.inject({ method: "GET", url: `${site()}/media` })).statusCode).toBe(401);
      const noModule = await createCompany("WSK-43b No Webdev", ["pm"]);
      const u = await createUser("wsk43b-nomod@ex.test");
      await addMembership(noModule, u);
      expect((await call("GET", `/api/${noModule}/modules/webdev/content/sites/${GAIADA_SLUG}/${GAIADA_SITE}/media`, u)).statusCode).toBe(404);
    });

    it("the library is not reachable through content rights: a principal that holds only webdesk_content_item rights through the SAME role gets the same answer as before (the kind is new, the tiers match)", async () => {
      // webdev_staff holds content read + media read; member holds neither. (No role holds one without the other.)
      expect((await call("GET", `${base()}/sites/${GAIADA_SLUG}/${GAIADA_SITE}/collections`, editorA)).statusCode).toBe(200);
      expect((await call("GET", `${base()}/sites/${GAIADA_SLUG}/${GAIADA_SITE}/collections`, memberA)).statusCode).toBe(403);
      expect((await call("GET", `${site()}/media`, memberA)).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the cross-company wall: company A's user can never reach company B's site or assets", () => {
    const routes = (slug: string, sid: string, id: string): Array<[string, "GET" | "POST" | "PATCH" | "DELETE", string, unknown?]> => {
      const s = `/sites/${slug}/${sid}`;
      return [
        ["list", "GET", `${s}/media`],
        ["usage", "GET", `${s}/media/${id}/usage`],
        ["upload-token", "POST", `${s}/media/upload-token`, { bucket: "media" }],
        ["update", "PATCH", `${s}/media/${id}`, { title: "x" }],
        ["delete", "DELETE", `${s}/media/${id}`],
      ];
    };

    it("🔴 admin of A, on A's own company path, addressing B's tenant+site: 404 site-not-found on every route, and Zone B sees no call naming B's site", async () => {
      const foreign = zb.seedMedia({ siteId: OTHER_SITE, title: "B's asset" });
      for (const [name, method, path, body] of routes(OTHER_SLUG, OTHER_SITE, foreign.assetId)) {
        const r = await call(method, `${base(A)}${path}`, adminA, body);
        expect(r.statusCode, name).toBe(404);
        expect(r.json(), name).toMatchObject({ type: "https://webdesk.gaiada.online/errors/site-not-found", status: 404 });
        expect(r.headers["content-type"], name).toContain("application/problem+json");
      }
      expect(zb.calls.filter((c) => c.params.siteId === OTHER_SITE)).toHaveLength(0);
      expect(zb.writes).toHaveLength(0);
      expect(zb.mintedUploadTokens).toHaveLength(0);
    });

    it("an asset of ANOTHER site reached through A's own site is Zone B's 404 media-asset-not-found (and the same for every write)", async () => {
      const foreign = zb.seedMedia({ siteId: OTHER_SITE, title: "B's asset" });
      for (const [name, method, path] of [["usage", "GET", "/usage"], ["update", "PATCH", ""], ["delete", "DELETE", ""]] as const) {
        const r = await call(method, `${site()}/media/${foreign.assetId}${path}`, adminA, name === "update" ? { title: "stolen" } : undefined);
        expect(r.statusCode, name).toBe(404);
        expect(r.json().type, name).toContain("/media-asset-not-found");
      }
      expect(zb.media.get(foreign.assetId)).toMatchObject({ title: "B's asset", deletedAt: null });
    });

    it("a real tenant slug paired with ANOTHER tenant's site id, and an unknown site: the same 404", async () => {
      for (const [slug, sid] of [[GAIADA_SLUG, OTHER_SITE], [OTHER_SLUG, GAIADA_SITE], [GAIADA_SLUG, randomUUID()]]) {
        const r = await call("PATCH", `${site(A, slug, sid)}/media/${asset.assetId}`, adminA, { title: "z" });
        expect(r.statusCode, `${slug}/${sid}`).toBe(404);
      }
      expect(zb.writes).toHaveLength(0);
    });

    it("POSITIVE CONTROL: the identical requests against A's OWN site succeed (the wall refuses only the foreign pair)", async () => {
      for (const [name, method, path, body] of routes(GAIADA_SLUG, GAIADA_SITE, asset.assetId)) {
        const r = await call(method, `${base(A)}${path}`, adminA, body);
        expect([200, 201], `${name}: ${r.body}`).toContain(r.statusCode);
      }
    });

    it("admin of B reaches B's site and is refused A's; B's admin cannot use A's company path at all", async () => {
      expect((await call("GET", `${site(B, OTHER_SLUG, OTHER_SITE)}/media`, adminB)).statusCode).toBe(200);
      expect((await call("GET", `${site(B, GAIADA_SLUG, GAIADA_SITE)}/media`, adminB)).statusCode).toBe(404);
      expect((await call("GET", `${site(A)}/media`, adminB)).statusCode).toBe(403);
      expect((await call("POST", `${site(A)}/media/upload-token`, adminB, { bucket: "media" })).statusCode).toBe(403);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("degraded: typed 503/502, nothing half-done", () => {
    const reads = (): Array<[string, string]> => [
      ["list", `${site()}/media`],
      ["usage", `${site()}/media/${used.assetId}/usage`],
    ];
    const writes = (): Array<[string, "POST" | "PATCH" | "DELETE", string, unknown]> => [
      ["upload-token", "POST", `${site()}/media/upload-token`, { bucket: "media" }],
      ["update", "PATCH", `${site()}/media/${asset.assetId}`, { title: "d" }],
      ["delete", "DELETE", `${site()}/media/${asset.assetId}`, undefined],
    ];

    it("🔴 breaker open: every read and every write is a typed 503 editorial_unavailable (wall cold) — never an empty list, nothing sent", async () => {
      zb.failWith = new EditorialUnavailableError(25_000);
      webdeskZoneB.clearSiteCache();
      for (const [name, url] of reads()) {
        const r = await call("GET", url, adminA);
        expect(r.statusCode, name).toBe(503);
        expect(r.json(), name).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
        expect(r.json(), name).not.toHaveProperty("assets");
      }
      for (const [name, method, url, body] of writes()) {
        const r = await call(method, url, adminA, body);
        expect(r.statusCode, name).toBe(503);
        expect(r.json(), name).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
      }
      expect(zb.writes).toHaveLength(0);
      expect(zb.mintedUploadTokens).toHaveLength(0);
    });

    it("no editorial signer registered: every WRITE is 503 webdesk_not_configured BEFORE any ledger row or egress; reads still work", async () => {
      setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer: NOT_CONFIGURED_EDITORIAL_SIGNER });
      for (const [name, method, url, body] of writes()) {
        zb.calls.length = 0;
        const r = await call(method, url, adminA, body);
        expect(r.statusCode, name).toBe(503);
        expect(r.json(), name).toMatchObject({ error: "webdesk_not_configured", reason: "editorial_signer_not_configured" });
        expect(zb.writes, name).toHaveLength(0);
      }
      expect(await ledger()).toHaveLength(0);
      expect((await call("GET", `${site()}/media`, adminA)).statusCode).toBe(200);
    });

    it("no control channel configured: reads AND writes are 503 webdesk_not_configured", async () => {
      setWebdeskApprovedCommandDepsForTests(null);
      const read = await call("GET", `${site()}/media`, adminA);
      expect(read.statusCode).toBe(503);
      expect(read.json()).toMatchObject({ error: "webdesk_not_configured", reason: "control_channel_not_configured" });
      const write = await call("PATCH", `${site()}/media/${asset.assetId}`, adminA, { title: "n" });
      expect(write.statusCode).toBe(503);
      expect(write.json()).toMatchObject({ error: "webdesk_not_configured" });
    });

    it("an AMBIGUOUS write (the link died after it was sent) is 502 webdesk_ambiguous, never success, never resent; the same Idempotency-Key retry converges", async () => {
      const idem = { "idempotency-key": "idem-wsk43b-ambig-1" };
      zb.dropAfterApply = true;
      const r = await call("DELETE", `${site()}/media/${asset.assetId}`, publisherA, undefined, idem);
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_ambiguous", reason: "not_observed" });
      expect(zb.writes).toHaveLength(1); // never resent
      expect((await ledger("webdesk.media.delete")).map((x) => x.metadata.outcome)).toEqual(["attempted", "ambiguous"]);
      const retry = await call("DELETE", `${site()}/media/${asset.assetId}`, publisherA, undefined, idem);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ alreadyDeleted: true });
      expect(zb.writes.at(-1)!.idempotencyKey).toBe("idem-wsk43b-ambig-1");

      zb.dropAfterApply = true;
      const upd = await call("PATCH", `${site()}/media/${used.assetId}`, editorA, { title: "ambiguous" });
      expect(upd.statusCode).toBe(502);
      expect(upd.json()).toMatchObject({ error: "webdesk_ambiguous" });

      zb.dropBeforeApply = true;
      const mint = await call("POST", `${site()}/media/upload-token`, editorA, { bucket: "media" });
      expect(mint.statusCode).toBe(502);
      expect(mint.json()).toMatchObject({ error: "webdesk_ambiguous" });
    });

    it("Zone B's 401/403 (OUR credentials or signing refused) are NEVER forwarded: a 502 webdesk_refused", async () => {
      zb.nextWriteResponse = problem(401, "editorial-assertion-invalid-signature");
      const r = await call("PATCH", `${site()}/media/${asset.assetId}`, editorA, { title: "q" });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_refused", reason: "editorial-assertion-invalid-signature" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the MCP tools: each tool's method + path template resolves to the SAME handler as its HTTP route", () => {
    /** The hub's `callPlatform`, restated against the module's real tool declaration (mcp-hub/src/module-tools.ts). */
    async function viaTool(name: string, args: Record<string, unknown>, as: string, headers: Record<string, string> = {}) {
      const def = webdevModule.mcpTools.find((t) => t.name === name);
      if (!def || !def.pathTemplate) throw new Error(`no callable tool ${name}`);
      const used = new Set<string>();
      const path = def.pathTemplate.replace(/:([A-Za-z0-9_]+)/g, (_m, p: string) => {
        used.add(p);
        return encodeURIComponent(String(args[p]));
      });
      const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
      const method = (def.method ?? "GET") as "GET" | "POST" | "PATCH" | "DELETE";
      return app.inject({
        method,
        url: path,
        headers: { ...asUser(as), ...(method !== "GET" ? { "content-type": "application/json" } : {}), ...headers },
        payload: method === "GET" ? undefined : JSON.stringify(rest),
      });
    }
    const scope = () => ({ tenantId: A, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE });

    it("the five tools exist with the declared impact classes: list/usage read, uploadToken/update/delete medium writes", () => {
      const defs = webdevModule.mcpTools.filter((t) => t.name.startsWith("webdesk.media."));
      expect(defs.map((d) => d.name).sort()).toEqual([...MEDIA_TOOLS].sort());
      for (const d of defs) {
        const reads = d.name === "webdesk.media.list" || d.name === "webdesk.media.usage";
        expect(d.write ?? false, d.name).toBe(!reads);
        expect(d.impact, d.name).toBe(reads ? undefined : "medium");
        expect(d.minAssurance, d.name).toBe("low");
        expect(d.pathTemplate, d.name).toContain("/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media");
      }
    });

    it("list / usage: the tool and the HTTP route return the identical body", async () => {
      const viaHttp = await call("GET", `${site()}/media`, editorA);
      const viaHub = await viaTool("webdesk.media.list", scope(), editorA);
      expect(viaHub.statusCode).toBe(200);
      expect(viaHub.json()).toEqual(viaHttp.json());
      const u1 = await call("GET", `${site()}/media/${used.assetId}/usage`, editorA);
      const u2 = await viaTool("webdesk.media.usage", { ...scope(), assetId: used.assetId }, editorA);
      expect(u2.json()).toEqual(u1.json());
    });

    it("uploadToken: the tool mints through the same handler (same shape, public URL, editorial claims, ledger)", async () => {
      const r = await viaTool("webdesk.media.uploadToken", { ...scope(), bucket: "media", maxBytes: 1_000_000 }, editorA);
      expect(r.statusCode).toBe(201);
      expect(Object.keys(r.json()).sort()).toEqual(["allowedMimes", "expiresAt", "maxBytes", "uploadUrl"]);
      expect(r.json().uploadUrl).toBe(`${PUBLIC_BASE}/v1/t/${GAIADA_SLUG}/media/upload/${zb.mintedUploadTokens[0]}`);
      expect(zb.writes.at(-1)!.body).toEqual({ bucket: "media", maxBytes: 1_000_000 });
      expectMediumClaims("media.uploadToken", editorA);
      await expectLedger("webdesk.media.uploadToken", editorA, "succeeded");
    });

    it("update / delete: the tool runs the same handler; the hub's body-less DELETE (it sends {}) is accepted; authorization is the same Cerbos rule", async () => {
      const u = await viaTool("webdesk.media.update", { ...scope(), assetId: asset.assetId, tags: ["x"] }, editorA);
      expect(u.statusCode).toBe(200);
      expect(u.json().asset.tags).toEqual(["x"]);
      expectMediumClaims("media.update", editorA);
      // the editor is denied delete over the tool exactly as over HTTP
      expect((await viaTool("webdesk.media.delete", { ...scope(), assetId: asset.assetId }, editorA)).statusCode).toBe(403);
      const d = await viaTool("webdesk.media.delete", { ...scope(), assetId: asset.assetId }, publisherA);
      expect(d.statusCode).toBe(200);
      expect(d.json()).toMatchObject({ assetId: asset.assetId, alreadyDeleted: false });
      expect(zb.writes.at(-1)!.body).toBeUndefined();
      expectMediumClaims("media.delete", publisherA);
    });

    it("webdesk.media.usage before webdesk.media.delete: the agent can see the using items even though the hub drops a problem body", async () => {
      const usage = await viaTool("webdesk.media.usage", { ...scope(), assetId: used.assetId }, publisherA);
      expect(usage.json().items).toEqual(USERS);
      expect((await viaTool("webdesk.media.delete", { ...scope(), assetId: used.assetId }, publisherA)).statusCode).toBe(409);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("D14: update and delete are paired in BOTH places; uploadToken is deliberately in neither", () => {
    const yaml = readFileSync(join(__dirname, "../../../cerbos/policies/resource_mcp_tool.yaml"), "utf8");
    const listed = (name: string) => yaml.includes(`"${name}"`);

    it("resource_mcp_tool.yaml's executable list names webdesk.media.update and webdesk.media.delete, and NOT webdesk.media.uploadToken", () => {
      expect(listed("webdesk.media.update")).toBe(true);
      expect(listed("webdesk.media.delete")).toBe(true);
      expect(listed("webdesk.media.uploadToken")).toBe(false);
      expect(listed("webdesk.media.list")).toBe(false);
      expect(listed("webdesk.media.usage")).toBe(false);
    });

    // The live half: an unattended principal (agent or n8n) is let through a medium write ONLY with a verified approval grant AND only for the
    // listed names. Raw check against the running Cerbos, shaped exactly as mcp-hub/src/cerbos.ts sends it.
    const unattended = { id: "agent-43b", roles: ["hub_caller"], attr: { assurance: "low", provider: "whatsapp", isAutomation: false, automationScope: [], isUnattended: true, agent: "agent:webdesk-ops" } };
    const attended = { ...unattended, attr: { ...unattended.attr, isUnattended: false, agent: "" } };
    async function allowed(principal: typeof unattended, name: string, write: boolean, impact: string, approvalId?: string): Promise<boolean> {
      const res = await fetch(`${process.env.CERBOS_URL}/api/check/resources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "wsk43b",
          principal,
          resources: [{ actions: ["call"], resource: { kind: "mcp_tool", id: name, attr: { name, minAssurance: "low", write, impact, ...(approvalId ? { approvalId } : {}) } } }],
        }),
      });
      const j = (await res.json()) as { results: Array<{ actions: Record<string, string> }> };
      return j.results[0].actions.call === "EFFECT_ALLOW";
    }

    it("LIVE: an unattended caller is DENIED update/delete with no grant (it suspends) and ALLOWED with one (the re-drive); uploadToken is denied EVEN WITH a grant", async () => {
      for (const n of ["webdesk.media.update", "webdesk.media.delete"]) {
        expect(await allowed(unattended, n, true, "medium"), `${n} no grant`).toBe(false);
        expect(await allowed(unattended, n, true, "medium", "appr-1"), `${n} granted`).toBe(true);
        expect(await allowed(attended, n, true, "medium"), `${n} attended human`).toBe(true);
      }
      expect(await allowed(unattended, "webdesk.media.uploadToken", true, "medium"), "uploadToken no grant").toBe(false);
      expect(await allowed(unattended, "webdesk.media.uploadToken", true, "medium", "appr-1"), "uploadToken with a grant").toBe(false);
      expect(await allowed(attended, "webdesk.media.uploadToken", true, "medium"), "uploadToken attended").toBe(true);
      expect(await allowed(unattended, "webdesk.media.notListed", true, "medium", "appr-1"), "an unlisted medium tool is denied even with a grant").toBe(false);
    });

    it("LIVE: reads are allowed for an unattended caller with no grant", async () => {
      for (const n of ["webdesk.media.list", "webdesk.media.usage"]) expect(await allowed(unattended, n, false, ""), n).toBe(true);
    });
  });
});
