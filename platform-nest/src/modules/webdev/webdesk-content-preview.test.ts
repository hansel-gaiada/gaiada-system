// WSK-46 (owner ruling WSK-D52) — the ERP half of draft preview: `POST …/content/sites/:ts/:site/items/:itemId/preview`
// and the MCP tool `webdesk.content.preview`.
//
// Same harness as webdesk-content.test.ts: real Postgres (RLS, the activities ledger), real Cerbos (the real WSK-47
// policies), the full NestJS app, the real `WebdeskContentService`/`WebdeskZoneB`; Zone B is the strict in-process fake
// (`webdesk-content-testkit.ts`: it decodes the editorial assertion and refuses a mismatched `cmd`/`cmh`/`ten`/`site`),
// and the site's `/preview/` HEAD is a stub (the one other egress this route has).
//
// What is pinned, in the order of the brief:
//   * authorize-FIRST: a reader is 403 with a VALID body and nothing reaches Zone B or the site; an editor is the positive control
//   * the cross-company 404 wall
//   * the control call carries the editorial assertion (bound to THIS command) and an Idempotency-Key
//   * the URL shape: `<staging>/preview/#t=<token>`, the token in the FRAGMENT, never a query string
//   * `preview_not_configured`; `preview_page_missing` (the honest live state TODAY: gaiada.com's staging site has no /preview/
//     page yet), each with NO mint and no Zone B call
//   * the page-exists check is cached for 5 minutes, and only a definite answer is cached
//   * every WebDesk refusal maps the way the other writes map
//   * the token is absent from every log line and every ledger row
//   * the MCP tool is the same path
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
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
import { setPreviewProbeForTests } from "./webdesk-preview";
import { webdevModule } from "./index";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, problem, type FakeItem } from "./webdesk-content-testkit";

// A pass-through spy on the platform's Cerbos gate, so the test can pin WHICH action and kind the preview asks for. Read and update
// are granted identically today (no role reads without updating), so behaviour alone cannot tell `update` from `read`: the call can.
const authCalls = vi.hoisted(() => [] as Array<{ resource: Record<string, unknown>; action: string }>);
vi.mock("../../core/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../core/http")>();
  return {
    ...real,
    authorize: (async (principal: never, resource: never, action: never) => {
      authCalls.push({ resource: { ...(resource as Record<string, unknown>) }, action: action as string });
      return (real.authorize as (...a: unknown[]) => Promise<unknown>)(principal, resource, action);
    }) as typeof real.authorize,
  };
});

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const STAGING = "https://staging.gaiada.test";

