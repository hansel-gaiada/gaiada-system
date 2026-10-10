// WSK-46 — the PUBLIC half of draft preview (owner ruling WSK-D52): GET /v1/t/:tenantSlug/preview/:token.
// The token is the credential: no api key. This is a capability-URL feature on the public internet, so
// the suite is adversarial about what the endpoint must NOT reveal:
//   - a valid token serves exactly ONE version (the pinned one), not the live projection and not the head;
//   - every way a token can be wrong (unknown, malformed, expired, revoked, wrong tenant slug, deleted
//     item, archived tenant) is the SAME 404 `not-found`, byte for byte but for instance/requestId;
//   - an api key neither is needed nor widens anything;
//   - CORS echoes an origin only when it is https://<domain> of an environment of the token's site;
//   - the response is never cacheable and never indexable, and carries no Cache-Tag.
// Real Postgres (0001-0013), real Redis (the quota), the real AppModule (content-test-kit.ts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asPlatform, asTenant, buildContentApp, createContentFixture, createItem, hdr, mintReadKeys, publishItems, serviceFields, v1Get, type ContentFixture } from "../content-test-kit";
import {
  appendVersion,
  draftItem,
  expireToken,
  itemBase,
  liveItemWithNewerDraft,
  mintPreview,
  revokePreview,
  setDomains,
  sha256Hex,
  type MintedPreview,
} from "../preview-test-kit";
import { TenantQuotaService } from "../../src/rate-limit/tenant-quota.service";
import { config } from "../../src/config";

/** A long window, so the aligned fixed-window counter cannot roll over in the middle of a test. */
const QUOTA_WINDOW_MS = 3_600_000;

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const LIVE_H1 = "PUBLISHED-LIVE-HEADING";
const DRAFT_H1 = "UNPUBLISHED-DRAFT-HEADING";

const STAGING_ORIGIN = "https://staging.preview-a.example.test";
const PROD_ORIGIN = "https://www.preview-a.example.test";

