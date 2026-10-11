// WSK-49c — the CLIENT-MODE website BFF (`/api/:tenantId/portal/clients/:clientId/website/...`), the site -> client link
// (`/api/:t/modules/webdev/content/sites/:slug/:siteId/client`), and the ERP-side D59 / D62 pre-checks.
//
// Real: Postgres (RLS, the activities ledger, the approval rows, the site -> client link), Cerbos (the real WSK-47 / 49c
// policies), the full NestJS app (`buildApp()`), the real content/media services and WSK-66's real approved-command
// executor. Stand-in: Zone B, the in-process FakeZoneB of `webdesk-content-testkit.ts` (it records the decoded editorial
// assertion of every call, so the `ce` claim is asserted on what was actually signed).
//
// DENIAL TESTS SEND VALID BODIES, each paired with a positive control on the same route (the "validation pre-empts authz"
// trap: a denial whose body was malformed anyway proves nothing about Cerbos). Every D59 / D62 refusal asserts NO egress:
// the fake saw no write (and, where it matters, no read of the thing being refused). Needs DATABASE_URL_TEST + CERBOS_URL.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { setPreviewProbeForTests } from "./webdesk-preview";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const SITE2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SLUG2 = "client2";
const SITE3 = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
const SLUG3 = "unlinked";

/** `service`: h1/intro/faq editable (the group's `q` inherits, `a` opts out), slugLabel is the agency's. Generic blocks are the agency's. */
const SERVICE = {
  ui: { label: "Services" },
  fields: [
    { name: "h1", primitive: "text", ui: { clientEditable: true } },
    { name: "intro", primitive: "markdown", ui: { clientEditable: true } },
    { name: "slugLabel", primitive: "text" },
    {
      name: "faq", primitive: "group", multiple: true, ui: { clientEditable: true },
      fields: [{ name: "q", primitive: "text" }, { name: "a", primitive: "text", ui: { clientEditable: false } }],
    },
  ],
};
/** Nothing client-editable anywhere. */
const LEGAL = { ui: { label: "Legal" }, fields: [{ name: "body", primitive: "markdown" }] };
/** A REQUIRED field the client cannot edit: a client create is impossible, and the BFF says so plainly. */
const PROMO = {
  ui: { label: "Promo" },
  fields: [{ name: "code", primitive: "text", required: true }, { name: "headline", primitive: "text", ui: { clientEditable: true } }],
};