describe.skipIf(!live)("WSK-46 · the preview route and its MCP tool", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let adminA: string, editorA: string, publisherA: string, memberA: string, adminB: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  // ── the site's /preview/ page, as a stub HEAD ────────────────────────────────────────────────────
  let clock = 1_000_000_000;
  let headAnswer: number | Error = 200;
  let heads: Array<{ url: string; method: string | undefined; redirect: string | undefined }> = [];
  const headStub = (async (url: string | URL | Request, init?: RequestInit) => {
    heads.push({ url: String(url), method: init?.method, redirect: init?.redirect });
    if (headAnswer instanceof Error) throw headAnswer;
    return new Response(null, { status: headAnswer });
  }) as unknown as typeof fetch;

  const base = (co = A) => `/api/${co}/modules/webdev/content`;
  const site = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${base(co)}/sites/${slug}/${siteId}`;
  const call = (method: "GET" | "POST" | "PUT", url: string, as: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...asUser(as), ...headers }, payload: payload as never });
  const preview = (as: string, itemId: string, body?: unknown, headers: Record<string, string> = {}, siteUrl = site()) =>
    call("POST", `${siteUrl}/items/${itemId}/preview`, as, body === undefined ? {} : body, headers);

  const mints = () => zb.calls.filter((c) => c.command === "content.previewToken");

  async function ledger(verbLike = "webdesk.%") {
    const { rows } = await adminPool().query<{ verb: string; actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT verb, actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb LIKE $2 ORDER BY occurred_at, id`,
      [A, verbLike],
    );
    return rows;
  }
  const clearLedger = () => adminPool().query(`DELETE FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A]);

  let item: FakeItem; // a DRAFT service page in A's site

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-46 Co A", ["webdev"]);
    B = await createCompany("WSK-46 Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "wsk46-admin-a@ex.test", "company_admin");
    editorA = await mk(A, "wsk46-editor-a@ex.test", "webdev_staff");
    publisherA = await mk(A, "wsk46-publisher-a@ex.test", "webdev_manager");
    memberA = await mk(A, "wsk46-member-a@ex.test", "member");
    adminB = await mk(B, "wsk46-admin-b@ex.test", "company_admin");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    authCalls.length = 0;
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    clock = 1_000_000_000;
    headAnswer = 200;
    heads = [];
    setPreviewProbeForTests({ fetchImpl: headStub, now: () => clock });
    item = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.seo" });
    await clearLedger();
  });
  afterEach(() => {
    setWebdeskApprovedCommandDepsForTests(null);
    setPreviewProbeForTests(null);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("golden case: an editor previews a draft", () => {
    it("200 {previewUrl, expiresAt, version}: the link is <staging>/preview/#t=<token>, token in the FRAGMENT, no query string", async () => {
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(Object.keys(body).sort()).toEqual(["expiresAt", "previewUrl", "version"]);
      expect(body.version).toBe(1);
      expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());

      const token = zb.mintedPreviewTokens[0];
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.previewUrl).toBe(`${STAGING}/preview/#t=${token}`);
      const u = new URL(body.previewUrl);
      expect(u.protocol).toBe("https:");
      expect(u.search).toBe(""); // never a query string: a query string is sent to servers and written to access logs
      expect(u.hash).toBe(`#t=${token}`);
      // the plaintext token appears ONCE in the response, and Zone B's own `previewPath` (which embeds it) is not forwarded
      expect(r.body.split(token)).toHaveLength(2);
      expect(r.body).not.toContain("/v1/t/");
      expect(r.body).not.toContain("previewPath");
      expect(r.body).not.toContain("tokenId");
    });

    it("the staging base is the site's `staging` environment domain from tenant.list: the SAME source the editor's `View on staging` uses", async () => {
      zb.stagingDomain = "Staging.Example-Site.test";
      webdeskZoneB.clearSiteCache();
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(200);
      expect(r.json().previewUrl.startsWith("https://staging.example-site.test/preview/#t=")).toBe(true);
      expect(heads.map((h) => h.url)).toEqual(["https://staging.example-site.test/preview/"]);
    });

    it("the page check is a HEAD to <staging>/preview/ with redirects NOT followed; it happens before the mint", async () => {
      await preview(editorA, item.itemId);
      expect(heads).toEqual([{ url: `${STAGING}/preview/`, method: "HEAD", redirect: "manual" }]);
    });

    it("`version` previews that version: the control body carries it and the answer names it", async () => {
      await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "v2" } });
      const head = await preview(editorA, item.itemId);
      expect(head.json().version).toBe(2);
      const pinned = await preview(editorA, item.itemId, { version: 1 });
      expect(pinned.statusCode, pinned.body).toBe(200);
      expect(pinned.json().version).toBe(1);
      const [m1, m2] = mints();
      expect(m1.body).toEqual({}); // head: nothing pinned
      expect(m2.body).toEqual({ version: 1 });
    });

    it("an absent body is the same as {}", async () => {
      const r = await app.inject({ method: "POST", url: `${site()}/items/${item.itemId}/preview`, headers: asUser(editorA) });
      expect(r.statusCode, r.body).toBe(200);
    });

    it("a publisher and a company admin may preview too (the same `update` action; no new Cerbos action or kind)", async () => {
      for (const who of [publisherA, adminA]) {
        const r = await preview(who, item.itemId);
        expect(r.statusCode, `${who}: ${r.body}`).toBe(200);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the control call: the editorial assertion bound to THIS command, an Idempotency-Key, two ledger rows", () => {
    it("sends content.previewToken as the caller: POST …/items/:id/preview-token, assertion signed for it, a fresh Idempotency-Key", async () => {
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(200);
      const [mint] = mints();
      expect(mint).toMatchObject({
        command: "content.previewToken",
        method: "POST",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items/:itemId/preview-token",
        params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, itemId: item.itemId },
        body: {},
      });
      expect(mint.editorialAssertion).toBeTruthy();
      expect(mint.hadWs4).toBe(false); // MEDIUM: no WS4 approval
      expect(mint.idempotencyKey).toMatch(/^[\x21-\x7e]{8,200}$/);
      // the fake decoded the assertion and re-derived `cmh` from the request as received: a mis-bound one would be 403
      expect(signer.calls).toHaveLength(1);
      expect(signer.calls[0]).toMatchObject({ sub: editorA, pk: "human", ten: GAIADA_SLUG, site: GAIADA_SITE, cmd: "content.previewToken" });
      expect(signer.calls[0]).not.toHaveProperty("apr");
    });

    it("the caller's Idempotency-Key is forwarded as given; a second mint under the SAME key is Zone B's typed 409 (the token is never stored), a NEW key mints again", async () => {
      const first = await preview(editorA, item.itemId, {}, { "idempotency-key": "preview-key-0001" });
      expect(first.statusCode).toBe(200);
      expect(mints()[0].idempotencyKey).toBe("preview-key-0001");
      const replay = await preview(editorA, item.itemId, {}, { "idempotency-key": "preview-key-0001" });
      expect(replay.statusCode).toBe(409);
      expect(replay.headers["content-type"]).toContain("application/problem+json");
      expect(replay.json().type).toContain("/idempotency-response-withheld");
      const again = await preview(editorA, item.itemId, {}, { "idempotency-key": "preview-key-0002" });
      expect(again.statusCode).toBe(200);
      expect(zb.mintedPreviewTokens).toHaveLength(2);
      expect(zb.mintedPreviewTokens[0]).not.toBe(zb.mintedPreviewTokens[1]);
    });

    it("a malformed Idempotency-Key is 400 and nothing is minted", async () => {
      const r = await preview(editorA, item.itemId, {}, { "idempotency-key": "short" });
      expect(r.statusCode).toBe(400);
      expect(mints()).toHaveLength(0);
    });

    it("writes the two-row ledger (attempted, succeeded) with identifiers only: verb webdesk.content.previewToken, actor = the editor", async () => {
      await preview(editorA, item.itemId);
      const rows = await ledger("webdesk.content.previewToken");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
      expect(rows[0].actor_id).toBe(editorA);
      expect(rows[1].metadata).toMatchObject({ command: "content.previewToken", status: 201, itemId: item.itemId, collectionKey: "service", locale: "en", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("authorize() is the FIRST statement: a preview discloses a draft, so it is the item's `update`", () => {
    it("a reader (member) is 403 with a VALID body, and NOTHING reaches Zone B or the site; the editor is allowed with the identical body", async () => {
      const denied = await preview(memberA, item.itemId, {});
      expect(denied.statusCode).toBe(403);
      expect(zb.calls, "no Zone B egress at all (not even the wall)").toHaveLength(0);
      expect(heads, "no probe of the site").toHaveLength(0);
      expect(await ledger("webdesk.content.previewToken")).toHaveLength(0);
      const allowed = await preview(editorA, item.itemId, {});
      expect(allowed.statusCode, allowed.body).toBe(200);
    });

    it("🔴 it asks Cerbos for `update` on `webdesk_content_item` (module webdev), first generically and then with the item's REAL collectionKey/locale from Zone B; never `read`, never a new action", async () => {
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode, r.body).toBe(200);
      const asks = authCalls.filter((c) => c.resource.kind === "webdesk_content_item");
      expect(asks.map((c) => c.action)).toEqual(["update", "update"]);
      expect(asks[0].resource).toMatchObject({ kind: "webdesk_content_item", tenantId: A, module: "webdev" });
      expect(asks[0].resource).not.toHaveProperty("collectionKey"); // the generic first check carries no attributes
      expect(asks[1].resource).toMatchObject({ kind: "webdesk_content_item", tenantId: A, module: "webdev", id: item.itemId, collectionKey: "service", locale: "en" });
      // and the gate is the FIRST thing that happens: it precedes every Zone B call
      expect(authCalls[0].action).toBe("update");
    });

    it("a denied caller is refused at the FIRST gate: exactly one Cerbos question, and it is `update`", async () => {
      expect((await preview(memberA, item.itemId)).statusCode).toBe(403);
      expect(authCalls.map((c) => `${c.resource.kind}:${c.action}`)).toEqual(["webdesk_content_item:update"]);
    });

    it("authorize precedes validation: a denied caller with an INVALID body is still 403, an authorized one is 400", async () => {
      expect((await preview(memberA, item.itemId, { nonsense: true })).statusCode).toBe(403);
      expect((await preview(editorA, item.itemId, { nonsense: true })).statusCode).toBe(400);
      expect((await preview(memberA, item.itemId, { version: "x" })).statusCode).toBe(403);
      for (const bad of [{ version: 0 }, { version: 1.5 }, { version: "2" }, { version: -1 }, { ttlSeconds: 60 }]) {
        expect((await preview(editorA, item.itemId, bad)).statusCode, JSON.stringify(bad)).toBe(400);
      }
      expect(mints()).toHaveLength(0);
      expect(heads).toHaveLength(0);
    });

    it("requires authentication (401) and the webdev module on the company (404)", async () => {
      expect((await app.inject({ method: "POST", url: `${site()}/items/${item.itemId}/preview`, payload: {} })).statusCode).toBe(401);
      const noModule = await createCompany("WSK-46 No Webdev", ["pm"]);
      const u = await createUser("wsk46-nomod@ex.test");
      await addMembership(noModule, u);
      const r = await call("POST", `${site(noModule)}/items/${item.itemId}/preview`, u, {});
      expect(r.statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the cross-company wall: company A's user can never mint a preview for company B's site", () => {
    it("🔴 admin of A addressing B's tenant+site through A's own path: 404 site-not-found, no egress that names B's site, no HEAD, no mint", async () => {
      const r = await preview(adminA, randomUUID(), {}, {}, site(A, OTHER_SLUG, OTHER_SITE));
      expect(r.statusCode).toBe(404);
      expect(r.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/site-not-found", status: 404 });
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(zb.calls.filter((c) => c.params.siteId === OTHER_SITE)).toHaveLength(0);
      expect(mints()).toHaveLength(0);
      expect(heads).toHaveLength(0);
    });

    it("a real tenant slug with ANOTHER tenant's site id, and an unknown site: the same 404", async () => {
      for (const [slug, sid] of [[GAIADA_SLUG, OTHER_SITE], [OTHER_SLUG, GAIADA_SITE], [GAIADA_SLUG, randomUUID()]]) {
        const r = await preview(adminA, item.itemId, {}, {}, site(A, slug, sid));
        expect(r.statusCode, `${slug}/${sid}`).toBe(404);
      }
      expect(mints()).toHaveLength(0);
    });

    it("POSITIVE CONTROL: the identical request against A's OWN site succeeds; B's admin is refused A's company path (403) and A's site on B's (404)", async () => {
      expect((await preview(adminA, item.itemId)).statusCode).toBe(200);
      expect((await preview(adminB, item.itemId, {}, {}, site(A))).statusCode).toBe(403);
      expect((await preview(adminB, item.itemId, {}, {}, site(B, GAIADA_SLUG, GAIADA_SITE))).statusCode).toBe(404);
    });

    it("another SITE's item id under the right site is Zone B's 404 item-not-found, and mints nothing", async () => {
      const foreign = zb.seedItem({ siteId: OTHER_SITE, slug: "other.page" });
      const r = await preview(adminA, foreign.itemId);
      expect(r.statusCode).toBe(404);
      expect(r.json().type).toContain("/item-not-found");
      expect(mints()).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("honest states: never a dead link. Each of these mints NOTHING", () => {
    it("preview_not_configured: the site has no staging address -> 409, plain words, no HEAD, no mint, and no Zone B call beyond the wall", async () => {
      zb.stagingDomain = null;
      webdeskZoneB.clearSiteCache();
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: "Preview isn't set up for this site yet", reason: "preview_not_configured" });
      expect(heads).toHaveLength(0);
      expect(zb.calls.map((c) => c.command)).toEqual(["tenant.list"]);
      expect(zb.writes).toHaveLength(0);
      expect(await ledger("webdesk.content.previewToken")).toHaveLength(0); // nothing was attempted
    });

    it("a staging domain that is not a bare public hostname is NOT a place the server will call: preview_not_configured, no HEAD", async () => {
      for (const bad of ["localhost", "127.0.0.1", "10.0.0.5:8080", "staging.gaiada.test/x", "http://staging.gaiada.test", "user@staging.gaiada.test", "staging gaiada.test", ""]) {
        zb.stagingDomain = bad;
        webdeskZoneB.clearSiteCache();
        const r = await preview(editorA, item.itemId);
        expect(r.statusCode, JSON.stringify(bad)).toBe(409);
        expect(r.json().reason, JSON.stringify(bad)).toBe("preview_not_configured");
      }
      expect(heads).toHaveLength(0);
      expect(mints()).toHaveLength(0);
    });

    it("🔴 preview_page_missing: the site's /preview/ answers 404 -> 409, plain words, and NO control call is made (not even the item read)", async () => {
      // This is the honest live state today: gaiada.com's staging site has no /preview/ page until the site owner builds it.
      headAnswer = 404;
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toEqual({ error: "This site doesn't have a preview page yet", reason: "preview_page_missing" });
      expect(heads).toHaveLength(1);
      expect(mints()).toHaveLength(0);
      expect(zb.writes).toHaveLength(0);
      expect(zb.calls.map((c) => c.command)).toEqual(["tenant.list"]); // only the wall's own lookup
      expect(signer.calls).toHaveLength(0); // nothing was signed
      expect(await ledger("webdesk.content.previewToken")).toHaveLength(0);
      expect(zb.mintedPreviewTokens).toHaveLength(0);
    });

    it("a 410 is missing too; any other 4xx (401/403/405: auth or HEAD refused) is NOT a 404, so the page is assumed present", async () => {
      headAnswer = 410;
      expect((await preview(editorA, item.itemId)).statusCode).toBe(409);
      for (const s of [401, 403, 405]) {
        setPreviewProbeForTests({ fetchImpl: headStub, now: () => clock }); // drop the cache
        headAnswer = s;
        const r = await preview(editorA, item.itemId);
        expect(r.statusCode, `HEAD ${s}: ${r.body}`).toBe(200);
      }
      // a redirect (the page's own trailing-slash or www rule) is a page that resolves
      setPreviewProbeForTests({ fetchImpl: headStub, now: () => clock });
      headAnswer = 301;
      expect((await preview(editorA, item.itemId)).statusCode).toBe(200);
    });

    it("preview_site_unreachable: a 5xx, a timeout or no answer from the site is 502 and mints nothing (a link may open onto an error page); NOT cached", async () => {
      headAnswer = 503;
      const down = await preview(editorA, item.itemId);
      expect(down.statusCode).toBe(502);
      expect(down.json()).toMatchObject({ reason: "preview_site_unreachable" });
      headAnswer = new Error("ECONNRESET");
      expect((await preview(editorA, item.itemId)).json()).toMatchObject({ reason: "preview_site_unreachable" });
      expect(mints()).toHaveLength(0);
      expect(heads).toHaveLength(2); // an unknown answer is asked again, never remembered
      headAnswer = 200; // the site recovers: the very next click works
      expect((await preview(editorA, item.itemId)).statusCode).toBe(200);
      expect(heads).toHaveLength(3);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the page-exists check is cached for 5 minutes (a definite answer only)", () => {
    it("a present page is asked once per 5 minutes per site, then asked again", async () => {
      await preview(editorA, item.itemId);
      await preview(editorA, item.itemId);
      clock += 4 * 60_000 + 59_000;
      await preview(editorA, item.itemId);
      expect(heads).toHaveLength(1);
      clock += 2_000; // 5 min 1 s after the first answer
      await preview(editorA, item.itemId);
      expect(heads).toHaveLength(2);
    });

    it("a MISSING page is remembered for 5 minutes (no hammering the site), and once the site owner builds the page the next ask after the TTL works", async () => {
      headAnswer = 404;
      expect((await preview(editorA, item.itemId)).json().reason).toBe("preview_page_missing");
      headAnswer = 200; // the page is built...
      expect((await preview(editorA, item.itemId)).json().reason).toBe("preview_page_missing"); // ...but the answer is cached
      expect(heads).toHaveLength(1);
      clock += 5 * 60_000 + 1;
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode, r.body).toBe(200);
      expect(heads).toHaveLength(2);
    });

    it("the cache is per site origin: another staging domain is probed on its own", async () => {
      await preview(editorA, item.itemId);
      zb.stagingDomain = "staging.other-site.test";
      webdeskZoneB.clearSiteCache();
      await preview(editorA, item.itemId);
      expect(heads.map((h) => h.url)).toEqual([`${STAGING}/preview/`, "https://staging.other-site.test/preview/"]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("WebDesk refusals map exactly as the other writes map them", () => {
    it("409 item-deleted: nothing is minted (the item read shows it), as a typed problem", async () => {
      item.deletedAt = new Date().toISOString();
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(409);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(r.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/item-deleted", status: 409 });
      expect(mints()).toHaveLength(0);
    });

    it("Zone B's own 409 item-deleted on the mint (a delete that raced) passes through untouched, and the ledger records a REFUSAL", async () => {
      zb.nextWriteResponse = problem(409, "item-deleted", { detail: "This item has been deleted." });
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/item-deleted", detail: "This item has been deleted." });
      const rows = await ledger("webdesk.content.previewToken");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "refused"]);
      expect(rows[1].metadata).toMatchObject({ status: 409, problem: "item-deleted" });
    });

    it("version-not-found: an unknown version is a typed 404 and mints nothing; Zone B's own 409 version-not-found on the mint passes through", async () => {
      const r = await preview(editorA, item.itemId, { version: 9 });
      expect(r.statusCode).toBe(404);
      expect(r.json().type).toContain("/version-not-found");
      expect(mints()).toHaveLength(0);
      zb.nextWriteResponse = problem(409, "version-not-found", { detail: "Version 1 does not exist for this item." });
      const raced = await preview(editorA, item.itemId, { version: 1 });
      expect(raced.statusCode).toBe(409);
      expect(raced.json().type).toContain("/version-not-found");
    });

    it("404 item-not-found: an unknown item id", async () => {
      const r = await preview(editorA, randomUUID());
      expect(r.statusCode).toBe(404);
      expect(r.json().type).toContain("/item-not-found");
      expect(mints()).toHaveLength(0);
    });

    it("breaker open: 503 editorial_unavailable (circuit_open); webdesk unreachable: 503 webdesk_unreachable; nothing minted", async () => {
      zb.failWith = new EditorialUnavailableError(25_000);
      webdeskZoneB.clearSiteCache();
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
      expect(zb.mintedPreviewTokens).toHaveLength(0);
    });

    it("breaker open exactly on the mint: attempted + failed on the ledger, 503 editorial_unavailable", async () => {
      const flaky = {
        send: async (req: Parameters<FakeZoneB["send"]>[0]) => {
          if (req.command === "content.previewToken") throw new EditorialUnavailableError(10_000);
          return zb.send(req);
        },
        close: () => undefined,
      };
      setWebdeskApprovedCommandDepsForTests({ client: flaky as never, signer });
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
      const rows = await ledger("webdesk.content.previewToken");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "failed"]);
    });

    it("no editorial signer: 503 webdesk_not_configured BEFORE any ledger row or mint", async () => {
      setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer: NOT_CONFIGURED_EDITORIAL_SIGNER });
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: "webdesk_not_configured", reason: "editorial_signer_not_configured" });
      expect(mints()).toHaveLength(0);
      expect(await ledger("webdesk.content.previewToken")).toHaveLength(0);
    });

    it("no control channel configured: 503 webdesk_not_configured (control_channel_not_configured)", async () => {
      setWebdeskApprovedCommandDepsForTests(null);
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: "webdesk_not_configured", reason: "control_channel_not_configured" });
    });

    it("an AMBIGUOUS mint (the link died after the request was written): 502 webdesk_ambiguous, never success, never resent; the ledger says `ambiguous`", async () => {
      zb.dropAfterApply = true;
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_ambiguous", reason: "not_observed" });
      expect(mints()).toHaveLength(1); // sent once, never resent
      const rows = await ledger("webdesk.content.previewToken");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "ambiguous"]);
      // the unobserved token is NOT in the answer, or anywhere else
      for (const t of zb.mintedPreviewTokens) expect(r.body).not.toContain(t);
    });

    it("a 2xx answer without a token is 502 webdesk_error (preview_shape), and the answer says nothing of its body", async () => {
      zb.nextWriteResponse = { status: 201, contentType: "application/json", json: { tokenId: randomUUID(), expiresAt: new Date().toISOString(), version: 1 }, bodyText: "{}" };
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_error", reason: "preview_shape" });
    });

    it("401/403 from Zone B are OUR credentials being refused: 502 webdesk_refused, never forwarded as the user's own", async () => {
      zb.nextWriteResponse = problem(403, "editorial-assertion-command-mismatch");
      const r = await preview(editorA, item.itemId);
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_refused", reason: "editorial-assertion-command-mismatch" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("🔴 the token is a one-time secret: it is in the response URL's fragment and NOWHERE else", () => {
    it("absent from every log line (Nest Logger, console, stdout/stderr) and every ledger row, on success and on failure paths", async () => {
      const seen: string[] = [];
      const grab = (...a: unknown[]) => { seen.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
      for (const m of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) vi.spyOn(Logger.prototype, m).mockImplementation(grab as never);
      for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(grab as never);
      const out = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { seen.push(String(c)); return true; }) as never);
      const err = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => { seen.push(String(c)); return true; }) as never);

      const ok = await preview(editorA, item.itemId);
      zb.dropAfterApply = true;
      const ambiguous = await preview(editorA, item.itemId);
      zb.nextWriteResponse = problem(409, "item-deleted");
      const refused = await preview(editorA, item.itemId);
      zb.nextWriteResponse = problem(403, "editorial-assertion-command-mismatch");
      const faulted = await preview(editorA, item.itemId);
      out.mockRestore(); err.mockRestore();

      expect([ok.statusCode, ambiguous.statusCode, refused.statusCode, faulted.statusCode]).toEqual([200, 502, 409, 502]);
      expect(zb.mintedPreviewTokens.length).toBeGreaterThanOrEqual(2);
      const everything = seen.join("\n");
      const ledgerJson = JSON.stringify(await ledger());
      for (const t of zb.mintedPreviewTokens) {
        expect(everything, "a log line carries a preview token").not.toContain(t);
        expect(ledgerJson, "a ledger row carries a preview token").not.toContain(t);
        // only the ONE answer that is supposed to carry it does
        for (const r of [ambiguous, refused, faulted]) expect(r.body).not.toContain(t);
      }
      expect(ok.body).toContain(zb.mintedPreviewTokens[0]);
    });

    it("the token is not in any stored row: the whole activities table for the company holds none of the tokens", async () => {
      await preview(editorA, item.itemId);
      const { rows } = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM activities WHERE tenant_id = $1 AND metadata::text LIKE '%' || $2 || '%'`,
        [A, zb.mintedPreviewTokens[0]],
      );
      expect(rows[0].n).toBe("0");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the MCP tool webdesk.content.preview: the SAME route, MEDIUM impact", () => {
    const def = () => webdevModule.mcpTools.find((t) => t.name === "webdesk.content.preview");

    it("is declared as a MEDIUM write on POST …/items/:itemId/preview, beside the other WSK-59 content tools", () => {
      const d = def();
      expect(d).toBeDefined();
      expect(d).toMatchObject({
        write: true,
        impact: "medium",
        method: "POST",
        minAssurance: "low",
        pathTemplate: "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/items/:itemId/preview",
      });
      const schema = d!.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(schema.properties).sort()).toEqual(["itemId", "siteId", "tenantId", "tenantSlug", "version"]);
      expect(schema.required).toEqual(["tenantId", "tenantSlug", "siteId", "itemId"]); // version is optional (head by default)
      // the content tools it joins: 7 reads + 4 low writes + 2 medium writes (unpublish, delete) + this medium write
      const content = webdevModule.mcpTools.filter((t) => t.name.startsWith("webdesk.content."));
      expect(content).toHaveLength(14);
      expect(content.filter((t) => t.write && t.impact === "medium").map((t) => t.name).sort()).toEqual([
        "webdesk.content.delete", "webdesk.content.preview", "webdesk.content.unpublish",
      ]);
    });

    it("calling it the way the hub does (path args consumed, the rest is the JSON body) reaches the SAME handler: same URL shape, ledger row, mint", async () => {
      const d = def()!;
      const args: Record<string, unknown> = { tenantId: A, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, itemId: item.itemId, version: 1 };
      const used = new Set<string>();
      const path = d.pathTemplate!.replace(/:([A-Za-z0-9_]+)/g, (_m, p: string) => { used.add(p); return encodeURIComponent(String(args[p])); });
      const rest = Object.fromEntries(Object.entries(args).filter(([k]) => !used.has(k)));
      expect(path).toBe(`${site()}/items/${item.itemId}/preview`);
      const r = await app.inject({ method: "POST", url: path, headers: { ...asUser(editorA), "content-type": "application/json" }, payload: JSON.stringify(rest) });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().previewUrl).toBe(`${STAGING}/preview/#t=${zb.mintedPreviewTokens[0]}`);
      expect(mints()[0].body).toEqual({ version: 1 });
      expect((await ledger("webdesk.content.previewToken")).map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
    });
  });
});