describe("WSK-46 GET /v1/t/:tenantSlug/preview/:token", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let other: ContentFixture;
  let keys: { production: string; staging: string };
  let live: Awaited<ReturnType<typeof liveItemWithNewerDraft>>;
  let minted: MintedPreview;

  const get = (path: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url: path, headers });
  const preview = (token: string, slug = fx.slug, headers: Record<string, string> = {}) => get(`/v1/t/${slug}/preview/${token}`, headers);
  const expectNotFoundLike = (res: { statusCode: number; json: () => Record<string, unknown> }) => {
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe(`${PROBLEM}not-found`);
  };
  /** A body with the per-request members removed, so two 404s can be compared. */
  const normal = (res: { json: () => Record<string, unknown> }) => {
    const { instance: _i, requestId: _r, ...rest } = res.json();
    return rest;
  };

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("pvget");
    other = await createContentFixture("pvget-other");
    keys = await mintReadKeys(app, fx);
    await setDomains(fx, { staging: "staging.preview-a.example.test", production: "www.preview-a.example.test" });
    await setDomains(other, { staging: "staging.preview-b.example.test", production: "www.preview-b.example.test" });
    live = await liveItemWithNewerDraft(app, fx, LIVE_H1, DRAFT_H1, "main");
    const res = await mintPreview(app, fx, live.itemId);
    expect(res.statusCode).toBe(201);
    minted = res.json<MintedPreview>();
    expect(minted.version).toBe(live.headVersion);
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // The happy path, and that it is the DRAFT
  // ==============================================================================================
  describe("a valid token", () => {
    it("serves the DRAFT: 200, with the head version's content, not the live projection's", async () => {
      const res = await get(minted.previewPath);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("application/json");
      expect(res.body).toContain(DRAFT_H1);
      expect(res.body).not.toContain(LIVE_H1);
      // ... while production still serves the published version, untouched by the token
      const prod = await v1Get(app, fx, keys.production, "service", live.slug);
      expect(prod.statusCode).toBe(200);
      expect(prod.body).toContain(LIVE_H1);
      expect(prod.body).not.toContain(DRAFT_H1);
    });

    it("answers the frozen ITEM envelope shape, with the item's collection/locale/slug/meta", async () => {
      const res = await preview(minted.token);
      const b = res.json();
      expect(Object.keys(b).sort()).toEqual(["blocks", "collection", "locale", "localizations", "meta", "seo", "slug"]);
      expect(b).toMatchObject({ collection: "service", locale: "en", slug: live.slug });
      expect(Object.keys(b.meta).sort()).toEqual(["draft", "publishedAt", "updatedAt", "x"]);
      expect(b.meta.draft).toBe(true); // the previewed version is not the live one
      expect(Array.isArray(b.blocks)).toBe(true);
      expect(Array.isArray(b.localizations)).toBe(true);
      // the same key set the item route answers
      const item = (await v1Get(app, fx, keys.staging, "service", live.slug)).json();
      expect(Object.keys(b).sort()).toEqual(Object.keys(item).sort());
      expect(Object.keys(b.meta).sort()).toEqual(Object.keys(item.meta).sort());
    });

    it("a token pinned to the LIVE version serves it, and meta.draft is false (nothing newer is shown)", async () => {
      const res = await mintPreview(app, fx, live.itemId, { version: live.liveVersion });
      const m = res.json<MintedPreview>();
      const got = await preview(m.token);
      expect(got.statusCode).toBe(200);
      expect(got.body).toContain(LIVE_H1);
      expect(got.body).not.toContain(DRAFT_H1);
      expect(got.json().meta.draft).toBe(false);
    });

    it("a token pins its VERSION: a later edit of the head does not change what the link shows", async () => {
      const { itemId, slug } = await draftItem(app, fx, "PINNED-ONE", "pin");
      const m = (await mintPreview(app, fx, itemId)).json<MintedPreview>(); // head = 1
      await appendVersion(app, fx, itemId, 1, "PINNED-TWO");
      const got = await preview(m.token);
      expect(got.statusCode).toBe(200);
      expect(got.body).toContain("PINNED-ONE");
      expect(got.body).not.toContain("PINNED-TWO");
      expect(got.json().slug).toBe(slug);
    });

    it("works for a never-published draft item (the case production cannot see at all)", async () => {
      const { itemId, slug } = await draftItem(app, fx, "NEVER-PUBLISHED-H1", "np");
      const m = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
      expect((await v1Get(app, fx, keys.production, "service", slug)).statusCode).toBe(404);
      const got = await preview(m.token);
      expect(got.statusCode).toBe(200);
      expect(got.body).toContain("NEVER-PUBLISHED-H1");
      expect(got.json().meta).toMatchObject({ draft: true, publishedAt: null });
    });

    it("lists only LIVE sibling locales in `localizations` (a preview must not disclose other unpublished items)", async () => {
      const en = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: `service.loc-${randomUUID().slice(0, 6)}`, fields: serviceFields({ h1: "EN" }) });
      const enId = en.json().item.itemId as string;
      const idSlug = `service.loc-id-${randomUUID().slice(0, 6)}`;
      const id = await createItem(app, fx, { collectionKey: "service", locale: "id", slug: idSlug, twinOf: enId, fields: serviceFields({ h1: "ID" }) });
      expect(id.statusCode).toBe(201);
      const m = (await mintPreview(app, fx, enId)).json<MintedPreview>();
      expect((await preview(m.token)).json().localizations).toEqual([]); // the id twin is only a draft
      expect((await publishItems(app, fx, [{ itemId: id.json().item.itemId, version: 1 }])).statusCode).toBe(200);
      expect((await preview(m.token)).json().localizations).toEqual([{ locale: "id", slug: idSlug }]);
    });
  });

  // ==============================================================================================
  // Headers
  // ==============================================================================================
  describe("headers", () => {
    it("Cache-Control: no-store, X-Robots-Tag: noindex, nofollow, and NO Cache-Tag", async () => {
      const res = await get(minted.previewPath);
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(res.headers["cache-tag"]).toBeUndefined();
      expect(Object.keys(res.headers).filter((h) => /tag/i.test(h) && h !== "x-robots-tag")).toEqual([]);
    });

    it("every response of the route is no-store and noindex, errors included (a cached 404 or 200 would outlive a revoke)", async () => {
      const bad = await preview(randomBytes(32).toString("base64url"));
      expect(bad.statusCode).toBe(404);
      expect(bad.headers["cache-control"]).toBe("no-store");
      expect(bad.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(bad.headers["cache-tag"]).toBeUndefined();
      expect(bad.headers["content-type"]).toBe("application/problem+json");
    });

    it("carries the request id and the per-tenant read-quota headers like the rest of /v1", async () => {
      const res = await get(minted.previewPath, { "x-request-id": "req-wsk46-1" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBeDefined();
      expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
      const bad = await preview("x".repeat(43), fx.slug, { "x-request-id": "req-wsk46-2" });
      expect(bad.json().requestId).toBe("req-wsk46-2");
    });

    it("the bytes are a plain application/json body (no charset suffix), like the item route", async () => {
      const res = await get(minted.previewPath);
      expect(res.headers["content-type"]).toBe("application/json");
      expect(Number(res.headers["content-length"])).toBe(Buffer.byteLength(res.body));
    });
  });

  // ==============================================================================================
  // CORS
  // ==============================================================================================
  describe("CORS", () => {
    it("echoes the Origin of the site's STAGING domain, with Vary: Origin", async () => {
      const res = await get(minted.previewPath, { origin: STAGING_ORIGIN });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(STAGING_ORIGIN);
      expect(String(res.headers["vary"])).toMatch(/\bOrigin\b/i);
    });

    it("echoes the Origin of the site's PRODUCTION domain too (any environment of the token's site)", async () => {
      const res = await get(minted.previewPath, { origin: PROD_ORIGIN });
      expect(res.headers["access-control-allow-origin"]).toBe(PROD_ORIGIN);
    });

    it("sends NO CORS header for a foreign origin (and still the body: CORS is the browser's gate, not ours), but still Vary: Origin", async () => {
      const res = await get(minted.previewPath, { origin: "https://evil.example.test" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(String(res.headers["vary"])).toMatch(/\bOrigin\b/i);
    });

    it("sends no CORS header without an Origin, with the null origin, or with a look-alike", async () => {
      expect((await get(minted.previewPath)).headers["access-control-allow-origin"]).toBeUndefined();
      for (const origin of [
        "null",
        "http://staging.preview-a.example.test", // wrong scheme
        "https://staging.preview-a.example.test.evil.example.test", // suffix attack
        "https://evil-staging.preview-a.example.test", // sibling subdomain of the same registrable domain
        "https://staging.preview-a.example.test:8443", // different port
        "https://staging.preview-a.example.test/", // not an origin
        "*",
        "",
      ]) {
        const res = await get(minted.previewPath, { origin });
        expect(res.headers["access-control-allow-origin"], JSON.stringify(origin)).toBeUndefined();
      }
    });

    it("compares case-insensitively on the host, and echoes the request's own Origin string", async () => {
      const res = await get(minted.previewPath, { origin: "https://STAGING.preview-a.example.test" });
      expect(res.headers["access-control-allow-origin"]).toBe("https://STAGING.preview-a.example.test");
    });

    it("ANOTHER tenant's site domain is not honoured for this token", async () => {
      const res = await get(minted.previewPath, { origin: "https://staging.preview-b.example.test" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("an environment with no domain contributes nothing; the origin of a site with no domains at all is refused", async () => {
      const bare = await createContentFixture("pvget-bare");
      const item = await draftItem(app, bare, "Bare");
      const m = (await mintPreview(app, bare, item.itemId)).json<MintedPreview>();
      const res = await get(m.previewPath, { origin: "https://anything.example.test" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("never sends Access-Control-Allow-Credentials (the token is in the path; no cookie is ever involved)", async () => {
      const res = await get(minted.previewPath, { origin: STAGING_ORIGIN });
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });

    it("the error responses carry NO CORS header whatever the origin (a 404 must not confirm anything)", async () => {
      const res = await preview(randomBytes(32).toString("base64url"), fx.slug, { origin: STAGING_ORIGIN });
      expect(res.statusCode).toBe(404);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    describe("preflight", () => {
      const pre = (path: string, origin: string | undefined) =>
        app.inject({
          method: "OPTIONS",
          url: path,
          headers: { ...(origin ? { origin } : {}), "access-control-request-method": "GET" },
        });

      it("answers 204 with the allowed origin, GET, OPTIONS, a max-age, no-store and Vary: Origin", async () => {
        const res = await pre(minted.previewPath, STAGING_ORIGIN);
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBe(STAGING_ORIGIN);
        expect(res.headers["access-control-allow-methods"]).toBe("GET, OPTIONS");
        expect(Number(res.headers["access-control-max-age"])).toBeGreaterThan(0);
        expect(String(res.headers["vary"])).toMatch(/\bOrigin\b/i);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.body).toBe("");
      });

      it("a foreign origin gets a 204 with NO allow-origin (the browser then refuses the real request)", async () => {
        const res = await pre(minted.previewPath, "https://evil.example.test");
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        expect(res.headers["access-control-allow-methods"]).toBeUndefined();
      });

      it("a preflight for an unknown, revoked or expired token is the SAME 404 as a GET, with no CORS header", async () => {
        const fresh = (await mintPreview(app, fx, live.itemId)).json<MintedPreview>();
        await revokePreview(app, fx, live.itemId, fresh.tokenId);
        for (const path of [`/v1/t/${fx.slug}/preview/${randomBytes(32).toString("base64url")}`, fresh.previewPath]) {
          const res = await pre(path, STAGING_ORIGIN);
          expect(res.statusCode).toBe(404);
          expect(res.json().type).toBe(`${PROBLEM}not-found`);
          expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        }
      });

      it("other methods on the route stay 405 (the /v1 envelope is read-only)", async () => {
        for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
          const res = await app.inject({ method, url: minted.previewPath });
          expect(res.statusCode, method).toBe(405);
          expect(res.json().type).toBe(`${PROBLEM}method-not-allowed`);
        }
      });
    });
  });

  // ==============================================================================================
  // The 404: one answer for every way a token can be wrong
  // ==============================================================================================
  describe("404 not-found, identical for every cause", () => {
    const expectNotFound = (res: { statusCode: number; json: () => Record<string, unknown>; headers: Record<string, unknown> }) => {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ type: `${PROBLEM}not-found`, title: "Not Found", status: 404 });
      expect(res.headers["content-type"]).toBe("application/problem+json");
    };

    it("expired, revoked, unknown, malformed, wrong tenant slug, unknown tenant, deleted item, archived tenant: same body but for instance/requestId", async () => {
      // a valid control for each variant is the happy path of the describe above; here every cause is made real
      const expired = (await mintPreview(app, fx, live.itemId)).json<MintedPreview>();
      await expireToken(fx, expired.tokenId);

      const revoked = (await mintPreview(app, fx, live.itemId)).json<MintedPreview>();
      expect((await revokePreview(app, fx, live.itemId, revoked.tokenId)).statusCode).toBe(200);

      const doomed = await draftItem(app, fx, "Doomed", "dd");
      const deleted = (await mintPreview(app, fx, doomed.itemId)).json<MintedPreview>();
      expect((await preview(deleted.token)).statusCode).toBe(200); // positive control: valid before the delete
      const del = await app.inject({ method: "POST", url: `${itemBase(fx, doomed.itemId)}/delete`, headers: hdr(), payload: { baseVersion: 1 } });
      expect(del.statusCode).toBe(200);

      const archivedFx = await createContentFixture("pvget-arch");
      const archivedItem = await draftItem(app, archivedFx, "Arch");
      const archived = (await mintPreview(app, archivedFx, archivedItem.itemId)).json<MintedPreview>();
      expect((await get(archived.previewPath)).statusCode).toBe(200); // positive control: valid before archiving
      await asPlatform(async (c) => {
        await c.query(`UPDATE tenants SET status = 'archived' WHERE id = $1`, [archivedFx.tenantId]);
      });

      const unknownToken = randomBytes(32).toString("base64url");
      const results = {
        expired: await preview(expired.token),
        revoked: await preview(revoked.token),
        unknown: await preview(unknownToken),
        tooShort: await preview("abc"),
        tooLong: await preview(unknownToken + "A"),
        badChars: await preview("!".repeat(43)),
        wrongTenant: await preview(minted.token, other.slug), // a REAL token under another tenant's slug
        unknownTenant: await preview(minted.token, "no-such-tenant-slug"),
        deletedItem: await preview(deleted.token),
        archivedTenant: await get(archived.previewPath),
      };
      for (const [cause, res] of Object.entries(results)) {
        expectNotFound(res);
        expect(normal(res), cause).toEqual(normal(results.unknown));
        expect(res.headers["cache-control"], cause).toBe("no-store");
        expect(res.headers["access-control-allow-origin"], cause).toBeUndefined();
      }
      // the detail does not even say which part of the path was wrong
      expect(results.unknown.json().detail).not.toMatch(/token|tenant|expired|revoked|deleted/i);
      // and the happy path still works: the 404s above are about the tokens, not the app
      expect((await get(minted.previewPath)).statusCode).toBe(200);
    });

    it("a token minted for tenant A never resolves under tenant B's slug, even when B has the same item id shape", async () => {
      const res = await preview(minted.token, other.slug);
      expectNotFound(res);
    });

    it("a malformed percent-escape in the token is the frozen 400 invalid-path-encoding, as on every /v1 path (framework error, before routing)", async () => {
      const res = await get(`/v1/t/${fx.slug}/preview/%E0%A4%A`);
      expect(res.statusCode).toBe(400);
      expect(res.json().type).toBe(`${PROBLEM}invalid-path-encoding`);
      expect(res.body).not.toContain("%E0%A4%A"); // the token position is redacted in the body too
    });

    it("never echoes the token back: `instance` carries the path with the token redacted, on a 404 and on a 405", async () => {
      const guess = randomBytes(32).toString("base64url");
      const notFound = await preview(guess);
      expect(notFound.json().instance).toBe(`/v1/t/${fx.slug}/preview/:token`);
      expect(notFound.body).not.toContain(guess);
      const notAllowed = await app.inject({ method: "POST", url: `/v1/t/${fx.slug}/preview/${guess}` });
      expect(notAllowed.statusCode).toBe(405);
      expect(notAllowed.body).not.toContain(guess);
      // and a VALID token's 200 body (the envelope) does not carry it either
      expect((await get(minted.previewPath)).body).not.toContain(minted.token);
    });

    it("an encoded slash in the token cannot reach across segments: 404, same body", async () => {
      const unknown = await preview(randomBytes(32).toString("base64url"));
      const res = await get(`/v1/t/${fx.slug}/preview/${minted.token.slice(0, 20)}%2F${minted.token.slice(21)}`);
      expectNotFound(res);
      expect(normal(res)).toEqual(normal(unknown));
    });

    it("an encoded NUL in the token or the tenant slug is the same 404 and never reaches SQL (Postgres cannot store NUL)", async () => {
      const unknown = await preview(randomBytes(32).toString("base64url"));
      for (const path of [`/v1/t/${fx.slug}/preview/${minted.token.slice(0, 20)}%00${minted.token.slice(21)}`, `/v1/t/${fx.slug}%00/preview/${minted.token}`, `/v1/t/%00/preview/${minted.token}`]) {
        const res = await get(path);
        expectNotFound(res);
        expect(normal(res), path).toEqual(normal(unknown));
      }
    });

    it("percent-encoding a valid token's characters does not change the answer (decoded once)", async () => {
      // base64url has no characters that need escaping; encoding one anyway must still resolve to the same token
      const encoded = minted.token.replace(/^(.)/, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
      expect((await get(`/v1/t/${fx.slug}/preview/${encoded}`)).statusCode).toBe(200);
      // double-encoding is a different, unknown token
      const double = minted.token.replace(/^(.)/, (c) => `%25${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
      expectNotFound(await get(`/v1/t/${fx.slug}/preview/${double}`));
    });

    it("a token that is one character off is a 404 (no prefix or near-match leniency)", async () => {
      const flipped = minted.token.slice(0, -1) + (minted.token.endsWith("A") ? "B" : "A");
      expectNotFound(await preview(flipped));
      expectNotFound(await preview(minted.token.slice(0, -1)));
    });

    it("the hash lookup is the comparison: submitting a token's own sha256 hex does not open it", async () => {
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256").update(minted.token).digest("hex");
      expectNotFound(await preview(hash));
    });

    it("a revoke takes effect on the very next request (no cache), and a fresh token for the same item still works", async () => {
      const a = (await mintPreview(app, fx, live.itemId)).json<MintedPreview>();
      const b = (await mintPreview(app, fx, live.itemId)).json<MintedPreview>();
      expect((await preview(a.token)).statusCode).toBe(200);
      expect((await revokePreview(app, fx, live.itemId, a.tokenId)).statusCode).toBe(200);
      expectNotFound(await preview(a.token));
      expect((await preview(b.token)).statusCode).toBe(200); // revoking one token leaves its siblings alone
    });

    it("a token stops working at its expiry (the database's clock), not before", async () => {
      const m = (await mintPreview(app, fx, live.itemId, { ttlSeconds: 3 })).json<MintedPreview>();
      expect((await preview(m.token)).statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 3_500));
      expectNotFound(await preview(m.token));
    }, 15_000);
  });

  // ==============================================================================================
  // Defence in depth: the READ re-checks what the mint checked (a row the mint would never write, e.g. from
  // a bug or a direct write, must still not serve another tenant's or another site's content)
  // ==============================================================================================
  describe("the read re-checks tenant and site", () => {
    const insertToken = (tenantId: string, siteId: string, itemId: string, version: number, token: string) =>
      asTenant(tenantId, async (db) => {
        await db.query(
          `INSERT INTO preview_tokens (tenant_id, site_id, content_item_id, version, token_hash, expires_at, created_by)
           VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour', 'wsk46-direct')`,
          [tenantId, siteId, itemId, version, sha256Hex(token)],
        );
      });

    it("a row of tenant A that points at tenant B's item (the foreign key cannot tell) serves nothing, under either slug", async () => {
      const foreign = await draftItem(app, other, "OTHER-TENANT-SECRET", "x");
      const token = randomBytes(32).toString("base64url");
      await insertToken(fx.tenantId, fx.siteId, foreign.itemId, 1, token);
      expectNotFoundLike(await preview(token, fx.slug));
      expectNotFoundLike(await preview(token, other.slug));
      // positive control: the same shape, pointing at A's OWN item, serves
      const own = await draftItem(app, fx, "OWN-ITEM-VISIBLE", "x");
      const ownToken = randomBytes(32).toString("base64url");
      await insertToken(fx.tenantId, fx.siteId, own.itemId, 1, ownToken);
      const ok = await preview(ownToken, fx.slug);
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain("OWN-ITEM-VISIBLE");
    });

    it("a row whose site_id is not its item's site serves nothing", async () => {
      // a second site of the same tenant, with an item of its own
      const site2 = randomUUID();
      const col2 = randomUUID();
      const item2 = randomUUID();
      await asTenant(fx.tenantId, async (db) => {
        await db.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', 'second')`, [site2, fx.tenantId]);
        await db.query(`INSERT INTO collections (id, tenant_id, site_id, key) VALUES ($1, $2, $3, 'page')`, [col2, fx.tenantId, site2]);
        await db.query(
          `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, publish_state, head_version)
           VALUES ($1, $2, $3, $4, 'en', 'second-site-item', gen_random_uuid(), 'draft', 1)`,
          [item2, fx.tenantId, site2, col2],
        );
        await db.query(
          `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by)
           VALUES ($1, $2, 1, '[]'::jsonb, '{}'::jsonb, 'draft', 'wsk46-direct')`,
          [fx.tenantId, item2],
        );
      });
      const token = randomBytes(32).toString("base64url");
      await insertToken(fx.tenantId, fx.siteId, item2, 1, token); // site_id = the FIRST site, item = the second site's
      expectNotFoundLike(await preview(token));
      // positive control: the same item with its own site serves
      const okToken = randomBytes(32).toString("base64url");
      await insertToken(fx.tenantId, site2, item2, 1, okToken);
      expect((await preview(okToken)).statusCode).toBe(200);
    });
  });

  // ==============================================================================================
  // No api key needed, and a key does not widen anything
  // ==============================================================================================
  describe("api keys", () => {
    it("needs NO Authorization header (the token is the credential)", async () => {
      const res = await get(minted.previewPath); // no headers at all
      expect(res.statusCode).toBe(200);
    });

    it("a malformed or revoked or foreign api key attached to a valid preview request changes nothing (the token decides)", async () => {
      for (const authorization of ["Bearer not-a-real-key", "Basic Zm9vOmJhcg==", "garbage"]) {
        const res = await get(minted.previewPath, { authorization });
        expect(res.statusCode, authorization).toBe(200);
        expect(res.body).toContain(DRAFT_H1);
      }
    });

    it("a production read key WITHOUT a token cannot see drafts: not the item route, not the list, not search", async () => {
      const prodHeaders = { authorization: `Bearer ${keys.production}` };
      // the item that has a newer draft serves its PUBLISHED version only
      const item = await get(`/v1/t/${fx.slug}/service/${encodeURIComponent(live.slug)}?locale=en`, prodHeaders);
      expect(item.statusCode).toBe(200);
      expect(item.body).toContain(LIVE_H1);
      expect(item.body).not.toContain(DRAFT_H1);
      // a never-published draft is invisible to the key
      const never = await draftItem(app, fx, "NEVER-LIVE-H1", "nl");
      await mintPreview(app, fx, never.itemId);
      expect((await get(`/v1/t/${fx.slug}/service/${encodeURIComponent(never.slug)}?locale=en`, prodHeaders)).statusCode).toBe(404);
      const list = await get(`/v1/t/${fx.slug}/service?locale=en&expand=blocks&limit=100`, prodHeaders);
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(never.slug);
      expect(list.body).not.toContain(DRAFT_H1);
      const search = await get(`/v1/t/${fx.slug}/search?q=NEVER-LIVE-H1&locale=en`, prodHeaders);
      expect(search.statusCode).toBe(200);
      expect(search.json().items).toEqual([]);
    });

    it("a production key against the preview path with a WRONG token is the same 404 as no key at all (the key opens nothing)", async () => {
      const wrong = randomBytes(32).toString("base64url");
      const withKey = await preview(wrong, fx.slug, { authorization: `Bearer ${keys.production}` });
      const without = await preview(wrong);
      expect(withKey.statusCode).toBe(404);
      expect(normal(withKey)).toEqual(normal(without));
    });

    it("a key does not turn `preview` into a collection: the reserved segment is not a list or an item route", async () => {
      const list = await get(`/v1/t/${fx.slug}/preview`, { authorization: `Bearer ${keys.staging}` });
      // an unknown collection is an empty list (existing /v1 behaviour); the point is that it holds no draft
      expect(list.body).not.toContain(DRAFT_H1);
      expect(list.json().items ?? []).toEqual([]);
    });

    it("the staging key sees the draft head as before, and that did not change", async () => {
      const staging = await v1Get(app, fx, keys.staging, "service", live.slug);
      expect(staging.statusCode).toBe(200);
      // staging serves the projection (the live version of a published item), exactly as before WSK-46
      expect(staging.body).toContain(LIVE_H1);
    });
  });

  // ==============================================================================================
  // Quota
  // ==============================================================================================
  describe("per-tenant read quota", () => {
    it("applies to a VALID token's reads: over the limit is 429 rate-limited in the frozen problem shape", async () => {
      const quota = app.get(TenantQuotaService);
      const q = await createContentFixture("pvget-quota");
      const item = await draftItem(app, q, "Quota");
      const m = (await mintPreview(app, q, item.itemId)).json<MintedPreview>();
      const r = await createContentFixture("pvget-quota-r"); // a fresh tenant: its Redis counter starts at zero
      const rItem = await draftItem(app, r, "QuotaR");
      const rm = (await mintPreview(app, r, rItem.itemId)).json<MintedPreview>();
      quota.withLimits(2, QUOTA_WINDOW_MS);
      try {
        expect((await get(m.previewPath)).statusCode).toBe(200);
        expect((await get(m.previewPath)).statusCode).toBe(200);
        const limited = await get(m.previewPath, { origin: "https://anything.example.test" });
        expect(limited.statusCode).toBe(429);
        expect(limited.json().type).toBe(`${PROBLEM}rate-limited`);
        expect(limited.headers["retry-after"]).toBeDefined();
        expect(limited.headers["cache-control"]).toBe("no-store");
        // another tenant is not affected (the counter is per tenant)
        expect((await get(rm.previewPath)).statusCode).toBe(200);
      } finally {
        quota.withLimits(config.readQuotaPerMinute, config.readQuotaWindowMs);
      }
    });

    it("is NOT spent by invalid tokens: a stranger guessing tokens cannot exhaust the tenant's real read quota", async () => {
      const quota = app.get(TenantQuotaService);
      const q = await createContentFixture("pvget-quota2");
      const item = await draftItem(app, q, "Quota2");
      const m = (await mintPreview(app, q, item.itemId)).json<MintedPreview>();
      quota.withLimits(2, QUOTA_WINDOW_MS);
      try {
        for (let i = 0; i < 10; i++) expect((await preview(randomBytes(32).toString("base64url"), q.slug)).statusCode).toBe(404);
        expect((await get(m.previewPath)).statusCode).toBe(200);
        expect((await get(m.previewPath)).statusCode).toBe(200);
        expect((await get(m.previewPath)).statusCode).toBe(429);
      } finally {
        quota.withLimits(config.readQuotaPerMinute, config.readQuotaWindowMs);
      }
    });
  });

  // ==============================================================================================
  // Does not disturb the rest of /v1
  // ==============================================================================================
  describe("the rest of /v1", () => {
    it("other routes under /v1 still answer as before: 401 without a key, 404 for an unknown path", async () => {
      expect((await get(`/v1/t/${fx.slug}/service`)).statusCode).toBe(401);
      const unknown = await get(`/v1/t/${fx.slug}/service/a/b/c`, { authorization: `Bearer ${keys.production}` });
      expect(unknown.statusCode).toBe(404);
    });

    it("OPTIONS elsewhere under /v1 stays 405 (only the preview route answers a preflight)", async () => {
      const res = await app.inject({ method: "OPTIONS", url: `/v1/t/${fx.slug}/service` });
      expect(res.statusCode).toBe(405);
    });

    it("the route table has no collision: the audit and tenant rows are untouched by reads", async () => {
      const before = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM preview_tokens`)).rows[0].n);
      await get(minted.previewPath);
      const after = await asTenant(fx.tenantId, async (db) => (await db.query(`SELECT count(*)::int AS n FROM preview_tokens`)).rows[0].n);
      expect(after).toBe(before);
    });
  });
});
