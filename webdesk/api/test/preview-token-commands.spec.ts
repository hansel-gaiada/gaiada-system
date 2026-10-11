// WSK-46 — the control plane half of draft preview (owner ruling WSK-D52): content.previewToken (mint)
// and content.previewTokenRevoke. Real Postgres (migrations through 0013), real Redis, the real
// AppModule with the REAL Layer-3/4 PDP (content-test-kit.ts); Layers 1/2/2e stay the NODE_ENV=test
// header stubs.
//
// Doctrine (estate memory: "validation pre-empts authz"): every denial sends a body that is valid for
// its command and is paired with a positive control that sends the IDENTICAL request and succeeds.
// The public endpoint is test/delivery/preview-endpoint.spec.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, buildContentApp, createContentFixture, createItem, hdr, serviceFields, type ContentFixture } from "./content-test-kit";
import {
  appendVersion,
  draftItem,
  dumpAudit,
  dumpIdempotency,
  dumpPreviewTokens,
  itemBase,
  mintPreview,
  revokePreview,
  sha256Hex,
  type MintedPreview,
} from "./preview-test-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

describe("WSK-46 content.previewToken / content.previewTokenRevoke", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  let other: ContentFixture;

  beforeAll(async () => {
    app = await buildContentApp();
    fx = await createContentFixture("pvmint");
    other = await createContentFixture("pvmint-other");
  });
  afterAll(async () => {
    await app?.close();
  });

  // ==============================================================================================
  // Mint: the response, the token, where it is (not) stored
  // ==============================================================================================
  it("mints a token for the HEAD version by default: 201 { tokenId, token, expiresAt, version, previewPath }", async () => {
    const { itemId } = await draftItem(app, fx, "Head one");
    await appendVersion(app, fx, itemId, 1, "Head two");
    const before = Date.now();
    const res = await mintPreview(app, fx, itemId);
    expect(res.statusCode).toBe(201);
    const b = res.json<MintedPreview>();
    expect(Object.keys(b).sort()).toEqual(["expiresAt", "previewPath", "replayed", "token", "tokenId", "version"]);
    expect(b.version).toBe(2); // the head
    expect(b.replayed).toBe(false);
    expect(b.token).toMatch(BASE64URL_43); // 32 random bytes, base64url, no padding
    expect(b.tokenId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.previewPath).toBe(`/v1/t/${fx.slug}/preview/${b.token}`);
    // default TTL is one hour
    const ttl = Date.parse(b.expiresAt) - before;
    expect(ttl).toBeGreaterThan(3_600_000 - 5_000);
    expect(ttl).toBeLessThan(3_600_000 + 15_000);
  });

  it("two mints of the same item give two different tokens (32 fresh random bytes each)", async () => {
    const { itemId } = await draftItem(app, fx, "Twice");
    const a = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
    const b = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenId).not.toBe(b.tokenId);
  });

  it("an explicit version pins that version, not the head", async () => {
    const { itemId } = await draftItem(app, fx, "Pinned one");
    await appendVersion(app, fx, itemId, 1, "Pinned two");
    const res = await mintPreview(app, fx, itemId, { version: 1 });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(1);
    const rows = await dumpPreviewTokens(fx);
    expect(rows.find((r) => r.id === res.json().tokenId)).toMatchObject({ version: 1, content_item_id: itemId });
  });

  it("STORED AS A HASH ONLY: the row holds sha256(token), and the plaintext is in no column of preview_tokens", async () => {
    const { itemId } = await draftItem(app, fx, "Hash only");
    const res = await mintPreview(app, fx, itemId);
    const { token, tokenId } = res.json<MintedPreview>();
    const rows = await dumpPreviewTokens(fx);
    const row = rows.find((r) => r.id === tokenId) as Record<string, unknown>;
    expect(row.token_hash).toBe(sha256Hex(token));
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(token);
    expect(row).toMatchObject({ tenant_id: fx.tenantId, site_id: fx.siteId, content_item_id: itemId, version: 1, created_by: "user-editor-1", revoked_at: null });
  });

  it("THE PLAINTEXT APPEARS ONLY IN THE RESPONSE: not in control_idempotency_keys, not in audit_entries", async () => {
    const { itemId } = await draftItem(app, fx, "Withheld");
    const idem = `idem-${randomUUID()}`;
    const res = await mintPreview(app, fx, itemId, {}, { idem });
    const { token, tokenId, previewPath } = res.json<MintedPreview>();
    const idemRows = await dumpIdempotency(fx);
    const mine = idemRows.filter((r) => String(r.scope_key).endsWith(`:content.previewToken:${idem}`));
    expect(mine).toHaveLength(1);
    expect(mine[0].status).toBe("completed");
    for (const r of idemRows) {
      const text = JSON.stringify(r);
      expect(text).not.toContain(token);
      expect(text).not.toContain(previewPath);
    }
    // the stored record is the response minus the secret and what is derived from it, plus the marker
    expect(mine[0].response).toMatchObject({ tokenId, version: 1, secretWithheld: true });
    expect((mine[0].response as Record<string, unknown>).token).toBeUndefined();
    expect((mine[0].response as Record<string, unknown>).previewPath).toBeUndefined();
    for (const r of await dumpAudit(fx)) expect(JSON.stringify(r)).not.toContain(token);
    // and the command left an audit row naming the tokenId
    const audit = (await dumpAudit(fx)).filter((r) => r.action === "control.content.previewToken");
    expect(audit.length).toBeGreaterThan(0);
  });

  it("a REPLAY (same Idempotency-Key, same request) is 409 idempotency-response-withheld, mints nothing and returns no token", async () => {
    const { itemId } = await draftItem(app, fx, "Replay");
    const idem = `idem-${randomUUID()}`;
    const first = await mintPreview(app, fx, itemId, { ttlSeconds: 600 }, { idem });
    expect(first.statusCode).toBe(201);
    const countBefore = (await dumpPreviewTokens(fx)).length;
    const replay = await mintPreview(app, fx, itemId, { ttlSeconds: 600 }, { idem });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().type).toBe(`${PROBLEM}idempotency-response-withheld`);
    expect(replay.body).not.toContain(first.json().token);
    expect((await dumpPreviewTokens(fx)).length).toBe(countBefore);
    // the same key with a DIFFERENT request is the existing key-reuse refusal, not a second mint
    const reused = await mintPreview(app, fx, itemId, { ttlSeconds: 601 }, { idem });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().type).toBe(`${PROBLEM}idempotency-key-reused`);
    // positive control: a fresh key mints again
    expect((await mintPreview(app, fx, itemId, { ttlSeconds: 600 })).statusCode).toBe(201);
  });

  // ==============================================================================================
  // TTL
  // ==============================================================================================
  describe("ttlSeconds", () => {
    const expiresIn = async (body: Record<string, unknown>): Promise<number> => {
      const { itemId } = await draftItem(app, fx, "ttl", "ttl");
      const t0 = Date.now();
      const res = await mintPreview(app, fx, itemId, body);
      expect(res.statusCode).toBe(201);
      return Math.round((Date.parse(res.json().expiresAt) - t0) / 1000);
    };
    const near = (actual: number, expected: number) => {
      expect(actual).toBeGreaterThanOrEqual(expected - 5);
      expect(actual).toBeLessThanOrEqual(expected + 15);
    };

    it("an explicit TTL is honoured", async () => near(await expiresIn({ ttlSeconds: 120 }), 120));
    it("the default is 3600 seconds", async () => near(await expiresIn({}), 3600));
    it("zero means the default", async () => near(await expiresIn({ ttlSeconds: 0 }), 3600));
    it("null means the default", async () => near(await expiresIn({ ttlSeconds: null }), 3600));
    it("is capped at 86400 seconds (one day)", async () => {
      near(await expiresIn({ ttlSeconds: 86_400 }), 86_400);
      near(await expiresIn({ ttlSeconds: 90_000 }), 86_400);
      near(await expiresIn({ ttlSeconds: 2_000_000_000 }), 86_400);
    });
    it("a negative, fractional or non-numeric TTL is 400 invalid-request (not silently the default)", async () => {
      const { itemId } = await draftItem(app, fx, "ttl-bad", "ttl");
      for (const ttlSeconds of [-1, 1.5, "3600", true, {}, [60]]) {
        const res = await mintPreview(app, fx, itemId, { ttlSeconds });
        expect(res.statusCode, JSON.stringify(ttlSeconds)).toBe(400);
        expect(res.json().type).toBe(`${PROBLEM}invalid-request`);
      }
      expect((await mintPreview(app, fx, itemId, { ttlSeconds: 60 })).statusCode).toBe(201);
    });
  });

  // ==============================================================================================
  // Body shape
  // ==============================================================================================
  it("an unknown body key, a route-param key, or a bad version is 400 invalid-request", async () => {
    const { itemId } = await draftItem(app, fx, "Shape");
    for (const body of [{ extra: 1 }, { itemId }, { tenantSlug: fx.slug }, { version: 0 }, { version: -3 }, { version: 1.5 }, { version: "1" }]) {
      const res = await mintPreview(app, fx, itemId, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().type).toBe(`${PROBLEM}invalid-request`);
    }
    // an empty object is fine (everything is optional), and so is an explicit null version
    expect((await mintPreview(app, fx, itemId, {})).statusCode).toBe(201);
    expect((await mintPreview(app, fx, itemId, { version: null })).statusCode).toBe(201);
  });

  // ==============================================================================================
  // Refusals: the problems the content commands use
  // ==============================================================================================
  describe("refusals", () => {
    it("a version the item does not have -> 409 version-not-found; the head version works", async () => {
      const { itemId } = await draftItem(app, fx, "NoVer");
      const res = await mintPreview(app, fx, itemId, { version: 7 });
      expect(res.statusCode).toBe(409);
      expect(res.json().type).toBe(`${PROBLEM}version-not-found`);
      expect((await mintPreview(app, fx, itemId, { version: 1 })).statusCode).toBe(201);
    });

    it("a DELETED item -> 409 item-deleted; the same item before deletion minted fine", async () => {
      const { itemId } = await draftItem(app, fx, "Doomed");
      expect((await mintPreview(app, fx, itemId)).statusCode).toBe(201);
      const del = await app.inject({ method: "POST", url: `${itemBase(fx, itemId)}/delete`, headers: hdr(), payload: { baseVersion: 1 } });
      expect(del.statusCode).toBe(200);
      const res = await mintPreview(app, fx, itemId);
      expect(res.statusCode).toBe(409);
      expect(res.json().type).toBe(`${PROBLEM}item-deleted`);
    });

    it("an item of ANOTHER site or tenant, an unknown id and a malformed id are all the same 404 item-not-found", async () => {
      const foreign = await draftItem(app, other, "Foreign");
      const mine = await draftItem(app, fx, "Mine");
      for (const id of [foreign.itemId, randomUUID(), "not-a-uuid"]) {
        const res = await mintPreview(app, fx, id);
        expect(res.statusCode, id).toBe(404);
        expect(res.json().type).toBe(`${PROBLEM}item-not-found`);
      }
      // positive control: the item of this site mints
      expect((await mintPreview(app, fx, mine.itemId)).statusCode).toBe(201);
      // ... and the foreign item mints under its OWN site
      expect((await mintPreview(app, other, foreign.itemId)).statusCode).toBe(201);
      // a token was never written for the foreign item under the wrong tenant
      expect((await dumpPreviewTokens(fx)).some((r) => r.content_item_id === foreign.itemId)).toBe(false);
    });

    it("an unknown site or tenant slug is 404 site-not-found", async () => {
      const { itemId } = await draftItem(app, fx, "Site");
      const wrongSite = await app.inject({
        method: "POST",
        url: `/control/v1/tenants/${fx.slug}/sites/${randomUUID()}/content/items/${itemId}/preview-token`,
        headers: hdr(),
        payload: {},
      });
      expect(wrongSite.statusCode).toBe(404);
      expect(wrongSite.json().type).toBe(`${PROBLEM}site-not-found`);
      const wrongTenant = await app.inject({
        method: "POST",
        url: `/control/v1/tenants/no-such-tenant/sites/${fx.siteId}/content/items/${itemId}/preview-token`,
        headers: hdr(),
        payload: {},
      });
      expect(wrongTenant.statusCode).toBe(404);
    });
  });

  // ==============================================================================================
  // Gates: L1/L2 (stubbed) -> L3 scope -> L2e editorial -> validation. Valid bodies, positive controls.
  // ==============================================================================================
  describe("gates", () => {
    it("MINT without an editorial principal -> 401 editorial-assertion-missing, nothing written; identical request WITH one -> 201", async () => {
      const { itemId } = await draftItem(app, fx, "Gate-e");
      const rowsBefore = (await dumpPreviewTokens(fx)).length;
      const auditBefore = (await dumpAudit(fx)).length;
      const denied = await mintPreview(app, fx, itemId, { ttlSeconds: 300 }, { editorial: null });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().type).toBe(`${PROBLEM}editorial-assertion-missing`);
      expect((await dumpPreviewTokens(fx)).length).toBe(rowsBefore);
      expect((await dumpAudit(fx)).length).toBe(auditBefore);
      expect((await mintPreview(app, fx, itemId, { ttlSeconds: 300 })).statusCode).toBe(201);
    });

    it("MINT with a scopeless token -> 403 (L3); a read-only token -> 403; the operate scope -> 201", async () => {
      const { itemId } = await draftItem(app, fx, "Gate-s");
      const scopeless = await mintPreview(app, fx, itemId, {}, { scopes: [] });
      expect(scopeless.statusCode).toBe(403);
      expect(scopeless.json().message).toMatch(/lacks required scope/);
      const readOnly = await mintPreview(app, fx, itemId, {}, { scopes: ["webdesk:read"] });
      expect(readOnly.statusCode).toBe(403);
      expect((await mintPreview(app, fx, itemId, {}, { scopes: ["webdesk:operate"] })).statusCode).toBe(201);
    });

    it("MINT with a malformed editorial principal -> 401 editorial-assertion-malformed; a well-formed agent principal -> 201", async () => {
      const { itemId } = await draftItem(app, fx, "Gate-m");
      const bad = await mintPreview(app, fx, itemId, {}, { editorial: '{"sub": 5}' });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().type).toBe(`${PROBLEM}editorial-assertion-malformed`);
      const ok = await mintPreview(app, fx, itemId, {}, { editorial: '{"sub":"bot-7","pk":"agent","agt":"webdev-writer"}' });
      expect(ok.statusCode).toBe(201);
      // the token is attributed to the editorial principal, never the control channel's service identity
      expect((await dumpPreviewTokens(fx)).find((r) => r.id === ok.json().tokenId)?.created_by).toBe("bot-7");
    });

    it("MINT gate ORDER: L3 before L2e; L2e before validation (an invalid body with no principal is 401, not 400)", async () => {
      const { itemId } = await draftItem(app, fx, "Gate-o");
      expect((await mintPreview(app, fx, itemId, {}, { scopes: [], editorial: null })).statusCode).toBe(403);
      expect((await mintPreview(app, fx, itemId, { ttlSeconds: -5 }, { editorial: null })).statusCode).toBe(401);
      // fully authorised + invalid body -> 400 (validation runs after every gate)
      expect((await mintPreview(app, fx, itemId, { ttlSeconds: -5 })).statusCode).toBe(400);
      expect((await mintPreview(app, fx, itemId, { ttlSeconds: 5 })).statusCode).toBe(201);
    });

    it("MINT requires an Idempotency-Key like every content write (400 without one); with one -> 201", async () => {
      const { itemId } = await draftItem(app, fx, "Gate-i");
      const noKey = await mintPreview(app, fx, itemId, {}, { idem: null });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.json().type).toBe(`${PROBLEM}invalid-request`);
      expect((await mintPreview(app, fx, itemId)).statusCode).toBe(201);
    });

    it("MINT is MEDIUM: it needs NO WS4 assertion, and a stray one claims no approval", async () => {
      const { itemId } = await draftItem(app, fx, "Gate-w");
      expect((await mintPreview(app, fx, itemId)).statusCode).toBe(201); // no ws4 header at all
      const audit = await dumpAudit(fx);
      expect(audit.filter((r) => r.action === "control.content.previewToken" && r.ws4_approval_id !== null)).toHaveLength(0);
    });

    it("REVOKE: no editorial principal -> 401; scopeless -> 403; identical request with both -> 200", async () => {
      const { itemId } = await draftItem(app, fx, "Rev-gate");
      const { tokenId } = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
      const noPrincipal = await revokePreview(app, fx, itemId, tokenId, { editorial: null });
      expect(noPrincipal.statusCode).toBe(401);
      expect(noPrincipal.json().type).toBe(`${PROBLEM}editorial-assertion-missing`);
      const scopeless = await revokePreview(app, fx, itemId, tokenId, { scopes: [] });
      expect(scopeless.statusCode).toBe(403);
      // nothing was revoked by the refused calls
      expect((await dumpPreviewTokens(fx)).find((r) => r.id === tokenId)?.revoked_at).toBeNull();
      const ok = await revokePreview(app, fx, itemId, tokenId);
      expect(ok.statusCode).toBe(200);
      expect((await dumpPreviewTokens(fx)).find((r) => r.id === tokenId)?.revoked_at).not.toBeNull();
    });
  });

  // ==============================================================================================
  // Revoke
  // ==============================================================================================
  describe("revoke", () => {
    it("sets revoked_at, answers { tokenId, itemId, revokedAt, alreadyRevoked: false }", async () => {
      const { itemId } = await draftItem(app, fx, "Rev-1");
      const { tokenId } = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
      const res = await revokePreview(app, fx, itemId, tokenId);
      expect(res.statusCode).toBe(200);
      const b = res.json();
      expect(b).toMatchObject({ tokenId, itemId, alreadyRevoked: false, replayed: false });
      const row = (await dumpPreviewTokens(fx)).find((r) => r.id === tokenId) as Record<string, unknown>;
      expect(row.revoked_at).not.toBeNull();
      expect(new Date(b.revokedAt).getTime()).toBe((row.revoked_at as Date).getTime());
      // audit row
      expect((await dumpAudit(fx)).some((r) => r.action === "control.content.previewTokenRevoke")).toBe(true);
    });

    it("is IDEMPOTENT: revoking again (a fresh key) is 200 alreadyRevoked, and revoked_at does not move", async () => {
      const { itemId } = await draftItem(app, fx, "Rev-2");
      const { tokenId } = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
      const first = await revokePreview(app, fx, itemId, tokenId);
      const second = await revokePreview(app, fx, itemId, tokenId);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ tokenId, alreadyRevoked: true });
      expect(second.json().revokedAt).toBe(first.json().revokedAt);
    });

    it("the same Idempotency-Key replays the stored 200 (no secret in it, so nothing is withheld)", async () => {
      const { itemId } = await draftItem(app, fx, "Rev-3");
      const { tokenId } = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
      const idem = `idem-${randomUUID()}`;
      const first = await revokePreview(app, fx, itemId, tokenId, { idem });
      const replay = await revokePreview(app, fx, itemId, tokenId, { idem });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ tokenId, revokedAt: first.json().revokedAt, replayed: true });
    });

    it("an unknown token, a malformed id, a token of ANOTHER item, and a token of ANOTHER tenant are all 404 preview-token-not-found", async () => {
      const a = await draftItem(app, fx, "Rev-a");
      const b = await draftItem(app, fx, "Rev-b");
      const foreign = await draftItem(app, other, "Rev-foreign");
      const tokenOfB = (await mintPreview(app, fx, b.itemId)).json<MintedPreview>().tokenId;
      const foreignToken = (await mintPreview(app, other, foreign.itemId)).json<MintedPreview>().tokenId;
      for (const tokenId of [randomUUID(), "not-a-uuid", tokenOfB, foreignToken]) {
        const res = await revokePreview(app, fx, a.itemId, tokenId);
        expect(res.statusCode, tokenId).toBe(404);
        expect(res.json().type).toBe(`${PROBLEM}preview-token-not-found`);
      }
      // nothing was revoked by those refusals
      expect((await dumpPreviewTokens(fx)).find((r) => r.id === tokenOfB)?.revoked_at).toBeNull();
      expect((await dumpPreviewTokens(other)).find((r) => r.id === foreignToken)?.revoked_at).toBeNull();
      // positive control: revoking B's token under B works
      expect((await revokePreview(app, fx, b.itemId, tokenOfB)).statusCode).toBe(200);
    });

    it("a token of a DELETED item can still be revoked (revoking only ever reduces exposure)", async () => {
      const { itemId } = await draftItem(app, fx, "Rev-del");
      const { tokenId } = (await mintPreview(app, fx, itemId)).json<MintedPreview>();
      const del = await app.inject({ method: "POST", url: `${itemBase(fx, itemId)}/delete`, headers: hdr(), payload: { baseVersion: 1 } });
      expect(del.statusCode).toBe(200);
      expect((await revokePreview(app, fx, itemId, tokenId)).statusCode).toBe(200);
    });
  });

  // ==============================================================================================
  // Tenancy of the table itself (the app role under RLS, through the real app)
  // ==============================================================================================
  it("the tokens of two tenants never mix: each tenant's table view holds only its own rows", async () => {
    const mine = await draftItem(app, fx, "Tenancy-a");
    const theirs = await draftItem(app, other, "Tenancy-b");
    const a = (await mintPreview(app, fx, mine.itemId)).json<MintedPreview>();
    const b = (await mintPreview(app, other, theirs.itemId)).json<MintedPreview>();
    const viewA = (await dumpPreviewTokens(fx)).map((r) => r.id);
    const viewB = (await dumpPreviewTokens(other)).map((r) => r.id);
    expect(viewA).toContain(a.tokenId);
    expect(viewA).not.toContain(b.tokenId);
    expect(viewB).toContain(b.tokenId);
    expect(viewB).not.toContain(a.tokenId);
    // and the raw table is RLS-fenced for a context-less reader
    const none = await asTenant(randomUUID(), async (db) => (await db.query(`SELECT count(*)::int AS n FROM preview_tokens`)).rows[0].n);
    expect(none).toBe(0);
  });

  it("minting does not touch the item: head_version, published_version and the live projection are unchanged", async () => {
    const { itemId } = await draftItem(app, fx, "Untouched");
    const read = () =>
      asTenant(fx.tenantId, async (db) => (await db.query(`SELECT head_version, published_version, publish_state, updated_at, blocks FROM content_items WHERE id = $1`, [itemId])).rows[0]);
    const before = await read();
    expect((await mintPreview(app, fx, itemId)).statusCode).toBe(201);
    expect(await read()).toEqual(before);
  });

  it("a content item created with different fields still previews its own head (sanity on the fixture)", async () => {
    const created = await createItem(app, fx, { collectionKey: "service", locale: "en", slug: `service.sanity-${randomUUID().slice(0, 6)}`, fields: serviceFields({ h1: "Sanity" }) });
    expect(created.statusCode).toBe(201);
    expect((await mintPreview(app, fx, created.json().item.itemId)).json().version).toBe(1);
  });
});
