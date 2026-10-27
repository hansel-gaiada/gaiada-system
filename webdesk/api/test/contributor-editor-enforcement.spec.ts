// M5-W1e — WebDesk's third wall for a CONTRIBUTOR (ruling WSK-D84; writers' room design D10 and section 3.1 item 7): a signed
// editorial assertion carrying `xc: true` may run only CONTRIBUTOR_COMMANDS; every other editorial command is
// 403 contributor-command-not-allowed, with a well-formed problem body, and nothing is written.
//
// Drives the REAL thing end to end, exactly like client-editor-enforcement.spec.ts: real Postgres, real Redis (the jti store is
// swapped for an in-memory one here so replay is exercised), the real AppModule with the REAL Layer-3/4 PDP and the REAL editorial
// resolver verifying EdDSA-signed assertions (not the NODE_ENV=test header stub), and the real content / media / preview / editorial
// commands. NEEDS the Linux gate (webdesk/qa/linux-gate.sh) or the CI `webdesk-api` job: it was written on a box with no database.
//
// Doctrine ("validation pre-empts authz"): every denial sends a body that is VALID for its command, so no 400/422 of the ordinary
// kind could be what refused it, and every denial proves NOTHING WAS WRITTEN. Most denials are paired with the same call signed as
// STAFF (no `xc`), which succeeds: the marker only ever restricts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asTenant, base, buildContentApp, createContentFixture, hdr, serviceFields, ws4For, type ContentFixture } from "./content-test-kit";
import { mediaBase, seedAsset } from "./media-library-kit";
import { EDITORIAL_PRINCIPAL_RESOLVER } from "../src/control/auth/editorial-principal";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { computeCommandHash } from "../src/control/auth/ws4-assertion";
import { CONTRIBUTOR_COMMANDS, EDITORIAL_COMMANDS, type CommandName } from "../src/control/command-types";
import { freshKey, keySetOf, mintEditorial, mintRaw, wireHeader, wirePayload, type ClaimInput } from "./editorial-assertion-kit";

const PROBLEM = "https://webdesk.gaiada.online/errors/";
const HEADER = "x-webdesk-editorial-assertion";
const NOT_ALLOWED = "contributor-command-not-allowed";
const CONTRIBUTOR = "erp-contributor-user-1";
const STAFF = "erp-staff-user-1";

