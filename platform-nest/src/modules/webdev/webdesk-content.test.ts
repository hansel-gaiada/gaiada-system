// WSK-59 — the content BFF (`/api/:tenantId/modules/webdev/content/*`) and the three re-pointed control routes.
//
// Real: Postgres (RLS, the activities ledger, the approval rows), Cerbos (the real WSK-47 policies), the full
// NestJS app (`buildApp()`), the real `WebdeskContentService`/`WebdeskZoneB`, WSK-66's real
// `fileWebdeskCommandApproval`. Stand-in: Zone B, as an in-process fake that is strict where Zone B is
// (`webdesk-content-testkit.ts` decodes the editorial assertion and checks `cmd`/`ten`/`site`/`cmh`/`apr`).
//
// Done-when map (design §12 WSK-59):
//   1 every tool has a golden case          → "golden cases"
//   2 cross-company wall + positive control  → "the cross-company wall"
//   3 denials send VALID bodies, each paired with an allowed control → "authorization"
//   4 breaker open → 503 editorial_unavailable on reads AND writes   → "degraded"
//   5 typed 409/422 pass through untouched   → "typed problems pass through"
//   8 publish-requests files exactly one approval, never calls Zone B publish → "publish-requests"
//   (7, the agent + D14 re-drive, is webdesk-content-d14.test.ts; 6 is the BFF §27.)
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { EditorialUnavailableError, WebdeskControlClient, WebdeskControlTransportError } from "./webdesk-control-client";
import { setWebdeskApprovedCommandDepsForTests, NOT_CONFIGURED_EDITORIAL_SIGNER } from "./webdesk-approved-command";
import { WebdeskProblem, setStagingStaleMarkerForTests, webdeskZoneB } from "./webdesk-content.service";
import { webdevModule } from "./index";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, problem, type FakeItem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!live)("WSK-59 · the content BFF", () => {
  let app: NestFastifyApplication;
  let A: string; // company A: owns the `gaiada` tenant
  let B: string; // company B: owns the `othertenant` tenant
  let adminA: string, editorA: string, publisherA: string, memberA: string, adminB: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const base = (co = A) => `/api/${co}/modules/webdev/content`;
  const site = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${base(co)}/sites/${slug}/${siteId}`;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, as: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...asUser(as), ...headers }, payload: payload as never });

  async function ledger(verbLike = "webdesk.%") {
    const { rows } = await adminPool().query<{ verb: string; actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT verb, actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb LIKE $2 ORDER BY occurred_at, id`,
      [A, verbLike],
    );
    return rows;
  }
  const clearLedger = () => adminPool().query(`DELETE FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A]);

  let item: FakeItem; // a DRAFT service page in A's site
  let live1: FakeItem; // a LIVE (published v1) service page

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-59 Co A", ["webdev"]);
    B = await createCompany("WSK-59 Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "wsk59-admin-a@ex.test", "company_admin");
    editorA = await mk(A, "wsk59-editor-a@ex.test", "webdev_staff");
    publisherA = await mk(A, "wsk59-publisher-a@ex.test", "webdev_manager");
    memberA = await mk(A, "wsk59-member-a@ex.test", "member");
    adminB = await mk(B, "wsk59-admin-b@ex.test", "company_admin");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    item = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.seo" });
    live1 = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.live", publishedVersion: 1, publishState: "published" });
    await clearLedger();
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("golden cases: every tool has one (reads)", () => {
    it("webdesk.content.listSites → GET …/content/sites: only THIS company's tenants, asked of Zone B by company id", async () => {
      const r = await call("GET", `${base()}/sites`, editorA);
      expect(r.statusCode).toBe(200);
      const tenants = r.json().tenants as Array<{ slug: string; sites: Array<{ siteId: string }> }>;
      expect(tenants.map((t) => t.slug)).toEqual([GAIADA_SLUG]);
      expect(tenants[0].sites[0].siteId).toBe(GAIADA_SITE);
      expect(zb.calls[0]).toMatchObject({ command: "tenant.list", query: { companyRef: A } });
      // reads write nothing: no ledger rows
      expect(await ledger()).toHaveLength(0);
    });

    it("webdesk.content.listCollections → …/collections", async () => {
      const r = await call("GET", `${site()}/collections`, editorA);
      expect(r.statusCode).toBe(200);
      expect(r.json().collections[0]).toMatchObject({ key: "service", vocabularyVersion: "1.1.0" });
    });

    it("webdesk.content.listItems → …/collections/:key/items, forwarding ONLY allow-listed query keys", async () => {
      const r = await call("GET", `${site()}/collections/service/items?locale=en&state=draft&limit=20`, editorA);
      expect(r.statusCode).toBe(200);
      expect(r.json().items.map((i: { slug: string }) => i.slug)).toContain("service.seo");
      const sent = zb.calls.find((c) => c.command === "item.list")!;
      expect(sent.query).toEqual({ locale: "en", state: "draft", limit: "20" });
      expect(sent.params).toMatchObject({ tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, key: "service" });
      // an unknown key is refused, never forwarded
      const bad = await call("GET", `${site()}/collections/service/items?tenantSlug=othertenant`, editorA);
      expect(bad.statusCode).toBe(400);
      expect(zb.calls.filter((c) => c.command === "item.list")).toHaveLength(1);
    });

    it("webdesk.content.getItem → …/items/:id[?version=]", async () => {
      const head = await call("GET", `${site()}/items/${item.itemId}`, editorA);
      expect(head.statusCode).toBe(200);
      expect(head.json()).toMatchObject({ item: { itemId: item.itemId, headVersion: 1 }, version: { n: 1 } });
      const v = await call("GET", `${site()}/items/${live1.itemId}?version=live`, editorA);
      expect(v.statusCode).toBe(200);
      expect(zb.calls.at(-1)!.query).toEqual({ version: "live" });
    });

    it("webdesk.content.listVersions and getVersion → …/versions[/:n]", async () => {
      const list = await call("GET", `${site()}/items/${item.itemId}/versions`, editorA);
      expect(list.statusCode).toBe(200);
      expect(list.json().versions).toHaveLength(1);
      const one = await call("GET", `${site()}/items/${item.itemId}/versions/1`, editorA);
      expect(one.statusCode).toBe(200);
      expect(one.json()).toMatchObject({ n: 1 });
      expect((await call("GET", `${site()}/items/${item.itemId}/versions/9`, editorA)).statusCode).toBe(404);
    });

    it("webdesk.content.listMedia → …/media", async () => {
      const r = await call("GET", `${site()}/media?mime=image/*`, editorA);
      expect(r.statusCode).toBe(200);
      expect(r.json().assets[0]).toMatchObject({ mime: "image/png" });
      expect(zb.calls.at(-1)!.query).toEqual({ mime: "image/*" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("golden cases: every tool has one (writes), each with the two-row ledger and a correctly bound editorial assertion", () => {
    /** The signer was called with exactly the claims the design §5 gives a MEDIUM command: no `apr`, no `req`. */
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
      // identifiers and outcomes only: never content values
      expect(JSON.stringify(rows)).not.toContain("fields");
    }

    it("webdesk.content.create → POST …/collections/:key/items: 201, the editor is the `sub`, collection comes from the PATH", async () => {
      const r = await call("POST", `${site()}/collections/service/items`, editorA, {
        locale: "en", slug: "service.new", fields: { h1: "New" }, note: "first draft",
      }, { "idempotency-key": "idem-wsk59-create-1" });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ item: { slug: "service.new", collectionKey: "service", headVersion: 1 }, version: { version: 1 }, replayed: false });
      const w = zb.writes.at(-1)!;
      expect(w).toMatchObject({ command: "content.create", method: "POST", idempotencyKey: "idem-wsk59-create-1" });
      expect(w.body).toMatchObject({ collectionKey: "service", locale: "en", slug: "service.new" });
      expect(w.params).toEqual({ tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE });
      expectMediumClaims("content.create", editorA);
      await expectLedger("webdesk.content.create", editorA, "succeeded");
    });

    it("create without an Idempotency-Key generates one; a collectionKey in the body that differs from the path is a 400", async () => {
      const ok = await call("POST", `${site()}/collections/service/items`, editorA, { locale: "en", slug: "service.gen", fields: { h1: "x" } });
      expect(ok.statusCode).toBe(201);
      expect(zb.writes.at(-1)!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
      const mismatch = await call("POST", `${site()}/collections/service/items`, editorA, { collectionKey: "post", locale: "en", slug: "z" });
      expect(mismatch.statusCode).toBe(400);
      const missingCollection = await call("POST", `${site()}/collections/nope/items`, editorA, { locale: "en", slug: "z" });
      expect(missingCollection.statusCode).toBe(404);
      expect(missingCollection.headers["content-type"]).toContain("application/problem+json");
    });

    it("webdesk.content.update → PUT …/items/:id (and the PATCH alias the hub uses): a new draft version, 200", async () => {
      const put = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "v2" } });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ item: { headVersion: 2 }, version: { version: 2 }, replayed: false });
      expectMediumClaims("content.update", editorA);
      await expectLedger("webdesk.content.update", editorA, "succeeded");
      const patch = await call("PATCH", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 2, fields: { h1: "v3" } });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().item.headVersion).toBe(3);
      expect(zb.writes.at(-1)).toMatchObject({ command: "content.update", method: "PUT" });
    });

    it("webdesk.content.restoreVersion → POST …/items/:id/restore", async () => {
      await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "v2" } });
      const r = await call("POST", `${site()}/items/${item.itemId}/restore`, editorA, { version: 1, baseVersion: 2, note: "back" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ item: { headVersion: 3 } });
      expectMediumClaims("content.restoreVersion", editorA);
    });

    it("webdesk.content.unpublish → POST …/items/:id/unpublish (publisher): 200, takes it down, ledger rows", async () => {
      const r = await call("POST", `${site()}/items/${live1.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 });
      expect(r.statusCode).toBe(200);
      expect(r.json().item).toMatchObject({ publishState: "unpublished", publishedVersion: null });
      expectMediumClaims("content.unpublish", publisherA);
      await expectLedger("webdesk.content.unpublish", publisherA, "succeeded");
    });

    it("webdesk.content.delete → POST …/items/:id/delete (publisher): a non-live item is soft-deleted", async () => {
      const r = await call("POST", `${site()}/items/${item.itemId}/delete`, publisherA, { baseVersion: 1 });
      expect(r.statusCode).toBe(200);
      expect(r.json().item.deletedAt).toEqual(expect.any(String));
      expectMediumClaims("content.delete", publisherA);
      await expectLedger("webdesk.content.delete", publisherA, "succeeded");
    });

    it("webdesk.content.requestPublish → POST …/publish-requests: 202 {approvalId} (see the publish-requests suite)", async () => {
      const r = await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: item.itemId, version: 1 }] });
      expect(r.statusCode).toBe(202);
      expect(r.json().approvalId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the cross-company wall (resolveEditableSite): company A's user can never reach company B's site", () => {
    // Every one of the 12 routes, addressed at B's tenant/site through A's own (authorized) company path.
    const itemId = "11111111-1111-4111-8111-111111111111";
    const routes = (slug: string, sid: string, id: string, liveId = id): Array<[string, "GET" | "POST" | "PUT", string, unknown?]> => {
      const s = `/sites/${slug}/${sid}`;
      return [
        ["listCollections", "GET", `${s}/collections`],
        ["listItems", "GET", `${s}/collections/service/items`],
        ["getItem", "GET", `${s}/items/${id}`],
        ["listVersions", "GET", `${s}/items/${id}/versions`],
        ["getVersion", "GET", `${s}/items/${id}/versions/1`],
        ["listMedia", "GET", `${s}/media`],
        ["create", "POST", `${s}/collections/service/items`, { locale: "en", slug: "x", fields: { h1: "x" } }],
        ["update", "PUT", `${s}/items/${id}`, { baseVersion: 1, fields: { h1: "y" } }],
        ["restore", "POST", `${s}/items/${id}/restore`, { version: 1, baseVersion: 1 }],
        ["publish-requests", "POST", `${s}/publish-requests`, { items: [{ itemId: id, version: 1 }] }],
        ["publish-requests-list", "GET", `${s}/publish-requests`],
        ["unpublish", "POST", `${s}/items/${liveId}/unpublish`, { expectedPublishedVersion: 1 }],
        ["delete", "POST", `${s}/items/${id}/delete`, { baseVersion: 1 }],
      ];
    };

    it("🔴 admin of A, on A's own company path, addressing B's tenant+site: 404 on every route, and Zone B sees no call that names B's site", async () => {
      for (const [name, method, path, body] of routes(OTHER_SLUG, OTHER_SITE, itemId)) {
        const r = await call(method, `${base(A)}${path}`, adminA, body);
        expect(r.statusCode, name).toBe(404);
        expect(r.json(), name).toMatchObject({ type: "https://webdesk.gaiada.online/errors/site-not-found", status: 404 });
        expect(r.headers["content-type"], name).toContain("application/problem+json");
      }
      expect(zb.calls.filter((c) => c.params.siteId === OTHER_SITE)).toHaveLength(0);
      expect(zb.writes).toHaveLength(0);
    });

    it("a real tenant slug paired with ANOTHER tenant's site id, and an unknown site: the same 404", async () => {
      for (const [slug, sid] of [[GAIADA_SLUG, OTHER_SITE], [OTHER_SLUG, GAIADA_SITE], [GAIADA_SLUG, randomUUID()]]) {
        const r = await call("PUT", `${site(A, slug, sid)}/items/${item.itemId}`, adminA, { baseVersion: 1, fields: { h1: "z" } });
        expect(r.statusCode, `${slug}/${sid}`).toBe(404);
      }
      expect(zb.writes).toHaveLength(0);
    });

    it("POSITIVE CONTROL: the identical requests against A's OWN site are not 404 (the wall refuses only the foreign pair)", async () => {
      for (const [name, method, path, body] of routes(GAIADA_SLUG, GAIADA_SITE, item.itemId, live1.itemId)) {
        const r = await call(method, `${base(A)}${path}`, adminA, name === "restore" ? { version: 1, baseVersion: 2 } : body);
        expect([200, 201, 202], `${name}: ${r.body}`).toContain(r.statusCode);
      }
    });

    it("admin of B reaches B's site (the wall is per company, not a block on the tenant), and is refused A's", async () => {
      const own = await call("GET", `${site(B, OTHER_SLUG, OTHER_SITE)}/collections`, adminB);
      expect(own.statusCode).toBe(200);
      const foreign = await call("GET", `${site(B, GAIADA_SLUG, GAIADA_SITE)}/collections`, adminB);
      expect(foreign.statusCode).toBe(404);
      // and B's admin cannot use A's company path at all: not a member, so Cerbos denies before any lookup
      const viaA = await call("GET", `${site(A)}/collections`, adminB);
      expect(viaA.statusCode).toBe(403);
    });

    it("an ARCHIVED tenant is not editable: 404", async () => {
      zb.tenants[0].status = "archived";
      webdeskZoneB.clearSiteCache();
      try {
        expect((await call("GET", `${site()}/collections`, adminA)).statusCode).toBe(404);
      } finally {
        zb.tenants[0].status = "active";
      }
    });

    it("the wall's answer is cached 60 s per company (one tenant.list for many calls) and a miss on a brand-new cache does not refetch", async () => {
      await call("GET", `${site()}/collections`, adminA);
      await call("GET", `${site()}/media`, adminA);
      await call("GET", `${site(A, OTHER_SLUG, OTHER_SITE)}/media`, adminA); // a miss on a FRESH cache: no refetch storm
      expect(zb.calls.filter((c) => c.command === "tenant.list")).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("authorization: authorize() is FIRST, denials send VALID bodies, each paired with an allowed control", () => {
    type Case = { name: string; method: "GET" | "POST" | "PUT"; path: () => string; body?: () => unknown; allowed: () => string; denied: () => string[] };
    const cases: Case[] = [
      { name: "read", method: "GET", path: () => `${site()}/items/${item.itemId}`, allowed: () => editorA, denied: () => [memberA] },
      { name: "listSites", method: "GET", path: () => `${base()}/sites`, allowed: () => editorA, denied: () => [memberA] },
      { name: "create", method: "POST", path: () => `${site()}/collections/service/items`, body: () => ({ locale: "en", slug: "authz.new", fields: { h1: "a" } }), allowed: () => editorA, denied: () => [memberA] },
      { name: "update", method: "PUT", path: () => `${site()}/items/${item.itemId}`, body: () => ({ baseVersion: 1, fields: { h1: "b" } }), allowed: () => editorA, denied: () => [memberA] },
      { name: "restore", method: "POST", path: () => `${site()}/items/${item.itemId}/restore`, body: () => ({ version: 1, baseVersion: 1 }), allowed: () => editorA, denied: () => [memberA] },
      { name: "publish-requests", method: "POST", path: () => `${site()}/publish-requests`, body: () => ({ items: [{ itemId: item.itemId, version: 1 }] }), allowed: () => editorA, denied: () => [memberA] },
      { name: "publish-requests-list", method: "GET", path: () => `${site()}/publish-requests`, allowed: () => editorA, denied: () => [memberA] },
      // unpublish / delete are the PUBLISHER tier: the editor is denied, the publisher (and admin) allowed
      { name: "unpublish", method: "POST", path: () => `${site()}/items/${live1.itemId}/unpublish`, body: () => ({ expectedPublishedVersion: 1 }), allowed: () => publisherA, denied: () => [editorA, memberA] },
      { name: "delete", method: "POST", path: () => `${site()}/items/${item.itemId}/delete`, body: () => ({ baseVersion: 1 }), allowed: () => publisherA, denied: () => [editorA, memberA] },
    ];

    for (const c of cases) {
      it(`${c.name}: denied principals get 403 with a VALID body and NOTHING reaches Zone B; the allowed principal succeeds with the identical body`, async () => {
        for (const who of c.denied()) {
          zb.calls.length = 0;
          const r = await call(c.method, `${c.path()}`, who, c.body?.());
          expect(r.statusCode, `${c.name} as ${who}`).toBe(403);
          expect(zb.calls, `${c.name} as ${who}: no egress at all`).toHaveLength(0);
          expect(await ledger(`webdesk.content.${c.name}`)).toHaveLength(0);
        }
        const r = await call(c.method, `${c.path()}`, c.allowed(), c.body?.());
        expect([200, 201, 202], `${c.name}: ${r.body}`).toContain(r.statusCode);
      });
    }

    it("authorize precedes validation: a denied caller with an INVALID body is still 403, an authorized one is 400", async () => {
      const url = `${site()}/items/${item.itemId}`;
      expect((await call("PUT", url, memberA, { nonsense: true })).statusCode).toBe(403);
      expect((await call("PUT", url, editorA, { nonsense: true })).statusCode).toBe(400);
      expect((await call("POST", `${site()}/publish-requests`, memberA, { items: "nope" })).statusCode).toBe(403);
      expect((await call("POST", `${site()}/publish-requests`, editorA, { items: "nope" })).statusCode).toBe(400);
      expect(zb.writes).toHaveLength(0);
    });

    it("requires authentication (401) and the webdev module on the company (404)", async () => {
      expect((await app.inject({ method: "GET", url: `${base()}/sites` })).statusCode).toBe(401);
      const noModule = await createCompany("WSK-59 No Webdev", ["pm"]);
      const u = await createUser("wsk59-nomod@ex.test");
      await addMembership(noModule, u);
      expect((await call("GET", `/api/${noModule}/modules/webdev/content/sites`, u)).statusCode).toBe(404);
    });

    it("an editor cannot reach an item's action through a stale body: attributes come from Zone B (the item's real collection/locale), and delete of a live item is Zone B's typed 409", async () => {
      const r = await call("POST", `${site()}/items/${live1.itemId}/delete`, publisherA, { baseVersion: 1 });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ type: expect.stringContaining("/item-is-live") });
      // Zone B was asked to read the item first (the attribute source) and then to delete it
      const cmds = zb.calls.map((c) => c.command);
      expect(cmds.indexOf("item.get")).toBeLessThan(cmds.indexOf("content.delete"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("typed problems pass through UNTOUCHED (status, content type, every member)", () => {
    it("409 version-conflict keeps currentHeadVersion/currentContentHash and application/problem+json", async () => {
      await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "v2" } });
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "stale" } });
      expect(r.statusCode).toBe(409);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      const body = r.json();
      expect(body).toMatchObject({ type: "https://webdesk.gaiada.online/errors/version-conflict", status: 409, currentHeadVersion: 2 });
      expect(body.currentContentHash).toMatch(/^[0-9a-f]{64}$/);
      // the ledger records a REFUSAL with the problem slug, not a failure
      const rows = await ledger("webdesk.content.update");
      expect(rows.at(-1)!.metadata).toMatchObject({ outcome: "refused", status: 409, problem: "version-conflict" });
    });

    it("422 composition-violation keeps its `issues` array exactly", async () => {
      const r = await call("POST", `${site()}/collections/service/items`, editorA, { locale: "en", slug: "bad", fields: { h1: 42 } });
      expect(r.statusCode).toBe(422);
      expect(r.json()).toEqual({
        type: "https://webdesk.gaiada.online/errors/composition-violation",
        title: "composition-violation",
        status: 422,
        issues: [{ path: "/blocks/0/props/h1", message: "must be a string", expected: "text" }],
      });
    });

    it("409 slug-taken, 409 not-live and 404 item-not-found pass through too", async () => {
      expect((await call("POST", `${site()}/collections/service/items`, editorA, { locale: "en", slug: "service.seo", fields: {} })).statusCode).toBe(409);
      expect((await call("POST", `${site()}/items/${item.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 })).json().type).toContain("/not-live");
      const missing = await call("PUT", `${site()}/items/${randomUUID()}`, editorA, { baseVersion: 1, fields: {} });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().type).toContain("/item-not-found");
    });

    it("Zone B's 401/403 (OUR credentials or signing refused) are NEVER forwarded: a 502 webdesk_refused, so the UI cannot read it as a session expiry", async () => {
      zb.nextWriteResponse = problem(401, "editorial-assertion-invalid-signature");
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "q" } });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_refused", reason: "editorial-assertion-invalid-signature" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("degraded: breaker open → 503 editorial_unavailable on reads AND writes; unconfigured → 503 webdesk_not_configured", () => {
    const reads = (): Array<[string, string]> => [
      ["listSites", `${base()}/sites`],
      ["listCollections", `${site()}/collections`],
      ["listItems", `${site()}/collections/service/items`],
      ["getItem", `${site()}/items/${item.itemId}`],
      ["listVersions", `${site()}/items/${item.itemId}/versions`],
      ["getVersion", `${site()}/items/${item.itemId}/versions/1`],
      ["listMedia", `${site()}/media`],
    ];
    const writes = (): Array<[string, "POST" | "PUT", string, unknown]> => [
      ["create", "POST", `${site()}/collections/service/items`, { locale: "en", slug: "d1", fields: {} }],
      ["update", "PUT", `${site()}/items/${item.itemId}`, { baseVersion: 1, fields: {} }],
      ["restore", "POST", `${site()}/items/${item.itemId}/restore`, { version: 1, baseVersion: 1 }],
      ["unpublish", "POST", `${site()}/items/${live1.itemId}/unpublish`, { expectedPublishedVersion: 1 }],
      ["delete", "POST", `${site()}/items/${item.itemId}/delete`, { baseVersion: 1 }],
    ];

    it("🔴 breaker open: every READ is a typed 503 — never an empty list", async () => {
      // a healthy read first, so the wall cache is warm and the failure is on the content call itself
      expect((await call("GET", `${site()}/collections`, adminA)).statusCode).toBe(200);
      zb.failWith = new EditorialUnavailableError(25_000);
      webdeskZoneB.clearSiteCache(); // the wall's own lookup also fails: still 503, not 404
      for (const [name, url] of reads()) {
        const r = await call("GET", url, adminA);
        expect(r.statusCode, name).toBe(503);
        expect(r.json(), name).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
        expect(r.json(), name).not.toHaveProperty("items");
        expect(r.json(), name).not.toHaveProperty("collections");
      }
    });

    it("🔴 breaker open: every WRITE is a typed 503 too (wall cold), and nothing is half-done", async () => {
      zb.failWith = new EditorialUnavailableError(25_000);
      webdeskZoneB.clearSiteCache();
      for (const [name, method, url, body] of writes()) {
        const r = await call(method, url, adminA, body);
        expect(r.statusCode, name).toBe(503);
        expect(r.json(), name).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
      }
      expect(zb.writes).toHaveLength(0);
    });

    it("breaker open AFTER the wall and the attribute read succeeded: the write's ledger carries attempted + failed", async () => {
      // The wall and the item read pass; the breaker opens exactly on the write call.
      const real = zb.asClient().send.bind(zb.asClient());
      const flaky = {
        send: async (req: Parameters<typeof real>[0]) => {
          if (req.command === "content.update") throw new EditorialUnavailableError(10_000);
          return zb.send(req);
        },
        close: () => undefined,
      };
      setWebdeskApprovedCommandDepsForTests({ client: flaky as never, signer });
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "z" } });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
      const rows = await ledger("webdesk.content.update");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "failed"]);
      expect(rows[1].metadata).toMatchObject({ status: 503 });
    });

    it("a transport failure on a read or a provably-undelivered write is 503 editorial_unavailable (webdesk_unreachable)", async () => {
      zb.failWith = new WebdeskControlTransportError("connect ECONNREFUSED", 3, false, "ECONNREFUSED");
      webdeskZoneB.clearSiteCache();
      const r = await call("GET", `${site()}/collections`, adminA);
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ error: "editorial_unavailable", reason: "webdesk_unreachable" });
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
      expect((await call("GET", `${site()}/collections`, adminA)).statusCode).toBe(200);
    });

    it("no control channel configured (the production default until WSK-63 is wired): reads AND writes are 503 webdesk_not_configured", async () => {
      setWebdeskApprovedCommandDepsForTests(null); // no client override: the real factory, no config
      const read = await call("GET", `${site()}/collections`, adminA);
      expect(read.statusCode).toBe(503);
      expect(read.json()).toMatchObject({ error: "webdesk_not_configured", reason: "control_channel_not_configured" });
      const write = await call("PUT", `${site()}/items/${item.itemId}`, adminA, { baseVersion: 1, fields: {} });
      expect(write.statusCode).toBe(503);
      expect(write.json()).toMatchObject({ error: "webdesk_not_configured" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("an AMBIGUOUS editorial write is reconciled by READING, never resent, never reported as plain success or failure", () => {
    it("update: the write landed and the link died → 200 with the reconciled head and `reconciled:true` (one send only)", async () => {
      zb.dropAfterApply = true;
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "landed" } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ reconciled: true, replayed: false, item: { headVersion: 2 }, version: { version: 2 } });
      expect(zb.writes).toHaveLength(1); // never resent
      const rows = await ledger("webdesk.content.update");
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "reconciled"]);
    });

    it("update: nothing was applied → 502 webdesk_ambiguous (not_observed), never success", async () => {
      zb.dropBeforeApply = true;
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "never" } });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_ambiguous", reason: "not_observed" });
      expect(zb.writes).toHaveLength(1);
      expect((await ledger("webdesk.content.update")).map((x) => x.metadata.outcome)).toEqual(["attempted", "ambiguous"]);
    });

    it("update: someone ELSE moved the head meanwhile → cannot tell → 502 (the caller's authorship is part of the proof)", async () => {
      zb.dropBeforeApply = true;
      // simulate a concurrent writer: head moves to 2, authored by another user
      item.headVersion = 2;
      item.versions.push({ version: 2, fields: { h1: "theirs" }, contentHash: "f".repeat(64), createdBy: "someone-else", createdAt: new Date().toISOString(), note: null });
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "mine" } });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_ambiguous" });
    });

    it("restore: landed → reconciled (head +1 by the caller AND the source version's content hash); not landed → 502", async () => {
      await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "v2" } });
      zb.dropAfterApply = true;
      const landed = await call("POST", `${site()}/items/${item.itemId}/restore`, editorA, { version: 1, baseVersion: 2 });
      expect(landed.statusCode).toBe(200);
      expect(landed.json()).toMatchObject({ reconciled: true, item: { headVersion: 3 } });
      zb.dropBeforeApply = true;
      const lost = await call("POST", `${site()}/items/${item.itemId}/restore`, editorA, { version: 1, baseVersion: 3 });
      expect(lost.statusCode).toBe(502);
    });

    it("create: the slug exists at v1 authored by the caller → 201 reconciled; absent → 502", async () => {
      zb.dropAfterApply = true;
      const landed = await call("POST", `${site()}/collections/service/items`, editorA, { locale: "en", slug: "service.amb", fields: { h1: "a" } });
      expect(landed.statusCode).toBe(201);
      expect(landed.json()).toMatchObject({ reconciled: true, item: { slug: "service.amb", headVersion: 1 } });
      zb.dropBeforeApply = true;
      const lost = await call("POST", `${site()}/collections/service/items`, editorA, { locale: "en", slug: "service.amb2", fields: { h1: "a" } });
      expect(lost.statusCode).toBe(502);
      expect(lost.json()).toMatchObject({ error: "webdesk_ambiguous" });
    });

    it("create: a slug that exists but was made by SOMEONE ELSE is not mistaken for our write (502, not 201)", async () => {
      zb.seedItem({ siteId: GAIADA_SITE, slug: "service.taken", locale: "en" }); // createdBy "seed"
      zb.dropBeforeApply = true;
      const r = await call("POST", `${site()}/collections/service/items`, editorA, { locale: "en", slug: "service.taken", fields: {} });
      expect(r.statusCode).toBe(502);
    });

    it("unpublish and delete: landed → reconciled; not landed → 502", async () => {
      zb.dropAfterApply = true;
      const u = await call("POST", `${site()}/items/${live1.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 });
      expect(u.statusCode).toBe(200);
      expect(u.json()).toMatchObject({ reconciled: true, item: { publishState: "unpublished" } });

      zb.dropAfterApply = true;
      const d = await call("POST", `${site()}/items/${item.itemId}/delete`, publisherA, { baseVersion: 1 });
      expect(d.statusCode).toBe(200);
      expect(d.json()).toMatchObject({ reconciled: true });

      const live2 = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.live2", publishedVersion: 1, publishState: "published" });
      zb.dropBeforeApply = true;
      expect((await call("POST", `${site()}/items/${live2.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 })).statusCode).toBe(502);
    });

    it("a replayed editorial assertion (the 401 a resend would get) is ambiguous too, and reconciles", async () => {
      // Apply the write, then answer the 401 a resent assertion would draw: the first one DID land.
      const real = zb.send.bind(zb);
      const replaying = {
        send: async (req: Parameters<typeof real>[0]) => {
          const r = await real(req);
          return req.command === "content.update" ? problem(401, "editorial-assertion-replayed") : r;
        },
        close: () => undefined,
      };
      setWebdeskApprovedCommandDepsForTests({ client: replaying as never, signer });
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "once" } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ reconciled: true, item: { headVersion: 2 } });
    });

    it("if the reconcile READ itself fails, it stays a typed 502 webdesk_ambiguous (reconcile_failed)", async () => {
      const real = zb.send.bind(zb);
      const client = {
        send: async (req: Parameters<typeof real>[0]) => {
          if (req.command === "item.get" && zb.writes.length > 0) throw new EditorialUnavailableError(5000);
          if (req.command === "content.update") {
            await real(req);
            throw new WebdeskControlTransportError("died", 1, true, "ECONNRESET");
          }
          return real(req);
        },
        close: () => undefined,
      };
      setWebdeskApprovedCommandDepsForTests({ client: client as never, signer });
      const r = await call("PUT", `${site()}/items/${item.itemId}`, editorA, { baseVersion: 1, fields: { h1: "x" } });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toMatchObject({ error: "webdesk_ambiguous", reason: "reconcile_failed" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("WSK-60: a takedown of LIVE content marks staging stale (the editor's banner), best-effort", () => {
    /** What the editor reads: the real build-status route. */
    async function stagingStale(): Promise<boolean> {
      const r = await call("GET", `${site()}/build-status`, editorA);
      expect(r.statusCode).toBe(200);
      return r.json<{ stagingStale: boolean }>().stagingStale;
    }
    const marks = async () =>
      (await adminPool().query<{ site_id: string }>(`SELECT site_id FROM webdev_site_staging_marks WHERE tenant_id = $1 AND stale_since IS NOT NULL`, [A])).rows;

    beforeEach(async () => {
      await adminPool().query(`DELETE FROM webdev_site_staging_marks WHERE tenant_id = $1`, [A]);
    });
    afterEach(() => setStagingStaleMarkerForTests(null));

    it("unpublishing a live item marks staging stale, under the site id the build-status route reads", async () => {
      expect(await stagingStale()).toBe(false);
      const r = await call("POST", `${site()}/items/${live1.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 });
      expect(r.statusCode).toBe(200);
      expect(await stagingStale()).toBe(true);
      expect(await marks()).toEqual([{ site_id: GAIADA_SITE.toLowerCase() }]);
    });

    it("an ambiguous unpublish that reconciles as landed marks it too", async () => {
      zb.dropAfterApply = true;
      const r = await call("POST", `${site()}/items/${live1.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 });
      expect(r.json()).toMatchObject({ reconciled: true });
      expect(await stagingStale()).toBe(true);
    });

    it("a refused unpublish (409 not-live, the item was never live) and an unpublish that never landed (502) do not mark", async () => {
      const refused = await call("POST", `${site()}/items/${item.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 });
      expect(refused.statusCode).toBe(409);
      zb.dropBeforeApply = true;
      const lost = await call("POST", `${site()}/items/${live1.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 });
      expect(lost.statusCode).toBe(502);
      expect(await stagingStale()).toBe(false);
    });

    it("deleting a draft-only item changes nothing staging serves: 200, not stale", async () => {
      const r = await call("POST", `${site()}/items/${item.itemId}/delete`, publisherA, { baseVersion: 1 });
      expect(r.statusCode).toBe(200);
      expect(r.json().item.deletedAt).toEqual(expect.any(String));
      expect(await stagingStale()).toBe(false);
    });

    it("a LIVE item cannot be deleted (409 item-is-live: unpublish first), so a delete never takes live content down", async () => {
      const r = await call("POST", `${site()}/items/${live1.itemId}/delete`, publisherA, { baseVersion: 1 });
      expect(r.statusCode).toBe(409);
      expect(await stagingStale()).toBe(false);
      // The real sequence: unpublish (marks), then delete the now non-live item (the mark stays).
      expect((await call("POST", `${site()}/items/${live1.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 })).statusCode).toBe(200);
      expect((await call("POST", `${site()}/items/${live1.itemId}/delete`, publisherA, { baseVersion: 1 })).statusCode).toBe(200);
      expect(await stagingStale()).toBe(true);
    });

    it("best-effort: when the mark cannot be written the unpublish still succeeds (200, ledger 'succeeded') and the failure is logged", async () => {
      setStagingStaleMarkerForTests(async () => {
        throw new Error("staging marks unavailable");
      });
      const errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      try {
        const r = await call("POST", `${site()}/items/${live1.itemId}/unpublish`, publisherA, { expectedPublishedVersion: 1 });
        expect(r.statusCode).toBe(200);
        expect(r.json().item).toMatchObject({ publishState: "unpublished", publishedVersion: null });
        expect((await ledger("webdesk.content.unpublish")).map((row) => row.metadata.outcome)).toEqual(["attempted", "succeeded"]);
        const logged = errors.mock.calls.map((c) => String(c[0]));
        expect(logged.some((m) => m.includes("content.unpublish: staging could not be marked stale") && m.includes("staging marks unavailable"))).toBe(true);
      } finally {
        errors.mockRestore();
      }
      expect(await stagingStale()).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("publish-requests: files exactly ONE approval and never calls Zone B's publish", () => {
    async function approvals() {
      const { rows } = await adminPool().query<{ id: string; origin: string; workflow_id: string; impact: string; requested_by: string; tool_args: Record<string, any>; status: string }>(
        `SELECT id, origin, workflow_id, impact, requested_by, tool_args, status FROM automation_approvals WHERE tenant_id = $1 AND origin = 'webdesk' ORDER BY created_at`,
        [A],
      );
      return rows;
    }
    beforeEach(async () => {
      await adminPool().query(`DELETE FROM automation_approvals WHERE tenant_id = $1 AND origin = 'webdesk'`, [A]);
    });

    it("🔴 one request, one approval row (HIGH, status pending), 202 {approvalId}; Zone B receives ONLY reads", async () => {
      const second = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.second", collectionKey: "service" });
      const r = await call("POST", `${site()}/publish-requests`, editorA, {
        items: [{ itemId: item.itemId, version: 1 }, { itemId: second.itemId, version: 1 }], note: "ship it",
      });
      expect(r.statusCode).toBe(202);
      const { approvalId } = r.json();
      const rows = await approvals();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: approvalId, workflow_id: "content.publish", impact: "high", requested_by: editorA, status: "pending" });
      expect(rows[0].tool_args).toMatchObject({
        command: "content.publish", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, note: "ship it",
        items: [{ itemId: item.itemId, version: 1, contentHash: item.versions[0].contentHash }, { itemId: second.itemId, version: 1, contentHash: second.versions[0].contentHash }],
      });
      expect(rows[0].tool_args.summary.title).toMatch(/Publish 2 items on gaiada\/Main/);
      // NEVER the publish: not one write, and no WS4 / editorial minted at all
      expect(zb.writes).toHaveLength(0);
      expect(zb.calls.some((c) => c.command === "content.publish" || c.command === "content.schedule")).toBe(false);
      expect(signer.calls).toHaveLength(0);
    });

    it("a publisher requesting the same is also a request, not a publish (R4 self-approval happens at decide(), not here)", async () => {
      const r = await call("POST", `${site()}/publish-requests`, publisherA, { items: [{ itemId: item.itemId, version: 1 }] });
      expect(r.statusCode).toBe(202);
      expect(await approvals()).toHaveLength(1);
      expect(zb.writes).toHaveLength(0);
    });

    it("publishAt/unpublishAt files a content.schedule approval instead (still one, still no Zone B write)", async () => {
      const at = new Date(Date.now() + 86_400_000).toISOString();
      const r = await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: item.itemId, version: 1 }], publishAt: at });
      expect(r.statusCode).toBe(202);
      expect(r.json().command).toBe("content.schedule");
      const rows = await approvals();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ workflow_id: "content.schedule" });
      expect(zb.writes).toHaveLength(0);
    });

    it("refusals file NOTHING: unknown item (typed 404), a deleted item (409 item-deleted), a duplicate id and a foreign site (400/404)", async () => {
      const ghost = await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: randomUUID(), version: 1 }] });
      expect(ghost.statusCode).toBe(404);
      const gone = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.gone", deletedAt: new Date().toISOString() });
      const del = await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: gone.itemId, version: 1 }] });
      expect(del.statusCode).toBe(409);
      expect(del.json().type).toContain("/item-deleted");
      const dup = await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: item.itemId, version: 1 }, { itemId: item.itemId, version: 1 }] });
      expect(dup.statusCode).toBe(400);
      const wrongVersion = await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: item.itemId, version: 7 }] });
      expect(wrongVersion.statusCode).toBe(404); // Zone B's typed version-not-found
      expect(await approvals()).toHaveLength(0);
      // positive control: the valid request files one
      expect((await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: item.itemId, version: 1 }] })).statusCode).toBe(202);
      expect(await approvals()).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the re-pointed WSK-31 routes: GET control/sites · POST control/sites · POST control/schema/apply", () => {
    const control = (p: string) => `/api/${A}/modules/webdev/control/${p}`;

    it("GET control/sites is LIVE: the same company-filtered tenants (no longer 501)", async () => {
      const r = await call("GET", control("sites"), adminA);
      expect(r.statusCode).toBe(200);
      expect(r.json().tenants.map((t: { slug: string }) => t.slug)).toEqual([GAIADA_SLUG]);
      expect((await call("GET", control("sites"), memberA)).statusCode).toBe(403);
    });

    it("POST control/schema/apply is LIVE: walled, a two-row ledger, Zone B's answer (and typed problems) pass through", async () => {
      const body = { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, collectionKey: "service", schema: { fields: [] } };
      expect((await call("POST", control("schema/apply"), memberA, body)).statusCode).toBe(403);
      const r = await call("POST", control("schema/apply"), adminA, body, { "idempotency-key": "idem-wsk59-schema-1" });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ bump: "minor", persisted: true });
      expect(zb.writes.at(-1)).toMatchObject({ command: "schema.apply", idempotencyKey: "idem-wsk59-schema-1", body: { schema: { fields: [] } } });
      expect(zb.writes.at(-1)!.editorialAssertion).toBeUndefined(); // not an editorial command (design §3.1)
      expect((await ledger("webdesk.schema.apply")).map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
      // the wall
      const foreign = await call("POST", control("schema/apply"), adminA, { ...body, tenantSlug: OTHER_SLUG, siteId: OTHER_SITE });
      expect(foreign.statusCode).toBe(404);
      // a typed 422 from Zone B passes untouched
      zb.nextWriteResponse = problem(422, "composition-violation", { issues: [{ path: "/fields/0", message: "bad" }] });
      const bad = await call("POST", control("schema/apply"), adminA, body);
      expect(bad.statusCode).toBe(422);
      expect(bad.json().issues).toEqual([{ path: "/fields/0", message: "bad" }]);
    });

    it("POST control/sites is LIVE: provisions on THIS company's tenant only", async () => {
      const body = { tenantSlug: GAIADA_SLUG, kind: "astro", name: "Landing" };
      expect((await call("POST", control("sites"), memberA, body)).statusCode).toBe(403);
      const r = await call("POST", control("sites"), adminA, body);
      expect(r.statusCode).toBe(201);
      expect(zb.writes.at(-1)).toMatchObject({ command: "site.provision", params: { tenantSlug: GAIADA_SLUG }, body: { kind: "astro", name: "Landing" } });
      expect((await call("POST", control("sites"), adminA, { ...body, tenantSlug: OTHER_SLUG })).statusCode).toBe(404);
    });

    it("the other control routes are STILL honest 501s", async () => {
      const r = await call("POST", control("sites/s1/promote"), adminA, {});
      expect(r.statusCode).toBe(501);
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("?slug= on the items route (the editor's by-slug open)", () => {
    it("returns only the exact-slug matches (all locales), asking WebDesk for q=<slug> at the page maximum", async () => {
      zb.seedItem({ siteId: GAIADA_SITE, slug: "service.seo", locale: "id" });
      zb.seedItem({ siteId: GAIADA_SITE, slug: "service.seo-audit", locale: "en" }); // a substring neighbour
      const r = await call("GET", `${site()}/collections/service/items?slug=service.seo`, editorA);
      expect(r.statusCode).toBe(200);
      const slugs = r.json().items.map((i: { slug: string; locale: string }) => `${i.slug}:${i.locale}`).sort();
      expect(slugs).toEqual(["service.seo:en", "service.seo:id"]);
      expect(zb.calls.find((c) => c.command === "item.list")!.query).toEqual({ q: "service.seo", limit: "100" });
      expect(r.json().page).toMatchObject({ hasMore: false });
    });

    it("an unknown slug is an empty list WITH page.hasMore=false (evidence), and slug+q together is a 400", async () => {
      const r = await call("GET", `${site()}/collections/service/items?slug=nope&locale=en`, editorA);
      expect(r.statusCode).toBe(200);
      expect(r.json().items).toEqual([]);
      expect((await call("GET", `${site()}/collections/service/items?slug=a&q=b`, editorA)).statusCode).toBe(400);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("withdraw: the REQUESTER cancels their own pending publish request", () => {
    const withdraw = (as: string, id: string, s = site()) => call("POST", `${s}/publish-requests/${id}/withdraw`, as);
    async function fileAs(as: string): Promise<string> {
      const r = await call("POST", `${site()}/publish-requests`, as, { items: [{ itemId: item.itemId, version: 1 }] });
      expect(r.statusCode).toBe(202);
      return r.json().approvalId;
    }
    const rowOf = async (id: string) =>
      (await adminPool().query<{ status: string; execution_status: string }>(`SELECT status, execution_status FROM automation_approvals WHERE id = $1`, [id])).rows[0];

    it("🔴 the requester withdraws: 200 {approvalId, status:'cancelled'}; the row is cancelled (not rejected) and never executes; Zone B untouched", async () => {
      const id = await fileAs(editorA);
      const r = await withdraw(editorA, id);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ approvalId: id, status: "cancelled" });
      expect(await rowOf(id)).toMatchObject({ status: "cancelled", execution_status: "not_applicable" });
      expect(zb.writes).toHaveLength(0);
      const led = await ledger("cancelled");
      expect(led.at(-1)!.metadata).toMatchObject({ origin: "webdesk", outcome: "withdrawn_by_requester" });
    });

    it("only the requester: another editor is 403 (positive control: the requester succeeds on the same id); a member is 403 first", async () => {
      const id = await fileAs(editorA);
      expect((await withdraw(publisherA, id)).statusCode).toBe(403);
      expect((await withdraw(memberA, id)).statusCode).toBe(403);
      expect((await rowOf(id)).status).toBe("pending");
      expect((await withdraw(editorA, id)).statusCode).toBe(200);
    });

    it("only while pending: a second withdraw and a withdraw after a decision are 409", async () => {
      const id = await fileAs(editorA);
      expect((await withdraw(editorA, id)).statusCode).toBe(200);
      const again = await withdraw(editorA, id);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ reason: "approval_not_pending" });
      const id2 = await fileAs(editorA);
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved' WHERE id = $1`, [id2]);
      expect((await withdraw(editorA, id2)).statusCode).toBe(409);
    });

    it("not another site's, not a non-webdesk row, not an unknown id: 404; and a foreign site is the wall's 404", async () => {
      const id = await fileAs(editorA);
      expect((await withdraw(editorA, randomUUID())).statusCode).toBe(404);
      expect((await withdraw(editorA, "not-a-uuid")).statusCode).toBe(404);
      expect((await withdraw(adminA, id, site(A, OTHER_SLUG, OTHER_SITE))).statusCode).toBe(404);
      // an approval of another origin is not addressable here
      const other = randomUUID();
      await adminPool().query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, origin, origin_site)
         VALUES ($1,$2,'wf:x','x.y','{}','medium','pending',$3,'automation','main')`, [other, A, editorA],
      );
      expect((await withdraw(editorA, other)).statusCode).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("own publish requests (WSK-44b): GET …/publish-requests: the requester reads their OWN approvals", () => {
    const list = (as: string, qs = "", s = site()) => call("GET", `${s}/publish-requests${qs}`, as);
    // approvals are not cleared between tests (only the ledger is), and earlier suites filed rows as editorA/publisherA
    beforeEach(async () => {
      await adminPool().query(`DELETE FROM automation_approvals WHERE tenant_id = $1 AND origin = 'webdesk'`, [A]);
    });
    async function fileAs(as: string, it: FakeItem = item): Promise<string> {
      const r = await call("POST", `${site()}/publish-requests`, as, { items: [{ itemId: it.itemId, version: 1 }] });
      expect(r.statusCode).toBe(202);
      return r.json().approvalId;
    }

    it("🔴 a webdev_staff editor reads the request they filed: {requests:[{approvalId,status,createdAt,itemIds,executionStatus}]}, exactly", async () => {
      const id = await fileAs(editorA);
      const r = await list(editorA, "?status=pending");
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toContain("application/json");
      expect(r.json()).toEqual({
        requests: [{ approvalId: id, status: "pending", createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/), itemIds: [item.itemId], executionStatus: "not_applicable" }],
      });
      // no ?status means pending
      expect((await list(editorA)).json().requests.map((q: { approvalId: string }) => q.approvalId)).toEqual([id]);
      // reads reach Zone B only for the wall (tenant.list), never as a write
      expect(zb.writes).toHaveLength(0);
    });

    it("OWN rows only: another editor/publisher/admin of the same company never sees them (and sees their own)", async () => {
      const mine = await fileAs(editorA);
      const theirs = await fileAs(publisherA, live1);
      const ids = async (as: string) => (await list(as)).json().requests.map((q: { approvalId: string }) => q.approvalId);
      expect(await ids(editorA)).toEqual([mine]);
      expect(await ids(publisherA)).toEqual([theirs]);
      expect(await ids(adminA)).toEqual([]);
    });

    it("scoped to THIS site and to webdesk publish/schedule rows: another site's, another origin's and other workflows' are not returned", async () => {
      const mine = await fileAs(editorA);
      const ins = (id: string, origin: string, workflow: string, args: unknown) =>
        adminPool().query(
          `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, origin, origin_site)
           VALUES ($1,$2,$3,'x.y',$4::jsonb,'high','pending',$5,$6,'main')`,
          [id, A, workflow, JSON.stringify(args), editorA, origin],
        );
      await ins(randomUUID(), "webdesk", "content.publish", { tenantSlug: GAIADA_SLUG, siteId: randomUUID(), items: [{ itemId: item.itemId, version: 1 }] });
      await ins(randomUUID(), "automation", "content.publish", { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, items: [{ itemId: item.itemId, version: 1 }] });
      await ins(randomUUID(), "webdesk", "content.rebuild", { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, items: [] });
      expect((await list(editorA)).json().requests.map((q: { approvalId: string }) => q.approvalId)).toEqual([mine]);
    });

    it("?status= filters by the approval's status; a withdrawn request is `cancelled`, a decided one carries its executionStatus; newest first", async () => {
      const a = await fileAs(editorA);
      const b = await fileAs(editorA, live1);
      const c = await fileAs(editorA);
      expect((await call("POST", `${site()}/publish-requests/${a}/withdraw`, editorA)).statusCode).toBe(200);
      await adminPool().query(`UPDATE automation_approvals SET status = 'approved', execution_status = 'executed' WHERE id = $1`, [b]);
      const ids = (r: { json: () => { requests: Array<{ approvalId: string }> } }) => r.json().requests.map((q) => q.approvalId);
      expect(ids(await list(editorA, "?status=pending"))).toEqual([c]);
      expect(ids(await list(editorA, "?status=cancelled"))).toEqual([a]);
      const approved = (await list(editorA, "?status=approved")).json().requests;
      expect(approved).toEqual([expect.objectContaining({ approvalId: b, status: "approved", executionStatus: "executed", itemIds: [live1.itemId] })]);
      expect((await list(editorA, "?status=rejected")).json().requests).toEqual([]);
      const all = (await list(editorA, "?status=all")).json().requests as Array<{ approvalId: string; status: string }>;
      expect(all.map((q) => q.approvalId).sort()).toEqual([a, b, c].sort());
      expect(all.find((q) => q.approvalId === a)!.status).toBe("cancelled");
    });

    it("strict: an unknown status or query key is 400 (after authorization: a member is 403 on the same URL), and a foreign site is the wall's 404", async () => {
      expect((await list(editorA, "?status=bogus")).statusCode).toBe(400);
      expect((await list(editorA, "?status=pending&x=1")).statusCode).toBe(400);
      expect((await list(memberA, "?status=bogus")).statusCode).toBe(403);
      const foreign = await list(adminA, "", site(A, OTHER_SLUG, OTHER_SITE));
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/site-not-found" });
    });

    it("FINDING (pinned, not widened): the generic approvals routes still refuse a webdev_staff requester, which is WHY this route exists", async () => {
      const id = await fileAs(editorA);
      // the list the editor used before WSK-44b, and the detail the editor's poll and /approvals/[id] use
      expect((await call("GET", `/api/${A}/automation-approvals?origin=webdesk&status=pending`, editorA)).statusCode).toBe(403);
      expect((await call("GET", `/api/${A}/automation-approvals/${id}`, editorA)).statusCode).toBe(403);
      // an approver (company_admin) reads both
      expect((await call("GET", `/api/${A}/automation-approvals/${id}`, adminA)).statusCode).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the unified approvals façade accepts origin 'webdesk' (WSK-66 rows were un-decidable and invisible)", () => {
    it("🔴 POST /api/:t/approvals/:id/decide {origin:'webdesk'} approves, WSK-66 executes ONE publish, the response carries the outcome; an unknown origin is still 400", async () => {
      const filed = await call("POST", `${site()}/publish-requests`, editorA, { items: [{ itemId: item.itemId, version: 1 }] });
      const id = filed.json().approvalId;
      const listed = await call("GET", `/api/approvals?origin=webdesk`, adminA);
      expect(listed.statusCode).toBe(200);
      expect(JSON.stringify(listed.json())).toContain(id);

      const bad = await call("POST", `/api/${A}/approvals/${id}/decide`, adminA, { origin: "nonsense", decision: "approved" });
      expect(bad.statusCode).toBe(400);
      const ok = await call("POST", `/api/${A}/approvals/${id}/decide`, adminA, { origin: "webdesk", decision: "approved" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, webdesk: { command: "content.publish", executionStatus: "executed" } });
      const publishes = zb.writes.filter((w) => w.command === "content.publish");
      expect(publishes).toHaveLength(1);
      expect(publishes[0].hadWs4).toBe(true);
      expect(item.publishedVersion).toBe(1);
    });

    it("the requester still cannot approve their own batch through the façade (maker ≠ checker holds): 403, nothing published", async () => {
      const second = zb.seedItem({ siteId: GAIADA_SITE, slug: "service.b2" });
      const filed = await call("POST", `${site()}/publish-requests`, publisherA, { items: [{ itemId: item.itemId, version: 1 }, { itemId: second.itemId, version: 1 }] });
      const denied = await call("POST", `/api/${A}/approvals/${filed.json().approvalId}/decide`, publisherA, { origin: "webdesk", decision: "approved" });
      expect(denied.statusCode).toBe(403);
      expect(zb.writes.filter((w) => w.command === "content.publish")).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the REAL egress client's breaker, over real sockets (done-when 4, end to end)", () => {
    let dir = "";
    let tokenServer: http.Server;
    let tokenPort = 0;
    let tokenRequests = 0;
    let deadPort = 0;
    const openssl = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "wsk59-pki-"));
      openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
      openssl("req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=wsk59-ca", "-days", "2", "-sha256",
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", "ca.crt");
      openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "client.key");
      openssl("req", "-new", "-key", "client.key", "-subj", "/CN=platform-nest-webdesk", "-out", "client.csr");
      writeFileSync(join(dir, "client.ext"), "extendedKeyUsage=clientAuth\n");
      openssl("x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2", "-sha256", "-extfile", "client.ext", "-out", "client.crt");
      tokenServer = http.createServer((_req, res) => {
        tokenRequests++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "wsk59-token", expires_in: 300 }));
      });
      await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", () => r()));
      tokenPort = (tokenServer.address() as AddressInfo).port;
      // a port nothing listens on: every connect is refused (a transport failure)
      const probe = net.createServer();
      await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
      deadPort = (probe.address() as AddressInfo).port;
      await new Promise<void>((r) => probe.close(() => r()));
    }, 60_000);
    afterAll(async () => {
      await new Promise<void>((r) => tokenServer?.close(() => r()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("🔴 two real connection failures open the breaker; after that every READ and WRITE is 503 editorial_unavailable/circuit_open with NO token request and NO socket", async () => {
      const client = new WebdeskControlClient({
        baseUrl: `https://127.0.0.1:${deadPort}`,
        clientCertFile: join(dir, "client.crt"), clientKeyFile: join(dir, "client.key"), caFile: join(dir, "ca.crt"),
        tokenUrl: `http://127.0.0.1:${tokenPort}/token`, clientId: "webdesk-control", clientSecret: "wsk59-secret-value",
        ws4Key: "wsk59-ws4-key-value", retryAttempts: 1, timeoutMs: 3_000, breakerThreshold: 2, breakerOpenMs: 60_000, sleep: async () => undefined,
      });
      setWebdeskApprovedCommandDepsForTests({ client, signer });
      webdeskZoneB.clearSiteCache();
      try {
        for (let i = 0; i < 2; i++) {
          const r = await call("GET", `${site()}/collections`, adminA);
          expect(r.statusCode).toBe(503);
          expect(r.json()).toMatchObject({ error: "editorial_unavailable", reason: "webdesk_unreachable" });
        }
        expect(client.describe().breaker).toBe("open");
        const tokensBefore = tokenRequests;
        const read = await call("GET", `${site()}/collections`, adminA);
        const write = await call("PUT", `${site()}/items/${item.itemId}`, adminA, { baseVersion: 1, fields: {} });
        const create = await call("POST", `${site()}/collections/service/items`, adminA, { locale: "en", slug: "x", fields: {} });
        for (const r of [read, write, create]) {
          expect(r.statusCode).toBe(503);
          expect(r.json()).toMatchObject({ error: "editorial_unavailable", reason: "circuit_open" });
        }
        expect(tokenRequests).toBe(tokensBefore); // an open breaker does no I/O at all
        expect(signer.calls).toHaveLength(0);
      } finally {
        client.close();
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// The wall's cache, without a database: a clock-injected WebdeskZoneB.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe("WebdeskZoneB.resolveEditableSite cache (60 s TTL; a miss refetches once the answer is 5 s old)", () => {
  const CO = randomUUID();
  const OTHER_CO = randomUUID();
  let now = 1_000_000;
  let fake: FakeZoneB;
  let zoneB: InstanceType<typeof import("./webdesk-content.service").WebdeskZoneB>;
  const lists = () => fake.calls.filter((c) => c.command === "tenant.list").length;

  beforeEach(async () => {
    const { WebdeskZoneB } = await import("./webdesk-content.service");
    now = 1_000_000;
    fake = new FakeZoneB(CO, OTHER_CO);
    setWebdeskApprovedCommandDepsForTests({ client: fake.asClient() });
    zoneB = new WebdeskZoneB(() => now);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));

  it("a hit is served from the cache for 60 s, then refetched", async () => {
    await zoneB.resolveEditableSite(CO, GAIADA_SLUG, GAIADA_SITE);
    now += 59_000;
    await zoneB.resolveEditableSite(CO, GAIADA_SLUG, GAIADA_SITE);
    expect(lists()).toBe(1);
    now += 2_000;
    await zoneB.resolveEditableSite(CO, GAIADA_SLUG, GAIADA_SITE);
    expect(lists()).toBe(2);
  });

  it("a site provisioned just now is found: a miss on a cache older than 5 s refetches once; a miss on a fresh cache does not", async () => {
    await zoneB.resolveEditableSite(CO, GAIADA_SLUG, GAIADA_SITE);
    const newSite = randomUUID();
    await expect(zoneB.resolveEditableSite(CO, GAIADA_SLUG, newSite)).rejects.toBeInstanceOf(WebdeskProblem);
    expect(lists()).toBe(1); // fresh cache: no storm
    fake.tenants[0].siteId = newSite; // Zone B now has it
    now += 6_000;
    await expect(zoneB.resolveEditableSite(CO, GAIADA_SLUG, newSite)).resolves.toMatchObject({ site: { siteId: newSite } });
    expect(lists()).toBe(2);
  });

  it("the cache is per company: another company never reads this one's entry", async () => {
    await zoneB.resolveEditableSite(CO, GAIADA_SLUG, GAIADA_SITE);
    await expect(zoneB.resolveEditableSite(OTHER_CO, GAIADA_SLUG, GAIADA_SITE)).rejects.toBeInstanceOf(WebdeskProblem);
    expect(fake.calls.filter((c) => c.command === "tenant.list").map((c) => c.query?.companyRef)).toEqual([CO, OTHER_CO]);
  });
});

// webdevModule is imported so a rename of the tool list here is a compile error, not a silent gap.
void webdevModule;