describe.skipIf(!live)("WSK-49c · the client-mode website BFF", () => {
  let app: NestFastifyApplication;
  let A: string; // the SERVING company: owns tenants `gaiada`, `client2`, `unlinked`
  let B: string; // another company: owns `othertenant`
  let cA1: string, cA2: string, cB1: string; // clients
  let edA1: string, ed2A1: string, edA2: string, viewerA1: string, adminOnlyA1: string, revokedA1: string, edB1: string;
  let staffAdmin: string, staffManager: string, staffEditor: string, staffMember: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const W = (client = cA1, tenant = A) => `/api/${tenant}/portal/clients/${client}/website`;
  const S = (client = cA1, slug = GAIADA_SLUG, siteId = GAIADA_SITE, tenant = A) => `${W(client, tenant)}/sites/${slug}/${siteId}`;
  const STAFF = (slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `/api/${A}/modules/webdev/content/sites/${slug}/${siteId}`;
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, as: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...asUser(as), ...headers }, payload: payload as never });

  const addContact = async (tenant: string, client: string, user: string, opts: { capability?: string; status?: string } = {}) =>
    withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
        [newId(), tenant, client, user, opts.capability ?? "signer", opts.status ?? "active", config.originSite],
      ),
    );
  const link = (slug: string, siteId: string, client: string, tenant = A) =>
    withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO webdesk_site_clients (id, tenant_id, tenant_slug, site_id, client_id, origin_site) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, tenant_slug, site_id) DO UPDATE SET client_id = EXCLUDED.client_id`,
        [newId(), tenant, slug, siteId, client, config.originSite],
      ),
    );
  const approvalRow = async (id: string) =>
    (await adminPool().query<{ status: string; execution_status: string | null; tool_args: Record<string, unknown>; requested_by: string | null }>(
      `SELECT status, execution_status, tool_args, requested_by FROM automation_approvals WHERE id = $1`, [id],
    )).rows[0];
  const approvalCount = async () => Number((await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A])).rows[0].n);
  const clearApprovals = () => adminPool().query(`DELETE FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A]);

  /** An item in A's `gaiada` site with agency-owned content, SEO and a generic block (the things a client must not lose or change). */
  function seed(slug: string, o: { published?: boolean; collectionKey?: string; siteId?: string; fields?: Record<string, unknown>; seo?: Record<string, unknown>; blocks?: unknown[] } = {}): FakeItem {
    const it = zb.seedItem({
      siteId: o.siteId ?? GAIADA_SITE, slug, collectionKey: o.collectionKey ?? "service",
      ...(o.published ? { publishedVersion: 1, publishState: "published" as const } : {}),
    });
    it.versions[0] = {
      ...it.versions[0],
      fields: o.fields ?? { h1: "Head", intro: "intro", slugLabel: "agency", faq: [{ q: "q1", a: "a1" }] },
      seo: o.seo ?? { title: "SEO T" },
      blocks: o.blocks ?? [{ type: "markdown", props: { content: "agency block" } }],
      contentHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    };
    return it;
  }
  /** Appends version n+1 = version n with `patch` applied to its fields (and optionally new seo), and moves the head. */
  function addVersion(it: FakeItem, fieldsPatch: Record<string, unknown>, seo?: Record<string, unknown>): void {
    const prev = it.versions[it.versions.length - 1];
    it.versions.push({
      ...prev, version: prev.version + 1, fields: { ...(prev.fields as Record<string, unknown>), ...fieldsPatch }, ...(seo ? { seo } : {}),
      contentHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
    });
    it.headVersion = prev.version + 1;
  }
  const updateBody = (it: FakeItem, fields: Record<string, unknown>) => ({ baseVersion: it.headVersion, fields });
  const goodFields = { h1: "Edited headline", intro: "intro", slugLabel: "agency", faq: [{ q: "q1", a: "a1" }] };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.webdeskPublic.baseUrl = "https://webdesk.example.test";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-49c Serving Co", ["webdev"]);
    B = await createCompany("WSK-49c Other Co", ["webdev"]);
    cA1 = await createClient(A, "Bali Beach Resort");
    cA2 = await createClient(A, "Nusa Coffee");
    cB1 = await createClient(B, "Rival Client");
    const clientRole = await createRole("client");
    const editorRole = await createRole("client_website_editor");
    const mkClient = async (email: string, tenant: string, client: string, o: { capability?: string; status?: string; editor?: boolean } = {}) => {
      const u = await createUser(email);
      await addContact(tenant, client, u, o);
      await grantRole(u, clientRole, "company", tenant);
      if (o.editor !== false) await grantRole(u, editorRole, "client", client);
      return u;
    };
    edA1 = await mkClient("ed-a1@w49c.test", A, cA1);
    ed2A1 = await mkClient("ed2-a1@w49c.test", A, cA1);
    edA2 = await mkClient("ed-a2@w49c.test", A, cA2);
    viewerA1 = await mkClient("viewer-a1@w49c.test", A, cA1, { capability: "viewer", editor: false });
    adminOnlyA1 = await mkClient("admin-a1@w49c.test", A, cA1, { capability: "admin", editor: false });
    revokedA1 = await mkClient("revoked-a1@w49c.test", A, cA1, { status: "revoked" }); // holds the grant row, but is no longer a contact
    edB1 = await mkClient("ed-b1@w49c.test", B, cB1);
    const staff = async (email: string, role: string) => {
      const u = await createUser(email);
      await addMembership(A, u);
      await grantRole(u, await createRole(role), "company", A);
      return u;
    };
    staffAdmin = await staff("admin@w49c.test", "company_admin");
    staffManager = await staff("manager@w49c.test", "webdev_manager");
    staffEditor = await staff("editor@w49c.test", "webdev_staff");
    staffMember = await staff("member@w49c.test", "member");

    zb = new FakeZoneB(A, B);
    zb.tenants.push({ companyRef: A, slug: SLUG2, status: "active", siteId: SITE2 });
    zb.tenants.push({ companyRef: A, slug: SLUG3, status: "active", siteId: SITE3 });
    zb.compositions.set("service", SERVICE);
    zb.compositions.set("legal", LEGAL);
    zb.compositions.set("promo", PROMO);
    await link(GAIADA_SLUG, GAIADA_SITE, cA1);
    await link(SLUG2, SITE2, cA2);
    // SITE3 is deliberately unlinked.
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    setPreviewProbeForTests({ fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch });
    await clearApprovals();
    await adminPool().query(`DELETE FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A]);
  });
  afterEach(() => {
    setWebdeskApprovedCommandDepsForTests(null);
    setPreviewProbeForTests(null);
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const noEgress = () => expect(zb.calls.map((c) => c.command)).toEqual([]);
  const noWrites = () => expect(zb.writes.map((c) => c.command)).toEqual([]);
  const slugOf = (r: { json: () => { type?: string } }) => String(r.json().type ?? "").split("/").pop();

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("authorization comes first, scope is isolated, and a denied call costs no egress", () => {
    it("the editor's own routes work (positive controls for everything below)", async () => {
      const item = seed("svc.one");
      expect((await call("GET", W(), edA1)).statusCode).toBe(200);
      expect((await call("GET", `${S()}/collections`, edA1)).statusCode).toBe(200);
      expect((await call("GET", `${S()}/collections/service/items`, edA1)).statusCode).toBe(200);
      expect((await call("GET", `${S()}/items/${item.itemId}`, edA1)).statusCode).toBe(200);
      expect((await call("GET", `${W()}/publish-requests`, edA1)).statusCode).toBe(200);
      expect((await call("GET", `${S()}/media`, edA1)).statusCode).toBe(200);
    });

    // A route table: [label, method, url, a body that would SUCCEED for the allowed editor]
    const routes = (it: FakeItem): Array<[string, "GET" | "POST" | "PUT" | "PATCH", string, unknown?]> => {
      // A client can publish only what a client could have changed (D62): a never-published item holding agency content cannot go
      // out, so the publish bodies name an item whose every value is client-editable (still a valid body for the allowed editor).
      const pub = seed(`svc.pubable.${randomUUID().slice(0, 8)}`, { fields: { h1: "client made", intro: "text" }, seo: {}, blocks: [] });
      return [
      ["GET sites", "GET", W()],
      ["GET collections", "GET", `${S()}/collections`],
      ["GET items", "GET", `${S()}/collections/service/items`],
      ["GET item", "GET", `${S()}/items/${it.itemId}`],
      ["GET versions", "GET", `${S()}/items/${it.itemId}/versions`],
      ["POST create", "POST", `${S()}/collections/service/items`, { locale: "en", slug: "service.valid", fields: { h1: "x" } }],
      ["PUT update", "PUT", `${S()}/items/${it.itemId}`, updateBody(it, goodFields)],
      ["POST preview", "POST", `${S()}/items/${it.itemId}/preview`, {}],
      ["POST publish-requests", "POST", `${S()}/publish-requests`, { items: [{ itemId: pub.itemId, version: 1 }] }],
      ["POST item publish", "POST", `${S()}/items/${pub.itemId}/publish`, {}],
      ["GET publish-requests", "GET", `${W()}/publish-requests`],
      ["POST approve", "POST", `${W()}/publish-requests/${randomUUID()}/approve`, {}],
      ["GET media", "GET", `${S()}/media`],
      ["POST upload-token", "POST", `${S()}/media/upload-token`, { bucket: "media" }],
      ["PATCH media", "PATCH", `${S()}/media/${randomUUID()}`, { title: "T" }],
      ];
    };

    it.each([
      ["a plain client contact (viewer, no website grant)", () => viewerA1],
      ["a client ADMIN who has not been granted the website role", () => adminOnlyA1],
      ["a contact whose contact row was revoked (the grant row is inert)", () => revokedA1],
      ["staff: company_admin", () => staffAdmin],
      ["staff: webdev_manager (the publisher tier)", () => staffManager],
      ["staff: webdev_staff", () => staffEditor],
      ["staff: member", () => staffMember],
    ])("%s is denied (403) on EVERY portal website route, with a valid body, and nothing reaches WebDesk", async (_label, who) => {
      const item = seed("svc.deny");
      zb.calls.length = 0;
      for (const [label, method, url, body] of routes(item)) {
        const r = await call(method, url, who(), body);
        expect(r.statusCode, `${label}: ${r.body.slice(0, 160)}`).toBe(403);
      }
      noEgress();
      expect(await approvalCount()).toBe(0);
    });

    it("the SAME valid bodies succeed for the granted editor (so the 403s above are Cerbos, not validation)", async () => {
      const item = seed("svc.control");
      for (const [label, method, url, body] of routes(item)) {
        if (label === "POST approve") continue; // needs a real request: covered below
        if (label === "PATCH media") continue; // needs a real asset: covered below
        const r = await call(method, url, edA1, body);
        expect(r.statusCode, `${label}: ${r.body.slice(0, 200)}`).toBeLessThan(300);
      }
    });

    it("another CLIENT'S routes are closed to this client's editor, and the reverse (positive control: each reaches its own)", async () => {
      const item = seed("svc.iso");
      expect((await call("GET", W(cA1), edA1)).statusCode).toBe(200);
      expect((await call("GET", W(cA2), edA2)).statusCode).toBe(200);
      zb.calls.length = 0;
      for (const [who, client] of [[edA1, cA2], [edA2, cA1], [edA1, cB1], [edB1, cA1]] as const) {
        expect((await call("GET", W(client), who)).statusCode, "sites").toBe(403);
        expect((await call("GET", `${S(client)}/collections`, who)).statusCode, "collections").toBe(403);
        expect((await call("GET", `${S(client)}/items/${item.itemId}`, who)).statusCode, "item").toBe(403);
        expect((await call("PUT", `${S(client)}/items/${item.itemId}`, who, updateBody(item, goodFields))).statusCode, "update").toBe(403);
        expect((await call("POST", `${S(client)}/items/${item.itemId}/publish`, who, {})).statusCode, "self-publish").toBe(403);
        expect((await call("GET", `${W(client)}/publish-requests`, who)).statusCode, "requests").toBe(403);
      }
      noEgress();
    });

    it("another COMPANY: an editor of company B reaches nothing of company A's tenant (positive control: B's own client route)", async () => {
      expect((await call("GET", W(cB1, B), edB1)).statusCode).toBe(200);
      zb.calls.length = 0;
      for (const url of [W(cA1, A), `${S(cA1, GAIADA_SLUG, GAIADA_SITE, A)}/collections`, `${W(cA1, A)}/publish-requests`]) {
        const r = await call("GET", url, edB1);
        expect([403, 404], url).toContain(r.statusCode);
      }
      noEgress();
    });

    it("the site must be LINKED to the URL's client: a granted editor on a site of another client, an unlinked site, another company's site and a malformed id are all the same 404", async () => {
      expect((await call("GET", `${S(cA1)}/collections`, edA1)).statusCode).toBe(200); // control: their own linked site
      const probes: Array<[string, string]> = [
        ["a site linked to ANOTHER client of the same company", `${S(cA1, SLUG2, SITE2)}/collections`],
        ["a site nobody linked", `${S(cA1, SLUG3, SITE3)}/collections`],
        ["another company's site", `${S(cA1, OTHER_SLUG, OTHER_SITE)}/collections`],
        ["a malformed site id", `${S(cA1, GAIADA_SLUG, "not-a-uuid")}/collections`],
        ["an unknown slug", `${S(cA1, "nope", GAIADA_SITE)}/collections`],
      ];
      zb.calls.length = 0;
      for (const [label, url] of probes) {
        const r = await call("GET", url, edA1);
        expect(r.statusCode, label).toBe(404);
        expect(r.headers["content-type"], label).toContain("application/problem+json");
        expect(slugOf(r), label).toBe("site-not-found");
      }
      noEgress();
    });

    it("unlinking a site takes the client's access away AT ONCE (every request reads the link)", async () => {
      await link(SLUG3, SITE3, cA1);
      expect((await call("GET", `${S(cA1, SLUG3, SITE3)}/collections`, edA1)).statusCode).toBe(200);
      const del = await call("DELETE", `${STAFF(SLUG3, SITE3)}/client`, staffAdmin);
      expect(del.statusCode).toBe(200);
      expect((await call("GET", `${S(cA1, SLUG3, SITE3)}/collections`, edA1)).statusCode).toBe(404);
    });

    it("a client editor cannot use the STAFF routes (and the staff admin can: positive control)", async () => {
      const item = seed("svc.staffroute");
      expect((await call("GET", `${STAFF()}/items/${item.itemId}`, staffAdmin)).statusCode).toBe(200);
      for (const [method, url, body] of [
        ["GET", `${STAFF()}/items/${item.itemId}`, undefined],
        ["PUT", `${STAFF()}/items/${item.itemId}`, updateBody(item, goodFields)],
        ["POST", `${STAFF()}/items/${item.itemId}/unpublish`, { expectedPublishedVersion: 1 }],
        ["POST", `${STAFF()}/items/${item.itemId}/delete`, { baseVersion: 1 }],
        ["DELETE", `${STAFF()}/media/${randomUUID()}`, undefined],
        ["GET", `${STAFF()}/client`, undefined],
        ["PUT", `${STAFF()}/client`, { clientId: cA1 }],
      ] as const) {
        expect((await call(method, url, edA1, body)).statusCode, `${method} ${url}`).toBe(403);
      }
    });

    it("there is NO client route for delete, unpublish, schedule, schema or media delete (404, never a 2xx)", async () => {
      const item = seed("svc.noroutes");
      zb.calls.length = 0;
      for (const [method, url, body] of [
        ["DELETE", `${S()}/items/${item.itemId}`, undefined],
        ["POST", `${S()}/items/${item.itemId}/delete`, { baseVersion: 1 }],
        ["POST", `${S()}/items/${item.itemId}/unpublish`, { expectedPublishedVersion: 1 }],
        ["POST", `${S()}/items/${item.itemId}/schedule`, {}],
        ["DELETE", `${S()}/media/${randomUUID()}`, undefined],
        ["POST", `${S()}/collections/service/schema/apply`, {}],
        ["PUT", `${S()}/collections/service`, {}],
      ] as const) {
        const r = await call(method, url, edA1, body);
        expect(r.statusCode, `${method} ${url}`).toBe(404);
      }
      noWrites();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("reads: the client's sites, collections with the clientEditable map, items", () => {
    it("GET website lists ONLY this client's linked sites", async () => {
      const a = await call("GET", W(cA1), edA1);
      expect(a.json()).toMatchObject({ clientId: cA1, sites: [{ tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, defaultLocale: "en" }] });
      expect(a.json().sites).toHaveLength(1);
      const b = await call("GET", W(cA2), edA2);
      expect(b.json().sites.map((s: { tenantSlug: string }) => s.tenantSlug)).toEqual([SLUG2]);
    });

    it("GET collections adds the per-collection clientEditable map (computed by the vendored rule), and keeps WebDesk's own fields", async () => {
      zb.seedItem({ siteId: GAIADA_SITE, slug: "x", collectionKey: "legal" });
      const r = await call("GET", `${S()}/collections`, edA1);
      expect(r.statusCode).toBe(200);
      const byKey = Object.fromEntries(r.json().collections.map((c: { key: string }) => [c.key, c]));
      expect(byKey.service).toMatchObject({
        vocabularyVersion: "1.1.0", composition: { fields: expect.any(Array) },
        clientEditable: {
          fields: { h1: true, intro: true, slugLabel: false, faq: true, "faq.q": true, "faq.a": false },
          blocks: false, seo: false, create: { allowed: true, reason: null, blockedBy: [] },
        },
      });
      expect(byKey.legal.clientEditable).toMatchObject({ fields: { body: false }, create: { allowed: false, reason: "nothing-editable" } });
      expect(byKey.promo.clientEditable).toMatchObject({
        fields: { code: false, headline: true }, create: { allowed: false, reason: "required-fields-not-editable", blockedBy: ["code"] },
      });
    });

    it("GET item returns the item, its composition and the per-field clientEditable map; a deleted item is a 404 to a client (staff still read it: control)", async () => {
      const it = seed("svc.read");
      const r = await call("GET", `${S()}/items/${it.itemId}`, edA1);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        item: { itemId: it.itemId, collectionKey: "service" }, version: { n: 1 }, composition: { fields: expect.any(Array) },
        clientEditable: { fields: { slugLabel: false, h1: true }, seo: false },
      });
      it.deletedAt = new Date().toISOString();
      const gone = await call("GET", `${S()}/items/${it.itemId}`, edA1);
      expect(gone.statusCode).toBe(404);
      expect(slugOf(gone)).toBe("item-not-found");
      expect((await call("GET", `${STAFF()}/items/${it.itemId}`, staffAdmin)).statusCode).toBe(200);
    });

    it("a client cannot list deleted items or deleted media (valid-shaped queries, 400), and the allow-listed ones work", async () => {
      expect((await call("GET", `${S()}/collections/service/items?state=live&limit=10`, edA1)).statusCode).toBe(200);
      zb.calls.length = 0;
      expect((await call("GET", `${S()}/collections/service/items?includeDeleted=true`, edA1)).statusCode).toBe(400);
      expect((await call("GET", `${S()}/collections/service/items?state=deleted`, edA1)).statusCode).toBe(400);
      expect((await call("GET", `${S()}/media?includeDeleted=true`, edA1)).statusCode).toBe(400);
      expect(zb.calls.filter((c) => c.command === "item.list" || c.command === "media.list")).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("D59 — the ERP refuses a non-editable change BEFORE any WebDesk write", () => {
    it("update: an editable change goes through, signed `ce:true`; the item's EXISTING seo and generic blocks are re-sent (the 49b note)", async () => {
      const it = seed("svc.upd");
      const r = await call("PUT", `${S()}/items/${it.itemId}`, edA1, updateBody(it, goodFields), { "idempotency-key": "w49c-upd-1" });
      expect(r.statusCode).toBe(200);
      const w = zb.writes.at(-1)!;
      expect(w).toMatchObject({ command: "content.update", method: "PUT", idempotencyKey: "w49c-upd-1" });
      expect(w.claims).toMatchObject({ ce: true, sub: edA1, cmd: "content.update", ten: GAIADA_SLUG, site: GAIADA_SITE });
      // the body that left the ERP: the client sent no seo and no blocks, the BFF re-sent the head's
      expect(w.body).toMatchObject({ baseVersion: 1, fields: goodFields, seo: { title: "SEO T" }, blocks: [{ type: "markdown", props: { content: "agency block" } }] });
      const head = it.versions[it.headVersion - 1];
      expect(head.seo).toEqual({ title: "SEO T" });
      expect(head.blocks).toEqual([{ type: "markdown", props: { content: "agency block" } }]);
      // the two-row ledger says a client wrote it
      const rows = (await adminPool().query(`SELECT metadata FROM activities WHERE tenant_id = $1 AND verb = 'webdesk.content.update' ORDER BY occurred_at, id`, [A])).rows;
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
      expect(rows[0].metadata).toMatchObject({ clientEditor: true, clientId: cA1 });
    });

    it("update: a change to a non-editable field is 422 field-not-client-editable with the JSON pointer, and NOTHING is sent (control: the editable change above)", async () => {
      const it = seed("svc.upd-bad");
      zb.calls.length = 0;
      const r = await call("PUT", `${S()}/items/${it.itemId}`, edA1, updateBody(it, { ...goodFields, slugLabel: "client tampered" }));
      expect(r.statusCode).toBe(422);
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect(r.json()).toMatchObject({ type: expect.stringContaining("/errors/field-not-client-editable"), total: 1, issues: [{ path: "/blocks/0/props/slugLabel" }] });
      noWrites();
      expect(zb.calls.map((c) => c.command)).not.toContain("content.update");
      expect(it.headVersion).toBe(1);
    });

    it("update: a non-editable MEMBER inside an editable group is refused (faq/0/a), an editable one is not (faq/0/q); ONE bad path refuses the WHOLE write", async () => {
      const it = seed("svc.upd-group");
      const bad = await call("PUT", `${S()}/items/${it.itemId}`, edA1, updateBody(it, { ...goodFields, faq: [{ q: "q edited", a: "a edited" }] }));
      expect(bad.statusCode).toBe(422);
      expect(bad.json().issues.map((i: { path: string }) => i.path)).toEqual(["/blocks/0/props/faq/0/a"]);
      noWrites();
      const good = await call("PUT", `${S()}/items/${it.itemId}`, edA1, updateBody(it, { ...goodFields, faq: [{ q: "q edited", a: "a1" }] }));
      expect(good.statusCode).toBe(200);
    });

    it("update: removing the agency's generic blocks (blocks: []) is a change to a non-editable path; omitting `blocks` keeps them", async () => {
      const it = seed("svc.upd-blocks");
      const r = await call("PUT", `${S()}/items/${it.itemId}`, edA1, { ...updateBody(it, goodFields), blocks: [] });
      expect(r.statusCode).toBe(422);
      expect(r.json().issues.every((i: { path: string }) => i.path.startsWith("/blocks/1"))).toBe(true);
      noWrites();
      expect((await call("PUT", `${S()}/items/${it.itemId}`, edA1, updateBody(it, goodFields))).statusCode).toBe(200);
    });

    it("update: `seo` is never accepted from a client (422 /seo), even an unchanged copy; an empty object is 'nothing'", async () => {
      const it = seed("svc.upd-seo");
      for (const seo of [{ title: "New" }, { title: "SEO T" }]) {
        const r = await call("PUT", `${S()}/items/${it.itemId}`, edA1, { ...updateBody(it, goodFields), seo });
        expect(r.statusCode).toBe(422);
        expect(r.json()).toMatchObject({ issues: [{ path: "/seo" }] });
      }
      noWrites();
      expect((await call("PUT", `${S()}/items/${it.itemId}`, edA1, { ...updateBody(it, goodFields), seo: {} })).statusCode).toBe(200);
      expect(it.versions[it.headVersion - 1].seo).toEqual({ title: "SEO T" }); // the existing seo survived
    });

    it("update: a deleted item is 409 item-deleted and nothing is sent; a stale baseVersion is WebDesk's 409 (decided there, as it is first in WebDesk)", async () => {
      const it = seed("svc.upd-del");
      it.deletedAt = new Date().toISOString();
      const r = await call("PUT", `${S()}/items/${it.itemId}`, edA1, updateBody(it, goodFields));
      expect(r.statusCode).toBe(409);
      expect(slugOf(r)).toBe("item-deleted");
      noWrites();
      it.deletedAt = null;
      const stale = await call("PUT", `${S()}/items/${it.itemId}`, edA1, { baseVersion: 7, fields: goodFields });
      expect(stale.statusCode).toBe(409);
      expect(slugOf(stale)).toBe("version-conflict");
    });

    it("update/restore: a STALE baseVersion is 409 version-conflict, never a 422 about a field the client did not touch; nothing is sent (control: the same edit on a fresh base)", async () => {
      // the client loaded v1; staff then changed a PROTECTED field (head v2)
      const it = seed("svc.stale");
      addVersion(it, { slugLabel: "staff changed it" });
      zb.calls.length = 0;
      // the client's save is relative to v1 and changes only an editable field (slugLabel is still the v1 value)
      const stale = await call("PUT", `${S()}/items/${it.itemId}`, edA1, { baseVersion: 1, fields: goodFields });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.headers["content-type"]).toContain("application/problem+json");
      expect(stale.json()).toMatchObject({
        type: "https://webdesk.gaiada.online/errors/version-conflict", title: "Version conflict", status: 409, currentHeadVersion: 2,
        currentContentHash: expect.any(String), updatedAt: expect.any(String),
        detail: expect.stringContaining("baseVersion does not match the item's head version (2)"),
      });
      noWrites();
      expect(it.headVersion).toBe(2);
      // control: the same edit re-based on the head (carrying staff's value) goes through
      const fresh = await call("PUT", `${S()}/items/${it.itemId}`, edA1, { baseVersion: 2, fields: { ...goodFields, slugLabel: "staff changed it" } });
      expect(fresh.statusCode, fresh.body).toBe(200);

      // restore: same rule
      const r2 = seed("svc.stale-restore");
      addVersion(r2, { h1: "v2 headline" });
      zb.calls.length = 0;
      const staleRestore = await call("POST", `${S()}/items/${r2.itemId}/restore`, edA1, { version: 1, baseVersion: 1 });
      expect(staleRestore.statusCode).toBe(409);
      expect(slugOf(staleRestore)).toBe("version-conflict");
      noWrites();
      expect((await call("POST", `${S()}/items/${r2.itemId}/restore`, edA1, { version: 1, baseVersion: 2 })).statusCode).toBe(200);
    });

    it("a deleted item's HISTORY is 404 to a client, like the item (control: live history reads; staff still read it)", async () => {
      const it = seed("svc.hist");
      expect((await call("GET", `${S()}/items/${it.itemId}/versions`, edA1)).statusCode).toBe(200);
      expect((await call("GET", `${S()}/items/${it.itemId}/versions/1`, edA1)).statusCode).toBe(200);
      it.deletedAt = new Date().toISOString();
      for (const url of [`${S()}/items/${it.itemId}/versions`, `${S()}/items/${it.itemId}/versions/1`]) {
        const r = await call("GET", url, edA1);
        expect(r.statusCode, url).toBe(404);
        expect(slugOf(r)).toBe("item-not-found");
      }
      expect((await call("GET", `${STAFF()}/items/${it.itemId}/versions`, staffAdmin)).statusCode).toBe(200);
    });

    it("update: strict body (an unknown key is a 400, never forwarded)", async () => {
      const it = seed("svc.upd-strict");
      const r = await call("PUT", `${S()}/items/${it.itemId}`, edA1, { ...updateBody(it, goodFields), tenantSlug: "othertenant" });
      expect(r.statusCode).toBe(400);
      noWrites();
    });

    it("create: only editable fields, signed `ce:true` (control); a non-editable field, `seo`, a collection with nothing editable, and a REQUIRED non-editable field are each 422 with no write", async () => {
      const ok = await call("POST", `${S()}/collections/service/items`, edA1, { locale: "en", slug: "service.client-new", fields: { h1: "Fresh", intro: "hello" } });
      expect(ok.statusCode).toBe(201);
      expect(zb.writes.at(-1)!.claims).toMatchObject({ ce: true, cmd: "content.create", sub: edA1 });
      zb.calls.length = 0;
      const nonEditable = await call("POST", `${S()}/collections/service/items`, edA1, { locale: "en", slug: "service.two", fields: { h1: "x", slugLabel: "nope" } });
      expect(nonEditable.statusCode).toBe(422);
      expect(nonEditable.json().issues).toEqual([{ path: "/blocks/0/props/slugLabel", message: expect.any(String) }]);
      const withSeo = await call("POST", `${S()}/collections/service/items`, edA1, { locale: "en", slug: "service.three", fields: { h1: "x" }, seo: { title: "t" } });
      expect(withSeo.statusCode).toBe(422);
      expect(withSeo.json().issues[0].path).toBe("/seo");
      const legal = await call("POST", `${S()}/collections/legal/items`, edA1, { locale: "en", slug: "legal.one", fields: { body: "x" } });
      expect(legal.statusCode).toBe(422);
      expect(legal.json().issues[0].path).toBe("/collectionKey");
      expect(legal.json().detail).toContain("Nothing in collection");
      const promo = await call("POST", `${S()}/collections/promo/items`, edA1, { locale: "en", slug: "promo.one", fields: { headline: "x" } });
      expect(promo.statusCode).toBe(422);
      expect(promo.json().detail).toMatch(/required field\(s\) code are not client-editable/);
      expect(promo.json().detail).toMatch(/Ask Gaiada to create the item/);
      expect(promo.json().issues).toEqual([{ path: "/blocks/0/props/code", message: expect.any(String) }]);
      noWrites();
    });

    it("restore: a version that differs from the head only in editable paths restores (200, ce:true); one that differs in a non-editable path is 422 and sends nothing", async () => {
      const it = seed("svc.restore");
      addVersion(it, { h1: "v2 headline" });
      const ok = await call("POST", `${S()}/items/${it.itemId}/restore`, edA1, { version: 1, baseVersion: 2 });
      expect(ok.statusCode).toBe(200);
      expect(zb.writes.at(-1)!.claims).toMatchObject({ ce: true, cmd: "content.restoreVersion" });
      zb.calls.length = 0;
      const it2 = seed("svc.restore2");
      addVersion(it2, { slugLabel: "agency changed it" });
      const bad = await call("POST", `${S()}/items/${it2.itemId}/restore`, edA1, { version: 1, baseVersion: 2 });
      expect(bad.statusCode).toBe(422);
      expect(bad.json().issues[0].path).toBe("/blocks/0/props/slugLabel");
      noWrites();
    });

    it("preview: a client mints a preview link for their draft (ce:true); the link is the staff link", async () => {
      const it = seed("svc.preview");
      const r = await call("POST", `${S()}/items/${it.itemId}/preview`, edA1, {});
      expect(r.statusCode).toBe(200);
      expect(r.json().previewUrl).toMatch(/^https:\/\/staging\.gaiada\.test\/preview\/#t=/);
      expect(zb.writes.at(-1)!.claims).toMatchObject({ ce: true, cmd: "content.previewToken" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("D62 — a client may publish only what a client could have changed", () => {
    /** A live item whose draft (v2) differs from the live v1 by `patch`. */
    function draftOnLive(slug: string, patch: Record<string, unknown>, seo?: Record<string, unknown>): FakeItem {
      const it = seed(slug, { published: true });
      addVersion(it, patch, seo);
      return it;
    }
    const request = (items: Array<{ itemId: string; version: number }>, site = S()) => call("POST", `${site}/publish-requests`, edA1, { items });

    it("a draft that changes only editable fields files ONE approval (202) with the client on the row (control)", async () => {
      const it = draftOnLive("svc.pub-ok", { h1: "Better headline" });
      const r = await request([{ itemId: it.itemId, version: 2 }]);
      expect(r.statusCode).toBe(202);
      expect(r.json()).toMatchObject({ command: "content.publish", itemCount: 1 });
      const row = await approvalRow(r.json().approvalId);
      expect(row).toMatchObject({ status: "pending", requested_by: edA1 });
      expect(row.tool_args).toMatchObject({ command: "content.publish", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, clientId: cA1 });
      expect(zb.writes).toEqual([]); // filing never publishes
    });

    it("a draft that ALSO carries an agency change to a protected field is 422 publish-not-client-editable; nothing is filed or sent", async () => {
      const it = draftOnLive("svc.pub-bad", { h1: "Client headline", slugLabel: "agency changed this" });
      zb.calls.length = 0;
      const r = await request([{ itemId: it.itemId, version: 2 }]);
      expect(r.statusCode).toBe(422);
      expect(r.json()).toMatchObject({ type: expect.stringContaining("/errors/publish-not-client-editable"), total: 1, issues: [{ path: "/items/0/blocks/0/props/slugLabel" }] });
      expect(await approvalCount()).toBe(0);
      noWrites();
    });

    it("any seo change in the draft is refused too; re-publishing what is already live is a no-change publish and is allowed", async () => {
      const seoChanged = draftOnLive("svc.pub-seo", { h1: "ok" }, { title: "Agency retitled it" });
      const r = await request([{ itemId: seoChanged.itemId, version: 2 }]);
      expect(r.statusCode).toBe(422);
      expect(r.json().issues.map((i: { path: string }) => i.path)).toEqual(["/items/0/seo/title"]);
      const live = seed("svc.pub-same", { published: true });
      expect((await request([{ itemId: live.itemId, version: 1 }])).statusCode).toBe(202);
    });

    it("a BATCH with one bad item publishes none: the whole request is refused and the bad item's index is in the pointer", async () => {
      const good = draftOnLive("svc.pub-b1", { h1: "fine" });
      const bad = draftOnLive("svc.pub-b2", { slugLabel: "agency" + "!" });
      const r = await request([{ itemId: good.itemId, version: 2 }, { itemId: bad.itemId, version: 2 }]);
      expect(r.statusCode).toBe(422);
      expect(r.json().issues.map((i: { path: string }) => i.path)).toEqual(["/items/1/blocks/0/props/slugLabel"]);
      expect(await approvalCount()).toBe(0);
    });

    it("a NEVER-published item is judged against an empty baseline: a non-editable value in it blocks a client publish", async () => {
      const fresh = seed("svc.pub-fresh"); // draft v1, slugLabel "agency" is a non-empty non-editable value
      const r = await request([{ itemId: fresh.itemId, version: 1 }]);
      expect(r.statusCode).toBe(422);
      expect(r.json().issues.some((i: { path: string }) => i.path.startsWith("/items/0/"))).toBe(true);
      const clientMade = seed("svc.pub-fresh2", { fields: { h1: "only editable", intro: "x" }, seo: {}, blocks: [] });
      expect((await request([{ itemId: clientMade.itemId, version: 1 }])).statusCode).toBe(202);
    });

    it("a deleted item cannot be published (409), and a schedule is 403 client-command-not-allowed with nothing filed (control: the plain request)", async () => {
      const it = draftOnLive("svc.pub-del", { h1: "x" });
      expect((await request([{ itemId: it.itemId, version: 2 }])).statusCode).toBe(202);
      await clearApprovals();
      const sched = await call("POST", `${S()}/publish-requests`, edA1, { items: [{ itemId: it.itemId, version: 2 }], publishAt: new Date(Date.now() + 3_600_000).toISOString() });
      expect(sched.statusCode).toBe(403);
      expect(slugOf(sched)).toBe("client-command-not-allowed");
      expect(await approvalCount()).toBe(0);
      it.deletedAt = new Date().toISOString();
      const del = await request([{ itemId: it.itemId, version: 2 }]);
      expect(del.statusCode).toBe(409);
      expect(slugOf(del)).toBe("item-deleted");
    });

    it("the pre-check runs AGAIN at approval: a request that was fine when filed is refused (422) if the live page moved under it, and stays pending", async () => {
      const it = draftOnLive("svc.pub-moved", { h1: "client edit" });
      const filed = await request([{ itemId: it.itemId, version: 2 }]);
      expect(filed.statusCode).toBe(202);
      // meanwhile the agency published a v3 that changed a protected field, and the live page is now v3
      addVersion(it, { slugLabel: "agency published this" });
      it.publishedVersion = 3;
      zb.calls.length = 0;
      const r = await call("POST", `${W()}/publish-requests/${filed.json().approvalId}/approve`, ed2A1, {});
      expect(r.statusCode).toBe(422);
      expect(slugOf(r)).toBe("publish-not-client-editable");
      expect((await approvalRow(filed.json().approvalId)).status).toBe("pending");
      expect(zb.writes.map((c) => c.command)).not.toContain("content.publish");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("D58 — one item: publish yourself; a batch needs a second client editor", () => {
    const draft = (slug: string) => {
      const it = seed(slug, { published: true });
      addVersion(it, { h1: `${slug} edited` });
      return it;
    };
    const file = async (who: string, items: FakeItem[]) => {
      const r = await call("POST", `${S()}/publish-requests`, who, { items: items.map((i) => ({ itemId: i.itemId, version: i.headVersion })) });
      expect(r.statusCode, r.body).toBe(202);
      return r.json().approvalId as string;
    };
    const approve = (who: string, id: string, client = cA1) => call("POST", `${W(client)}/publish-requests/${id}/approve`, who, {});
    const publishCall = () => zb.calls.filter((c) => c.command === "content.publish");

    it("SELF-PUBLISH one item they requested: the two-step route (request, then approve as the same person) publishes, signed ce:true with the filed hash", async () => {
      const it = draft("svc.self2");
      const id = await file(edA1, [it]);
      const r = await approve(edA1, id);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ approvalId: id, status: "approved", executionStatus: "executed", selfPublish: true, items: [{ itemId: it.itemId, version: 2 }] });
      expect(it.publishedVersion).toBe(2);
      const p = publishCall();
      expect(p).toHaveLength(1);
      expect(p[0].hadWs4).toBe(true);
      expect(p[0].claims).toMatchObject({ ce: true, sub: edA1, req: edA1, apr: id, cmd: "content.publish" });
      expect(await approvalRow(id)).toMatchObject({ status: "approved", execution_status: "executed" });
      // the response is the client's view: no staging-rebuild internals
      expect(r.json()).not.toHaveProperty("build");
      expect(r.json()).not.toHaveProperty("rebuild");
    });

    it("SELF-PUBLISH in ONE call: POST …/items/:id/publish files and approves it; the head version is the default", async () => {
      const it = draft("svc.self1");
      const r = await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ status: "approved", executionStatus: "executed", selfPublish: true });
      expect(it.publishedVersion).toBe(2);
      expect(publishCall()[0].claims).toMatchObject({ ce: true, sub: edA1 });
      // one approval, no staff "approval requested" noise is not asserted here: the row is decided
      expect(await approvalCount()).toBe(1);
    });

    it("self-publish refuses a protected change (D62, 422) and leaves NO approval behind", async () => {
      const it = seed("svc.self-bad", { published: true });
      addVersion(it, { slugLabel: "agency" + "?" });
      const r = await call("POST", `${S()}/items/${it.itemId}/publish`, edA1, {});
      expect(r.statusCode).toBe(422);
      expect(await approvalCount()).toBe(0);
      expect(publishCall()).toHaveLength(0);
    });

    it("a BATCH: the requester CANNOT approve their own (403, Cerbos), the request stays pending and nothing is sent; ANOTHER client editor of the same client can (positive control)", async () => {
      const a = draft("svc.batch-a");
      const b = draft("svc.batch-b");
      const id = await file(edA1, [a, b]);
      const self = await approve(edA1, id);
      expect(self.statusCode).toBe(403);
      expect(await approvalRow(id)).toMatchObject({ status: "pending" });
      expect(publishCall()).toHaveLength(0);

      const other = await approve(ed2A1, id);
      expect(other.statusCode, other.body).toBe(200);
      expect(other.json()).toMatchObject({ status: "approved", executionStatus: "executed", selfPublish: false });
      expect(a.publishedVersion).toBe(2);
      expect(b.publishedVersion).toBe(2);
      expect(publishCall()[0].claims).toMatchObject({ ce: true, sub: ed2A1, req: edA1, apr: id });
    });

    it("an editor of ANOTHER client cannot approve it (403 on this client's route, 404 on their own), and a request is single-use (409 the second time)", async () => {
      const id = await file(edA1, [draft("svc.cross-a"), draft("svc.cross-b")]);
      expect((await approve(edA2, id, cA1)).statusCode).toBe(403);
      expect((await approve(edA2, id, cA2)).statusCode).toBe(404);
      expect(publishCall()).toHaveLength(0);
      expect((await approve(ed2A1, id)).statusCode).toBe(200);
      expect((await approve(ed2A1, id)).statusCode).toBe(409);
      expect(publishCall()).toHaveLength(1);
    });

    it("a request STAFF filed is not the client's to approve (404, positive control: staff's own approval path is the staff inbox) and never appears in the client's list", async () => {
      const it = draft("svc.staff-filed");
      const filed = await call("POST", `${STAFF()}/publish-requests`, staffManager, { items: [{ itemId: it.itemId, version: 2 }] });
      expect(filed.statusCode).toBe(202);
      const mine = await file(edA1, [draft("svc.mine")]);
      const list = await call("GET", `${W()}/publish-requests`, ed2A1);
      expect(list.statusCode).toBe(200);
      expect(list.json().requests.map((r: { approvalId: string }) => r.approvalId)).toEqual([mine]);
      const r = await approve(ed2A1, filed.json().approvalId);
      expect(r.statusCode).toBe(404);
      expect(publishCall()).toHaveLength(0);
    });

    it("the client's request list: every client editor's requests, with who asked and whether THIS caller can approve (a hint; Cerbos decides)", async () => {
      const single = await file(edA1, [draft("svc.l1")]);
      const batch = await file(edA1, [draft("svc.l2"), draft("svc.l3")]);
      const asRequester = (await call("GET", `${W()}/publish-requests`, edA1)).json().requests as Array<Record<string, unknown>>;
      const byId = (rows: Array<Record<string, unknown>>, id: string) => rows.find((r) => r.approvalId === id) as Record<string, unknown>;
      expect(byId(asRequester, single)).toMatchObject({ status: "pending", itemCount: 1, requestedByMe: true, canApprove: true, tenantSlug: GAIADA_SLUG });
      expect(byId(asRequester, batch)).toMatchObject({ itemCount: 2, requestedByMe: true, canApprove: false });
      const asOther = (await call("GET", `${W()}/publish-requests`, ed2A1)).json().requests as Array<Record<string, unknown>>;
      expect(byId(asOther, batch)).toMatchObject({ requestedByMe: false, canApprove: true, requestedBy: { userId: edA1 } });
      expect((await call("GET", `${W()}/publish-requests?status=approved`, ed2A1)).json().requests).toEqual([]);
      expect((await call("GET", `${W()}/publish-requests?status=bogus`, ed2A1)).statusCode).toBe(400);
      // the other client sees none of them
      expect((await call("GET", `${W(cA2)}/publish-requests`, edA2)).json().requests).toEqual([]);
    });

    it("withdraw: the REQUESTER cancels their own pending request (200); another client editor is 403, a decided request 409, another client's route 403/404; nothing is sent to WebDesk", async () => {
      const id = await file(edA1, [draft("svc.wd1"), draft("svc.wd2")]);
      const withdraw = (who: string, approvalId: string, client = cA1, slug = GAIADA_SLUG, siteId = GAIADA_SITE) =>
        call("POST", `${S(client, slug, siteId)}/publish-requests/${approvalId}/withdraw`, who, {});
      zb.calls.length = 0;
      expect((await withdraw(ed2A1, id)).statusCode).toBe(403); // another editor of the same client: not theirs to cancel
      expect((await withdraw(edA2, id)).statusCode).toBe(403); // another client's editor, this client's route: Cerbos
      expect((await withdraw(edA2, id, cA2, SLUG2, SITE2)).statusCode).toBe(404); // their own route and site: not their request
      expect((await approvalRow(id)).status).toBe("pending");
      const ok = await withdraw(edA1, id);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ approvalId: id, status: "cancelled" });
      expect((await approvalRow(id)).status).toBe("cancelled");
      expect((await withdraw(edA1, id)).statusCode).toBe(409);
      expect((await approve(ed2A1, id)).statusCode).toBe(409); // a cancelled request is not decidable (approval_not_pending)
      expect(zb.writes).toEqual([]);
    });

    it("a STAFF decision on a client-filed request does not notify the client requester (the staff inbox href would dangle); control: it still notifies a staff requester", async () => {
      const notified = async (user: string) =>
        Number((await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type LIKE 'automation_approval.%'`, [user])).rows[0].n);
      const before = await notified(edA1);
      const id = await file(edA1, [draft("svc.n1"), draft("svc.n2")]);
      const decided = await call("POST", `/api/${A}/automation-approvals/${id}/decide`, staffAdmin, { decision: "approved" });
      expect(decided.statusCode, decided.body).toBe(200);
      expect(decided.json()).toMatchObject({ webdesk: { executionStatus: "executed" } });
      expect(await notified(edA1)).toBe(before);
      // control: the same decision on a STAFF-filed request notifies its (staff) requester
      const staffBefore = await notified(staffManager);
      const it = draft("svc.n3");
      const filed = await call("POST", `${STAFF()}/publish-requests`, staffManager, { items: [{ itemId: it.itemId, version: 2 }] });
      expect((await call("POST", `/api/${A}/automation-approvals/${filed.json().approvalId}/decide`, staffAdmin, { decision: "approved" })).statusCode).toBe(200);
      expect(await notified(staffManager)).toBe(staffBefore + 1);
    });

    it("no notification the BFF emits links into /portal (the pages are WSK-49d's)", () => {
      for (const f of ["webdesk-client-website.service.ts", "webdesk-client-website.controller.ts", "webdesk-site-clients.service.ts", "webdesk-client-guard.ts", "webdesk-approved-command.ts"]) {
        const src = readFileSync(join(__dirname, f), "utf8");
        expect(/href:\s*[`'"]\/portal/.test(src), f).toBe(false);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the media library in client mode: read, upload token, update; never delete", () => {
    it("list / upload-token / update work for the editor, each signed ce:true (the token is shown once, in the response only)", async () => {
      const asset = zb.seedMedia({ siteId: GAIADA_SITE, title: "Hero" });
      expect((await call("GET", `${S()}/media`, edA1)).statusCode).toBe(200);
      const tok = await call("POST", `${S()}/media/upload-token`, edA1, { bucket: "media" });
      expect(tok.statusCode).toBe(201);
      expect(tok.headers["cache-control"]).toBe("no-store");
      expect(tok.json().uploadUrl).toMatch(/^https:\/\/webdesk\.example\.test\/v1\/t\/gaiada\/media\/upload\//);
      expect(zb.writes.at(-1)!.claims).toMatchObject({ ce: true, cmd: "media.uploadToken", sub: edA1 });
      const upd = await call("PATCH", `${S()}/media/${asset.assetId}`, edA1, { title: "Hero 2" });
      expect(upd.statusCode).toBe(200);
      expect(zb.writes.at(-1)!.claims).toMatchObject({ ce: true, cmd: "media.update" });
      expect(asset.title).toBe("Hero 2");
    });

    it("another client's site and an unlinked site are the uniform 404 for media too (control: their own)", async () => {
      expect((await call("GET", `${S()}/media`, edA1)).statusCode).toBe(200);
      zb.calls.length = 0;
      expect((await call("GET", `${S(cA1, SLUG2, SITE2)}/media`, edA1)).statusCode).toBe(404);
      expect((await call("POST", `${S(cA1, SLUG3, SITE3)}/media/upload-token`, edA1, { bucket: "media" })).statusCode).toBe(404);
      noEgress();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the `ce` claim: on EVERY client-mode write, absent on every staff write", () => {
    it("every write a client editor makes is signed with ce:true; the same operations by STAFF carry no ce at all", async () => {
      // ── a client run through every immediate write + a publish ──
      const it = seed("svc.ce");
      const asset = zb.seedMedia({ siteId: GAIADA_SITE });
      await call("POST", `${S()}/collections/service/items`, edA1, { locale: "en", slug: "service.ce-new", fields: { h1: "x" } });
      await call("PUT", `${S()}/items/${it.itemId}`, edA1, updateBody(it, goodFields));
      addVersion(it, { h1: "again" });
      await call("POST", `${S()}/items/${it.itemId}/restore`, edA1, { version: 1, baseVersion: it.headVersion });
      await call("POST", `${S()}/items/${it.itemId}/preview`, edA1, {});
      await call("POST", `${S()}/media/upload-token`, edA1, { bucket: "media" });
      await call("PATCH", `${S()}/media/${asset.assetId}`, edA1, { title: "t" });
      const clientMade = seed("svc.ce-pub", { fields: { h1: "only editable", intro: "x" }, seo: {}, blocks: [] });
      await call("POST", `${S()}/items/${clientMade.itemId}/publish`, edA1, {});
      const clientWrites = zb.writes.map((w) => w.command);
      expect(clientWrites).toEqual(expect.arrayContaining(["content.create", "content.update", "content.restoreVersion", "content.previewToken", "media.uploadToken", "media.update", "content.publish"]));
      for (const w of zb.writes) expect(w.claims, w.command).toMatchObject({ ce: true });

      // ── staff doing the same through the staff BFF ──
      zb.reset();
      const s = seed("svc.ce-staff");
      const asset2 = zb.seedMedia({ siteId: GAIADA_SITE });
      expect((await call("POST", `${STAFF()}/collections/service/items`, staffManager, { locale: "en", slug: "service.staff-new", fields: { h1: "x" } })).statusCode).toBe(201);
      expect((await call("PUT", `${STAFF()}/items/${s.itemId}`, staffManager, { baseVersion: 1, fields: { h1: "staff edit", slugLabel: "staff may" } })).statusCode).toBe(200);
      expect((await call("POST", `${STAFF()}/media/upload-token`, staffManager, { bucket: "media" })).statusCode).toBe(201);
      expect((await call("PATCH", `${STAFF()}/media/${asset2.assetId}`, staffManager, { title: "t" })).statusCode).toBe(200);
      expect(zb.writes.length).toBeGreaterThanOrEqual(4);
      for (const w of zb.writes) {
        expect(w.claims, w.command).toBeDefined();
        expect("ce" in (w.claims as object), `${w.command} must carry no ce`).toBe(false);
      }
      // a STAFF publish (decided in the staff inbox) carries none either
      const pub = seed("svc.ce-staff-pub");
      addVersion(pub, { h1: "x" });
      const filed = await call("POST", `${STAFF()}/publish-requests`, staffManager, { items: [{ itemId: pub.itemId, version: 2 }] });
      const decided = await call("POST", `/api/${A}/automation-approvals/${filed.json().approvalId}/decide`, staffAdmin, { decision: "approved" });
      expect(decided.statusCode, decided.body).toBe(200);
      const staffPublish = zb.calls.find((c) => c.command === "content.publish");
      expect(staffPublish?.claims).toBeDefined();
      expect("ce" in (staffPublish?.claims as object)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("the site -> client link (staff-managed)", () => {
    const put = (as: string, client: string, slug = SLUG3, siteId = SITE3) => call("PUT", `${STAFF(slug, siteId)}/client`, as, { clientId: client });
    const links = async () =>
      (await adminPool().query(`SELECT tenant_slug, site_id, client_id FROM webdesk_site_clients WHERE tenant_id = $1 ORDER BY tenant_slug`, [A])).rows;
    const audit = async (verb: string) =>
      (await adminPool().query(`SELECT actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = $2 ORDER BY occurred_at, id`, [A, verb])).rows;
    afterEach(async () => {
      await adminPool().query(`DELETE FROM webdesk_site_clients WHERE tenant_id = $1 AND tenant_slug = $2`, [A, SLUG3]);
    });

    it("a company admin links a site to a client of THIS company (200), audited once; linking again is a no-op; re-pointing is audited", async () => {
      const r = await put(staffAdmin, cA1);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ changed: true, previousClientId: null, link: { tenantSlug: SLUG3, siteId: SITE3, clientId: cA1, clientName: "Bali Beach Resort", linkedBy: staffAdmin } });
      expect((await audit("webdesk.site_client.linked"))).toHaveLength(1);
      const again = await put(staffAdmin, cA1);
      expect(again.json()).toMatchObject({ changed: false });
      expect((await audit("webdesk.site_client.linked"))).toHaveLength(1);
      const moved = await put(staffAdmin, cA2);
      expect(moved.json()).toMatchObject({ changed: true, previousClientId: cA1, link: { clientId: cA2 } });
      expect((await audit("webdesk.site_client.relinked"))[0].metadata).toMatchObject({ clientId: cA2, previousClientId: cA1 });
      // access follows the link: the old client's editor lost the site, the new one's gained it
      expect((await call("GET", `${S(cA1, SLUG3, SITE3)}/collections`, edA1)).statusCode).toBe(404);
      expect((await call("GET", `${S(cA2, SLUG3, SITE3)}/collections`, edA2)).statusCode).toBe(200);
    });

    it("authorization first: webdev_staff / member / a client editor / a client admin are denied with a VALID body; the manager and admin are allowed (controls)", async () => {
      for (const who of [staffEditor, staffMember, edA1, adminOnlyA1, viewerA1]) {
        expect((await put(who, cA1)).statusCode, `who=${who}`).toBe(403);
      }
      expect((await links()).map((l) => l.tenant_slug)).toEqual([SLUG2, GAIADA_SLUG]); // ordered by slug: client2, gaiada
      expect((await put(staffManager, cA1)).statusCode).toBe(200);
      expect((await call("GET", `${STAFF(SLUG3, SITE3)}/client`, staffEditor)).statusCode).toBe(200); // reads: the editor tier
      expect((await call("GET", `${STAFF(SLUG3, SITE3)}/client`, staffMember)).statusCode).toBe(403);
    });

    it("a client of ANOTHER company, an unknown client and a malformed id are refused; a site that is not this company's is the uniform 404; nothing is written", async () => {
      expect((await put(staffAdmin, cB1)).statusCode).toBe(404); // another company's client: RLS + the composite FK
      expect((await put(staffAdmin, randomUUID())).statusCode).toBe(404);
      expect((await put(staffAdmin, "not-a-uuid")).statusCode).toBe(400);
      expect((await put(staffAdmin, cA1, OTHER_SLUG, OTHER_SITE)).statusCode).toBe(404);
      expect((await call("PUT", `${STAFF(SLUG3, SITE3)}/client`, staffAdmin, { clientId: cA1, extra: 1 })).statusCode).toBe(400);
      expect(await links()).toHaveLength(2);
    });

    it("GET shows the link (or null); DELETE removes it and is audited once; the list shows the company's links", async () => {
      expect((await call("GET", `${STAFF(SLUG3, SITE3)}/client`, staffAdmin)).json()).toEqual({ link: null });
      await put(staffAdmin, cA1);
      expect((await call("GET", `${STAFF(SLUG3, SITE3)}/client`, staffAdmin)).json().link).toMatchObject({ clientId: cA1 });
      const list = await call("GET", `/api/${A}/modules/webdev/content/site-clients`, staffAdmin);
      expect(list.json().links.map((l: { tenantSlug: string }) => l.tenantSlug).sort()).toEqual([GAIADA_SLUG, SLUG2, SLUG3].sort());
      const del = await call("DELETE", `${STAFF(SLUG3, SITE3)}/client`, staffAdmin);
      expect(del.json()).toMatchObject({ changed: true, previousClientId: cA1 });
      expect((await call("DELETE", `${STAFF(SLUG3, SITE3)}/client`, staffAdmin)).json()).toMatchObject({ changed: false });
      expect(await audit("webdesk.site_client.unlinked")).toHaveLength(1);
    });

    it("the table's RLS: another company's tenant cannot see or write this company's links (the composite FK and the tenant wall)", async () => {
      const seen = await withTenants([B], (c) => c.query(`SELECT 1 FROM webdesk_site_clients`));
      expect(seen.rowCount).toBe(0);
      await expect(
        withTenants([B], (c) =>
          c.query(`INSERT INTO webdesk_site_clients (id, tenant_id, tenant_slug, site_id, client_id, origin_site) VALUES ($1, $2, 'x', $3, $4, 'central')`, [newId(), B, randomUUID(), cA1]),
        ),
      ).rejects.toThrow(); // client of company A under company B's tenant: the composite FK refuses
    });
  });
});