describe("M5-W1e contributors: enforcement in the write plane (real resolver, signed `xc` assertions)", () => {
  let app: NestFastifyApplication;
  let fx: ContentFixture;
  const clock = Math.floor(Date.now() / 1000);
  const key = freshKey("wde-xc-enf");
  const seen = new Set<string>();
  const params = () => ({ tenantSlug: fx.slug, siteId: fx.siteId });
  const siteUrl = () => `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}`;

  beforeAll(async () => {
    const resolver = new RealEditorialPrincipalResolver({
      keys: keySetOf(key),
      // a REAL single-use store (in memory), so a replayed assertion is refused
      store: { consume: async (jti: string) => (seen.has(jti) ? false : (seen.add(jti), true)), close: async () => {} },
      now: () => clock,
    });
    app = await buildContentApp((b) => b.overrideProvider(EDITORIAL_PRINCIPAL_RESOLVER).useValue(resolver));
    fx = await createContentFixture("xc1e");
  });
  afterAll(async () => {
    await app?.close();
  });

  // ── a signed request, as the ERP would send it ─────────────────────────────────────────────────
  interface Call {
    method: "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    command: CommandName;
    params: Record<string, string>;
    body?: Record<string, unknown>;
    /** true = a contributor principal (the signed claim `xc: true`); false/omitted = staff. */
    xc?: boolean;
    /** HIGH commands: the WS4 approval id (also the assertion's `apr`). */
    approval?: string;
  }
  function claimsOf(c: Call, over: Partial<ClaimInput> = {}): ClaimInput {
    const args = { ...c.params, ...(c.body ?? {}) };
    return {
      sub: c.xc ? CONTRIBUTOR : STAFF,
      pk: "human",
      ten: fx.slug,
      site: fx.siteId,
      cmd: c.command,
      cmh: computeCommandHash(c.command, args),
      ...(c.approval ? { apr: c.approval } : {}),
      ...(c.xc ? { xc: true } : {}),
      iat: clock,
      exp: clock + 60,
      jti: randomUUID(),
      ...over,
    };
  }
  function send(c: Call, assertion: string) {
    const headers = hdr({ editorial: null, ws4: c.approval ? ws4For(c.command, c.params, c.body ?? {}, c.approval) : undefined });
    headers[HEADER] = assertion;
    return app.inject({ method: c.method, url: c.url, headers, payload: c.body });
  }
  const call = (c: Call) => send(c, mintEditorial(key, claimsOf(c)));

  const create = (body: Record<string, unknown>, xc = false) => call({ method: "POST", url: `${base(fx)}/items`, command: "content.create", params: params(), body, xc });
  const update = (itemId: string, body: Record<string, unknown>, xc = false) =>
    call({ method: "PUT", url: `${base(fx)}/items/${itemId}`, command: "content.update", params: { ...params(), itemId }, body, xc });
  const publish = (items: { itemId: string; version: number }[], xc = false) =>
    call({ method: "POST", url: `${base(fx)}/publish`, command: "content.publish", params: params(), body: { items }, xc, approval: `apr-${randomUUID()}` });
  const ed = (itemId: string) => `${base(fx)}/items/${itemId}/editorial`;
  const review = (itemId: string, path: string, command: CommandName, body: Record<string, unknown>, xc: boolean) =>
    call({ method: "POST", url: `${ed(itemId)}/${path}`, command, params: { ...params(), itemId }, body, xc });
  const setPolicy = (reviewRequired: boolean, seoSignoffRequired: boolean, xc = false) =>
    call({
      method: "PUT",
      url: `${siteUrl()}/collections/service/editorial-policy`,
      command: "editorial.policySet",
      params: { ...params(), key: "service" },
      body: { reviewRequired, seoSignoffRequired },
      xc,
    });

  const slug = () => `service.xc-${randomUUID().slice(0, 8)}`;
  const newBody = (s = slug()) => ({ collectionKey: "service", locale: "en", slug: s, fields: serviceFields({ h1: "Contributor draft" }) });

  async function rows(sql: string, args: unknown[] = []): Promise<any[]> {
    return asTenant(fx.tenantId, async (db) => (await db.query(sql, args)).rows);
  }
  const itemCount = async (s: string) => (await rows(`SELECT count(*)::int AS n FROM content_items WHERE slug = $1`, [s]))[0].n as number;

  function expectProblem(r: { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string }, status: number, slugName: string) {
    expect(r.statusCode, r.body).toBe(status);
    expect(String(r.headers["content-type"])).toContain("application/problem+json");
    expect(r.json().type).toBe(`${PROBLEM}${slugName}`);
  }
  /** The house's problem body: RFC 9457 members type, title, status, detail; nothing missing, nothing blank. */
  function expectWellFormedRefusal(r: { statusCode: number; headers: Record<string, unknown>; json: () => any; body: string }, command: CommandName) {
    expectProblem(r, 403, NOT_ALLOWED);
    const b = r.json();
    expect(b).toEqual({
      type: `${PROBLEM}${NOT_ALLOWED}`,
      title: "Command not allowed for a contributor",
      status: 403,
      detail: expect.stringContaining(command),
    });
  }

  /** A staff-created item (full power) in the `service` collection, returns its id. */
  async function staffItem(): Promise<string> {
    const r = await create(newBody(), false);
    expect(r.statusCode, r.body).toBe(201);
    return r.json().item.itemId as string;
  }

  /** Review ON for the `service` collection (a staff-signed policySet), SEO sign-off required. */
  async function reviewOn() {
    const r = await setPolicy(true, true, false);
    expect(r.statusCode, r.body).toBe(200);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The commands a contributor may run: each succeeds with `xc: true`
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("commands allowed to a contributor (each succeeds with xc: true)", () => {
    it("content.create, content.update and content.restoreVersion", async () => {
      const s = slug();
      const c = await create(newBody(s), true);
      expect(c.statusCode, c.body).toBe(201);
      const itemId = c.json().item.itemId as string;
      expect((await rows(`SELECT created_by FROM content_versions WHERE content_item_id = $1 AND version = 1`, [itemId]))[0].created_by).toBe(CONTRIBUTOR);

      const u = await update(itemId, { baseVersion: 1, fields: serviceFields({ h1: "Contributor edit" }) }, true);
      expect(u.statusCode, u.body).toBe(200);
      expect(u.json().version.version).toBe(2);

      const r = await call({
        method: "POST",
        url: `${base(fx)}/items/${itemId}/restore`,
        command: "content.restoreVersion",
        params: { ...params(), itemId },
        body: { version: 1, baseVersion: 2 },
        xc: true,
      });
      expect(r.statusCode, r.body).toBe(200);
    });

    it("content.previewToken and content.previewTokenRevoke", async () => {
      const itemId = await staffItem();
      const mint = await call({ method: "POST", url: `${base(fx)}/items/${itemId}/preview-token`, command: "content.previewToken", params: { ...params(), itemId }, body: {}, xc: true });
      expect(mint.statusCode, mint.body).toBe(201);
      const tokenId = mint.json().tokenId as string;
      const rev = await call({ method: "DELETE", url: `${base(fx)}/items/${itemId}/preview-tokens/${tokenId}`, command: "content.previewTokenRevoke", params: { ...params(), itemId, tokenId }, xc: true });
      expect(rev.statusCode, rev.body).toBe(200);
    });

    it("editorial.submit, comment, commentResolve, seoSignoff and requestChanges", async () => {
      await reviewOn();
      const c = await create(newBody(), true);
      expect(c.statusCode, c.body).toBe(201);
      const itemId = c.json().item.itemId as string;

      const sub = await review(itemId, "submit", "editorial.submit", { version: 1 }, true);
      expect(sub.statusCode, sub.body).toBe(200);
      expect(sub.json().editorial.state).toBe("in_review");

      const com = await review(itemId, "comments", "editorial.comment", { version: 1, body: "Tighten the intro." }, true);
      expect(com.statusCode, com.body).toBeLessThan(300);
      const commentId = com.json().commentId as string;
      const res = await call({
        method: "POST",
        url: `${ed(itemId)}/comments/${commentId}/resolve`,
        command: "editorial.commentResolve",
        params: { ...params(), itemId, commentId },
        body: {},
        xc: true,
      });
      expect(res.statusCode, res.body).toBe(200);

      const seo = await review(itemId, "seo-signoff", "editorial.seoSignoff", { version: 1 }, true);
      expect(seo.statusCode, seo.body).toBe(200);

      const rc = await review(itemId, "request-changes", "editorial.requestChanges", { version: 1, note: "Needs a source." }, true);
      expect(rc.statusCode, rc.body).toBe(200);
      expect(rc.json().editorial.state).toBe("changes_requested");
    });

    it("editorial.withdraw", async () => {
      await reviewOn();
      const c = await create(newBody(), true);
      const itemId = c.json().item.itemId as string;
      expect((await review(itemId, "submit", "editorial.submit", { version: 1 }, true)).statusCode).toBe(200);
      const w = await review(itemId, "withdraw", "editorial.withdraw", {}, true);
      expect(w.statusCode, w.body).toBe(200);
      expect(w.json().editorial.state).toBe("draft");
    });

    it("every command in CONTRIBUTOR_COMMANDS is covered by this block (no allowed command goes untested over HTTP)", () => {
      expect([...CONTRIBUTOR_COMMANDS].sort()).toEqual(
        [
          "content.create",
          "content.update",
          "content.restoreVersion",
          "content.previewToken",
          "content.previewTokenRevoke",
          "editorial.submit",
          "editorial.withdraw",
          "editorial.comment",
          "editorial.commentResolve",
          "editorial.requestChanges",
          "editorial.seoSignoff",
        ].sort(),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The commands refused to a contributor: 403, a valid body, nothing written
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("commands refused to a contributor: 403 contributor-command-not-allowed", () => {
    // Review is OFF while the staff controls publish, so the publish pairs meet no review gate (W2c); the approve and policy rows switch it ON.
    beforeAll(async () => {
      const r = await setPolicy(false, false, false);
      expect(r.statusCode, r.body).toBe(200);
    });

    it("content.publish (HIGH, with its WS4 approval and apr): refused, nothing published; as staff it is published (200)", async () => {
      const itemId = await staffItem();
      const r = await publish([{ itemId, version: 1 }], true);
      expectWellFormedRefusal(r, "content.publish");
      expect((await rows(`SELECT published_version FROM content_items WHERE id = $1`, [itemId]))[0].published_version).toBeNull();
      expect((await publish([{ itemId, version: 1 }], false)).statusCode).toBe(200);
    });

    it("content.schedule (HIGH): refused; as staff it is scheduled (200)", async () => {
      const itemId = await staffItem();
      const publishAt = new Date(Date.now() + 3_600_000).toISOString();
      const mk = (xc: boolean) =>
        call({ method: "POST", url: `${base(fx)}/schedule`, command: "content.schedule", params: params(), body: { items: [{ itemId, version: 1 }], publishAt }, xc, approval: `apr-${randomUUID()}` });
      expectWellFormedRefusal(await mk(true), "content.schedule");
      expect((await rows(`SELECT publish_state FROM content_items WHERE id = $1`, [itemId]))[0].publish_state).toBe("draft");
      expect((await mk(false)).statusCode).toBe(200);
    });

    it("content.unpublish: refused, the item stays live; as staff it is taken down (200)", async () => {
      const itemId = await staffItem();
      expect((await publish([{ itemId, version: 1 }], false)).statusCode).toBe(200);
      const mk = (xc: boolean) =>
        call({ method: "POST", url: `${base(fx)}/items/${itemId}/unpublish`, command: "content.unpublish", params: { ...params(), itemId }, body: { expectedPublishedVersion: 1 }, xc });
      expectWellFormedRefusal(await mk(true), "content.unpublish");
      expect((await rows(`SELECT published_version FROM content_items WHERE id = $1`, [itemId]))[0].published_version).toBe(1);
      expect((await mk(false)).statusCode).toBe(200);
    });

    it("content.delete: refused, the item is not deleted; as staff it is deleted (200)", async () => {
      const itemId = await staffItem();
      const mk = (xc: boolean) => call({ method: "POST", url: `${base(fx)}/items/${itemId}/delete`, command: "content.delete", params: { ...params(), itemId }, body: { baseVersion: 1 }, xc });
      expectWellFormedRefusal(await mk(true), "content.delete");
      expect((await rows(`SELECT deleted_at FROM content_items WHERE id = $1`, [itemId]))[0].deleted_at).toBeNull();
      expect((await mk(false)).statusCode).toBe(200);
    });

    it("media.update and media.delete: refused, nothing changes; as staff each succeeds (media.uploadToken is allowed: it quarantines, see media-quarantine.spec.ts)", async () => {
      const asset = await seedAsset(fx, { title: "old" });
      const upd = (xc: boolean) =>
        call({ method: "PATCH", url: `${mediaBase(fx)}/${asset.id}`, command: "media.update", params: { ...params(), assetId: asset.id }, body: { title: "new title" }, xc });
      expectWellFormedRefusal(await upd(true), "media.update");
      expect((await rows(`SELECT title FROM media_assets WHERE id = $1`, [asset.id]))[0].title).toBe("old");
      expect((await upd(false)).statusCode).toBe(200);

      const del = (xc: boolean) => call({ method: "DELETE", url: `${mediaBase(fx)}/${asset.id}`, command: "media.delete", params: { ...params(), assetId: asset.id }, xc });
      expectWellFormedRefusal(await del(true), "media.delete");
      expect((await rows(`SELECT deleted_at FROM media_assets WHERE id = $1`, [asset.id]))[0].deleted_at).toBeNull();
      expect((await del(false)).statusCode).toBe(200);
    });

    it("media.review: refused, the quarantined asset stays quarantined; as staff it is accepted (200)", async () => {
      const asset = await seedAsset(fx, { title: "held", reviewState: "quarantined", createdBy: "erp-contributor-user-2" });
      const mk = (xc: boolean) =>
        call({ method: "POST", url: `${mediaBase(fx)}/${asset.id}/review`, command: "media.review", params: { ...params(), assetId: asset.id }, body: { decision: "accept" }, xc });
      expectWellFormedRefusal(await mk(true), "media.review");
      expect((await rows(`SELECT review_state FROM media_assets WHERE id = $1`, [asset.id]))[0].review_state).toBe("quarantined");
      expect((await mk(false)).statusCode).toBe(200);
      expect((await rows(`SELECT review_state FROM media_assets WHERE id = $1`, [asset.id]))[0].review_state).toBe("accepted");
    });

    it("editorial.approve: refused, the item stays in review", async () => {
      await reviewOn();
      const c = await create(newBody(), true);
      const itemId = c.json().item.itemId as string;
      expect((await review(itemId, "submit", "editorial.submit", { version: 1 }, true)).statusCode).toBe(200);
      expectWellFormedRefusal(await review(itemId, "approve", "editorial.approve", { version: 1 }, true), "editorial.approve");
      expect((await rows(`SELECT state FROM editorial_items WHERE content_item_id = $1`, [itemId]))[0].state).toBe("in_review");
    });

    it("editorial.assign: refused; as staff it is accepted (200)", async () => {
      const itemId = await staffItem();
      const mk = (xc: boolean) => review(itemId, "assign", "editorial.assign", { authorSub: "erp-writer-9" }, xc);
      expectWellFormedRefusal(await mk(true), "editorial.assign");
      expect((await mk(false)).statusCode).toBe(200);
    });

    it("editorial.policySet: refused, the collection's policy is unchanged; as staff it is changed", async () => {
      await reviewOn();
      expectWellFormedRefusal(await setPolicy(false, false, true), "editorial.policySet");
      expect((await rows(`SELECT review_required FROM editorial_policies WHERE collection_key = 'service' AND site_id = $1`, [fx.siteId]))[0].review_required).toBe(true);
      expect((await setPolicy(true, false, false)).statusCode).toBe(200);
      expect((await rows(`SELECT seo_signoff_required FROM editorial_policies WHERE collection_key = 'service' AND site_id = $1`, [fx.siteId]))[0].seo_signoff_required).toBe(false);
    });

    it("over HTTP, EVERY editorial command is either on CONTRIBUTOR_COMMANDS or refused: the two blocks above cover the registry's EDITORIAL_COMMANDS exactly", () => {
      const refusedHere = [
        "content.publish",
        "content.schedule",
        "content.unpublish",
        "content.delete",
        "media.review",
        "media.update",
        "media.delete",
        "editorial.approve",
        "editorial.assign",
        "editorial.policySet",
      ];
      const covered = new Set<string>([...CONTRIBUTOR_COMMANDS, ...refusedHere]);
      expect([...EDITORIAL_COMMANDS].filter((c) => !covered.has(c))).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // The claim itself
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the `xc` claim", () => {
    it("a non-boolean xc is 401 editorial-assertion-claims, whatever its type; nothing is written", async () => {
      for (const bad of ["true", 1, null, [], {}]) {
        const s = slug();
        const c: Call = { method: "POST", url: `${base(fx)}/items`, command: "content.create", params: params(), body: newBody(s) };
        const jws = mintRaw(wireHeader(key.kid), { ...wirePayload(claimsOf(c)), xc: bad }, key.privateKey);
        const r = await send(c, jws);
        expectProblem(r, 401, "editorial-assertion-claims");
        expect(await itemCount(s), JSON.stringify(bad)).toBe(0);
      }
    });

    it("xc together with ce is 401 editorial-assertion-claims (true/true, true/false, false/false); nothing is written", async () => {
      for (const [xc, ce] of [[true, true], [true, false], [false, false], [false, true]] as const) {
        const s = slug();
        const c: Call = { method: "POST", url: `${base(fx)}/items`, command: "content.create", params: params(), body: newBody(s) };
        const r = await send(c, mintEditorial(key, claimsOf(c, { xc, ce })));
        expectProblem(r, 401, "editorial-assertion-claims");
        expect(await itemCount(s), `xc ${xc} ce ${ce}`).toBe(0);
      }
    });

    it("xc: false is accepted and is NOT a contributor: the staff-only command succeeds (200)", async () => {
      const itemId = await staffItem();
      const c: Call = { method: "POST", url: `${base(fx)}/items/${itemId}/delete`, command: "content.delete", params: { ...params(), itemId }, body: { baseVersion: 1 } };
      const r = await send(c, mintEditorial(key, claimsOf(c, { xc: false })));
      expect(r.statusCode, r.body).toBe(200);
    });

    it("xc is bound by the signature: adding xc:true to a signed staff payload without re-signing is 401 invalid-signature", async () => {
      const itemId = await staffItem();
      const c: Call = { method: "POST", url: `${base(fx)}/items/${itemId}/delete`, command: "content.delete", params: { ...params(), itemId }, body: { baseVersion: 1 } };
      const good = mintEditorial(key, claimsOf(c));
      const [h, p, sig] = good.split(".");
      const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), xc: true })).toString("base64url")}.${sig}`;
      expectProblem(await send(c, forged), 401, "editorial-assertion-invalid-signature");
    });

    it("replay: the same contributor assertion twice is 201 then 401 editorial-assertion-replayed (one row only)", async () => {
      const s = slug();
      const c: Call = { method: "POST", url: `${base(fx)}/items`, command: "content.create", params: params(), body: newBody(s), xc: true };
      const jws = mintEditorial(key, claimsOf(c));
      expect((await send(c, jws)).statusCode).toBe(201);
      expectProblem(await send(c, jws), 401, "editorial-assertion-replayed");
      expect(await itemCount(s)).toBe(1);
    });

    it("expiry: an expired contributor assertion is 401 editorial-assertion-expired; the tolerance edge still passes", async () => {
      const s = slug();
      const c: Call = { method: "POST", url: `${base(fx)}/items`, command: "content.create", params: params(), body: newBody(s), xc: true };
      expectProblem(await send(c, mintEditorial(key, claimsOf(c, { iat: clock - 71, exp: clock - 11 }))), 401, "editorial-assertion-expired");
      expect(await itemCount(s)).toBe(0);
      expect((await send(c, mintEditorial(key, claimsOf(c, { iat: clock - 69, exp: clock - 9 })))).statusCode).toBe(201);
    });
  });
});
