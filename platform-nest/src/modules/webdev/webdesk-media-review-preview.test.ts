// M5-W1q2 (owner ruling WSK-D84, approved 2026-10-27) -- the reviewer's BYTE PREVIEW of a quarantined upload, the ERP's BFF half:
//
//   GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/media/:assetId/review-preview     the image, or a problem
//
// Real: Postgres (RLS), Cerbos (the real `webdesk_media_asset` policy: its `review` rules and its DENYs for the uploader, a contributor, a bot),
// the full NestJS app (`buildApp()`), the real `AuthGuard` (the contributor fence), the real `WebdeskMediaService` / `WebdeskZoneB` (including
// its raw-bytes read). Stand-in: Zone B, the in-process fake in `webdesk-content-testkit.ts` (it models `media.list` and `media.reviewPreview`,
// and records every call, so "WebDesk was never asked for bytes" is a fact of `zb.calls`, not a guess).
//
// What this proves:
//   bytes     the image, with EXACTLY the six headers (Content-Type, nosniff, CSP sandbox, inline, no-store, CORP same-origin) and no header copied from
//             WebDesk; the file name is fixed and never the uploader's; a read: no ledger row, no signed assertion
//   authz     the order of `review()`: (1) may this caller review SOMEONE's upload (a member is 403 with Zone B untouched, whatever the id or the
//             query), (2) the id is a uuid (404), (3) the asset's real uploader is read from the quarantine, (4) `review` again with the real uploader
//             (the uploader themself, an unknown uploader: 403 with media.list asked but NO bytes asked), (5) only then the bytes. A contributor is fenced
//             by AuthGuard (403 `contributor_route_forbidden`) and a bot by Cerbos (403), each with Zone B untouched; the same request by a reviewer is 200
//   404       a non-uuid, an unknown asset, an accepted one, another site's, another company's: the same 404, and no bytes asked
//   415/413   the ERP's own wall: bytes that do not bear the declared mime's signature (PNG declared, HTML bytes), a declared type outside the allow-list,
//             a row and a content type that disagree, bytes over 10 MiB: refused, the bytes dropped. WebDesk's own refusals (svg, over the cap) pass through
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { PREVIEW_MAX_BYTES } from "./webdesk-media-preview";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, makeTestSigner, type FakeMediaAsset } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const CONTRIBUTOR_SUB = "contributor-user-1"; // a freelance writer's principal sub: not one of the company's users

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 0x61)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 0x62)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(40, 0x63)]);
const WEBP = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBP", "latin1"), Buffer.alloc(40, 0x64)]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif", "latin1"), Buffer.alloc(40, 0x65)]);
const HTML = Buffer.from("<!doctype html><html><script>fetch('/api/me').then(r=>r.text()).then(t=>document.title=t)</script></html>");

describe.skipIf(!live)("M5-W1q2 · the reviewer's byte preview, BFF", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let adminA: string, editorA: string, managerA: string, publisherA: string, memberA: string, adminB: string, contributorU: string, botU: string, writerA: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const base = (co = A) => `/api/${co}/modules/webdev/content`;
  const site = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${base(co)}/sites/${slug}/${siteId}`;
  const preview = (assetId: string, as: string, co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE, qs = "") =>
    app.inject({ method: "GET", url: `${site(co, slug, siteId)}/media/${assetId}/review-preview${qs}`, headers: asUser(as) });
  const quarantined = (over: Partial<FakeMediaAsset> = {}): FakeMediaAsset =>
    zb.seedMedia({ siteId: GAIADA_SITE, title: "Held", originalFilename: "held.png", reviewState: "quarantined", createdBy: CONTRIBUTOR_SUB, ...over });
  const bytesCalls = () => zb.calls.filter((c) => c.command === "media.reviewPreview");
  const listCalls = () => zb.calls.filter((c) => c.command === "media.list");
  async function ledgerCount() {
    const { rows } = await adminPool().query<{ n: string }>(`SELECT count(*)::text AS n FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A]);
    return Number(rows[0].n);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W1q2 Co A", ["webdev"]);
    B = await createCompany("W1q2 Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "w1q2-admin-a@ex.test", "company_admin");
    editorA = await mk(A, "w1q2-editor-a@ex.test", "webdev_staff");
    managerA = await mk(A, "w1q2-manager-a@ex.test", "manager");
    publisherA = await mk(A, "w1q2-publisher-a@ex.test", "webdev_manager");
    memberA = await mk(A, "w1q2-member-a@ex.test", "member");
    adminB = await mk(B, "w1q2-admin-b@ex.test", "company_admin");
    // A freelance contributor: the AuthGuard fence refuses every route that is not marked @ContributorRoute() (this one is not).
    // Built as auth/contributor-fence.db.test.ts builds one: kind contributor and an active anchor sponsored by a staff user.
    contributorU = await createUser("w1q2-contributor-a@ex.test", "Freelance Writer");
    await adminPool().query(`UPDATE users SET kind = 'contributor' WHERE id = $1`, [contributorU]);
    await adminPool().query(
      `INSERT INTO editorial_contributors (tenant_id, user_id, sponsor_user_id, status, valid_until, origin_site)
       VALUES ($1, $2, $3, 'active', now() + interval '30 days', $4)`,
      [A, contributorU, adminA, config.originSite],
    );
    // An EMPLOYEE writer holding a writers' room grant on the site (webdesk_writer): may read the library (phase 1 passes), may NOT review.
    writerA = await mk(A, "w1q2-writer-emp-a@ex.test", "member");
    {
      const roleId = await createRole("webdesk_writer");
      await grantRole(writerA, roleId, "company", A);
      const g = (await adminPool().query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [writerA, roleId])).rows[0].id;
      await adminPool().query(
        `INSERT INTO user_role_editorial_scopes (user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
         VALUES ($1, $2, $3, $4, false, $5, false, $6, $7)`,
        [g, A, GAIADA_SLUG, GAIADA_SITE, ["post"], ["en"], config.originSite],
      );
    }
    // A bot that holds an admin role: Cerbos refuses `review` to a bot whatever else it holds.
    botU = await mk(A, "w1q2-bot-a@ex.test", "company_admin");
    await adminPool().query(`UPDATE users SET kind = 'bot' WHERE id = $1`, [botU]);
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(() => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the bytes and the six headers", () => {
    it("a reviewer gets the image with EXACTLY the six headers; WebDesk was asked the uploader first and the bytes second; a read writes nothing", async () => {
      const held = quarantined({ bytes: PNG });
      const ledgerBefore = await ledgerCount();
      const r = await preview(held.assetId, editorA);
      expect(r.statusCode, r.body).toBe(200);
      expect(Buffer.compare(r.rawPayload, PNG)).toBe(0);
      expect(r.headers["content-type"]).toBe("image/png");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
      expect(r.headers["content-disposition"]).toBe('inline; filename="preview.png"');
      expect(r.headers["cache-control"]).toBe("private, no-store");
      expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
      // nothing else the page could misuse: no cookie, no validator, no CORS grant, no header of WebDesk's
      for (const h of ["set-cookie", "etag", "last-modified", "access-control-allow-origin", "content-encoding", "x-webdesk-request-id", "link"]) {
        expect(r.headers[h], h).toBeUndefined();
      }
      // the order of WebDesk calls: the asset's row (reviewState=quarantined, this id only), then the bytes
      const calls = zb.calls.filter((c) => c.command === "media.list" || c.command === "media.reviewPreview");
      expect(calls.map((c) => c.command)).toEqual(["media.list", "media.reviewPreview"]);
      expect(calls[0]).toMatchObject({ method: "GET", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE }, query: { assetId: held.assetId, reviewState: "quarantined", limit: "1" } });
      expect(calls[1]).toMatchObject({ method: "GET", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, assetId: held.assetId } });
      expect(calls[1].editorialAssertion).toBeUndefined(); // a read carries no editorial assertion
      expect(signer.calls).toHaveLength(0);
      expect(await ledgerCount()).toBe(ledgerBefore); // no ledger row, no activity
    });

    it("each raster type is served as itself, with its own fixed file name (never the uploader's)", async () => {
      const cases: Array<[string, Buffer, string]> = [
        ["image/png", PNG, "png"],
        ["image/jpeg", JPEG, "jpg"],
        ["image/gif", GIF, "gif"],
        ["image/webp", WEBP, "webp"],
        ["image/avif", AVIF, "avif"],
      ];
      for (const [mime, bytes, ext] of cases) {
        const held = quarantined({ mime, bytes, originalFilename: `"; evil=1\r\nx-injected: yes.${ext}` });
        const r = await preview(held.assetId, publisherA);
        expect(r.statusCode, `${mime}: ${r.body.slice(0, 120)}`).toBe(200);
        expect(r.headers["content-type"], mime).toBe(mime);
        expect(r.headers["content-disposition"], mime).toBe(`inline; filename="preview.${ext}"`);
        expect(r.headers["x-injected"], mime).toBeUndefined();
        expect(Buffer.compare(r.rawPayload, bytes), mime).toBe(0);
      }
    });

    it("every staff tier that may review gets the same bytes (company admin, Web Dev editor, manager, Web Dev manager)", async () => {
      const held = quarantined({ bytes: PNG });
      for (const who of [adminA, editorA, managerA, publisherA]) {
        const r = await preview(held.assetId, who);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
        expect(Buffer.compare(r.rawPayload, PNG)).toBe(0);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("authz: the order of review(), and no byte is asked for before it passes", () => {
    it("THE UPLOADER NEVER PREVIEWS THEIR OWN UPLOAD: 403, WebDesk is asked for the row but NEVER for bytes; another reviewer's identical request is 200", async () => {
      const mine = quarantined({ createdBy: editorA, bytes: PNG });
      const self = await preview(mine.assetId, editorA);
      expect(self.statusCode, self.body).toBe(403);
      expect(listCalls().length).toBeGreaterThan(0);
      expect(bytesCalls()).toHaveLength(0);
      expect(Buffer.compare(self.rawPayload, PNG)).not.toBe(0);
      expect((await preview(mine.assetId, publisherA)).statusCode).toBe(200); // positive control, same asset, same route
      expect(bytesCalls()).toHaveLength(1);
    });

    it("an upload whose uploader is unknown is refused to everyone (four eyes cannot be shown), and no bytes are asked for", async () => {
      const orphan = quarantined({ createdBy: null });
      for (const who of [adminA, publisherA]) expect((await preview(orphan.assetId, who)).statusCode, who).toBe(403);
      expect(bytesCalls()).toHaveLength(0);
    });

    it("an employee WRITER (the writers' room read passes phase 1, `review` does not) is 403 at the FIRST review check: no row and no bytes are asked for, for any id; a non-uuid is 403, not 404", async () => {
      const held = quarantined({ bytes: PNG });
      for (const id of [held.assetId, "not-a-uuid", randomUUID()]) {
        const r = await preview(id, writerA);
        expect(r.statusCode, id).toBe(403);
      }
      // the site wall may read the tenant list; nothing about the asset (its row, its bytes) is asked
      expect(zb.calls.filter((c) => c.command === "media.list" || c.command === "media.reviewPreview")).toHaveLength(0);
      expect((await preview(held.assetId, editorA)).statusCode).toBe(200); // positive control
    });

    it("a member (may not review anyone's upload) is 403 BEFORE WebDesk is asked anything, for any id and any query; the reviewer's request is validated", async () => {
      const held = quarantined();
      const before = zb.calls.length;
      for (const [id, qs] of [[held.assetId, ""], ["not-a-uuid", ""], [randomUUID(), ""], [held.assetId, "?size=full"]] as const) {
        const r = await preview(id, memberA, A, GAIADA_SLUG, GAIADA_SITE, qs);
        expect(r.statusCode, `${id}${qs}`).toBe(403);
      }
      expect(zb.calls.length).toBe(before); // not even the row
      // for a reviewer the same inputs are validated: an unknown query key is 400, a non-uuid is the 404
      expect((await preview(held.assetId, editorA, A, GAIADA_SLUG, GAIADA_SITE, "?size=full")).statusCode).toBe(400);
      expect((await preview("not-a-uuid", editorA)).statusCode).toBe(404);
    });

    it("a CONTRIBUTOR is refused by the AuthGuard fence (403 contributor_route_forbidden: the route is not @ContributorRoute()), with WebDesk untouched", async () => {
      const held = quarantined({ createdBy: contributorU, bytes: PNG });
      const before = zb.calls.length;
      const r = await preview(held.assetId, contributorU);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ error: "contributor_route_forbidden", reason: "route_not_open_to_contributors" });
      expect(zb.calls.length).toBe(before);
      expect(bytesCalls()).toHaveLength(0);
      expect((await preview(held.assetId, editorA)).statusCode).toBe(200); // positive control: staff, same asset
    });

    it("a BOT holding an admin role is 403 (Cerbos refuses `review` to a bot), and no bytes are asked for; the same request by a human admin is 200", async () => {
      const held = quarantined({ bytes: PNG });
      const r = await preview(held.assetId, botU);
      expect(r.statusCode, r.body).toBe(403);
      expect(bytesCalls()).toHaveLength(0);
      expect((await preview(held.assetId, adminA)).statusCode).toBe(200);
    });

    it("the wall: another company's admin gets the site's 404, and WebDesk is never asked for the row or the bytes", async () => {
      const held = quarantined();
      const r = await preview(held.assetId, adminB, B);
      expect(r.statusCode).toBe(404);
      expect(listCalls().filter((c) => c.query?.assetId === held.assetId)).toHaveLength(0);
      expect(bytesCalls()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("404: one answer for every asset that is not a quarantined upload of this site", () => {
    it("a non-uuid, an unknown id, an accepted asset, another site's upload: the same typed 404, and no bytes asked", async () => {
      const accepted = zb.seedMedia({ siteId: GAIADA_SITE, title: "Public", originalFilename: "public.png" });
      const elsewhere = quarantined({ siteId: OTHER_SITE });
      const bodies = new Set<string>();
      for (const id of ["not-a-uuid", randomUUID(), accepted.assetId, elsewhere.assetId]) {
        const r = await preview(id, editorA);
        expect(r.statusCode, id).toBe(404);
        expect(String(r.headers["content-type"]), id).toMatch(/application\/problem\+json/);
        expect(r.json().type, id).toContain("/media-asset-not-found");
        bodies.add(JSON.stringify(r.json()));
      }
      expect(bodies.size).toBe(1);
      expect(bytesCalls()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("415 and 413: the ERP's own wall on the bytes, and WebDesk's refusals passed through", () => {
    it("PNG declared, HTML bytes: 415, the bytes are dropped (nothing of them reaches the caller)", async () => {
      const held = quarantined({ bytes: HTML });
      const r = await preview(held.assetId, editorA);
      expect(r.statusCode).toBe(415);
      expect(String(r.headers["content-type"])).toMatch(/application\/problem\+json/);
      expect(r.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/media-preview-unsupported", status: 415, mime: "image/png" });
      expect(r.body).not.toContain("<script");
      expect(r.headers["content-security-policy"]).toBeUndefined(); // a problem, not a preview
      expect(bytesCalls()).toHaveLength(1); // the bytes WERE asked for (authorization passed); the ERP is what refused them
    });

    it("every other mismatch is refused too: JPEG bytes for a PNG row, an SVG or HTML or PDF content type, a row and a content type that disagree, empty bytes", async () => {
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
      const cases: Array<[string, Partial<FakeMediaAsset>]> = [
        ["jpeg bytes, png row", { mime: "image/png", bytes: JPEG }],
        ["svg content type", { mime: "image/png", bytes: svg, previewContentType: "image/svg+xml" }],
        ["html content type", { mime: "image/png", bytes: HTML, previewContentType: "text/html; charset=utf-8" }],
        ["pdf content type", { mime: "image/png", bytes: Buffer.from("%PDF-1.4 x"), previewContentType: "application/pdf" }],
        ["row png, content type jpeg", { mime: "image/png", bytes: JPEG, previewContentType: "image/jpeg" }],
        ["empty bytes", { mime: "image/png", bytes: Buffer.alloc(0) }],
        ["an mp4 as avif", { mime: "image/avif", bytes: Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(20)]) }],
        ["a wav as webp", { mime: "image/webp", bytes: Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([1, 0, 0, 0]), Buffer.from("WAVE", "latin1"), Buffer.alloc(20)]) }],
      ];
      for (const [label, over] of cases) {
        const held = quarantined(over);
        const r = await preview(held.assetId, editorA);
        expect(r.statusCode, label).toBe(415);
        expect(r.headers["content-security-policy"], label).toBeUndefined();
        expect(r.rawPayload.length, label).toBeLessThan(600); // a small problem body, not the bytes
      }
    });

    it("bytes over 10 MiB are 413 even when WebDesk's row said a small size; exactly the cap is served", async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(PREVIEW_MAX_BYTES - PNG.length + 1, 0x61)]);
      expect(big.length).toBe(PREVIEW_MAX_BYTES + 1);
      const r = await preview(quarantined({ bytes: big }).assetId, editorA);
      expect(r.statusCode).toBe(413);
      expect(r.json().type).toContain("/media-preview-too-large");
      const exact = Buffer.concat([PNG, Buffer.alloc(PREVIEW_MAX_BYTES - PNG.length, 0x61)]);
      expect(exact.length).toBe(PREVIEW_MAX_BYTES);
      const ok = await preview(quarantined({ bytes: exact }).assetId, editorA);
      expect(ok.statusCode).toBe(200);
      expect(ok.rawPayload.length).toBe(PREVIEW_MAX_BYTES);
    });

    it("WebDesk's own refusals pass through untouched: an SVG upload is its 415 carrying the mime, one over its cap is its 413", async () => {
      const svg = quarantined({ mime: "image/svg+xml", originalFilename: "logo.svg" });
      const r = await preview(svg.assetId, editorA);
      expect(r.statusCode).toBe(415);
      expect(String(r.headers["content-type"])).toMatch(/application\/problem\+json/);
      expect(r.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/media-preview-unsupported", mime: "image/svg+xml" });
      const huge = quarantined({ sizeBytes: PREVIEW_MAX_BYTES + 1 });
      const r2 = await preview(huge.assetId, editorA);
      expect(r2.statusCode).toBe(413);
      expect(r2.json().type).toContain("/media-preview-too-large");
    });
  });
});
