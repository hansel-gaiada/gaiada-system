// WSK-359 — three follow-ups to the client-mode website BFF (`/api/:tenantId/portal/clients/:clientId/website/...`):
//   1. the client publish-request list carries the versions each request NAMED (`items:[{itemId, version}]`), not just ids;
//   2. author display labels on the client item / version / item-list reads (`authors: {<users.id>: <label>}`);
//   3. the client media list carries `capabilities` (delete is always false in client mode).
// (The rebuild state of a client publish, item 2 of the ticket, is asserted in `webdesk-client-rebuild.test.ts`, where the GitHub stub lives.)
//
// Real: Postgres (RLS, approval rows, the site -> client link, users / memberships / contacts), Cerbos (the real policies), the whole
// NestJS app. Stand-in: Zone B, the in-process FakeZoneB. Needs DATABASE_URL_TEST + CERBOS_URL.
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
import { authorIdsOf, clientBuild } from "./webdesk-client-website.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, makeTestSigner, type FakeItem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });
const SITE2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SLUG2 = "client2";

const SERVICE = {
  ui: { label: "Services" },
  fields: [{ name: "h1", primitive: "text", ui: { clientEditable: true } }, { name: "slugLabel", primitive: "text" }],
};

describe("pure helpers", () => {
  it("clientBuild keeps only the state and a typed token: anything else becomes `rebuild_failed`, never passed through", () => {
    expect(clientBuild({ state: "rebuilding", failureReason: null })).toEqual({ state: "rebuilding", failureReason: null });
    expect(clientBuild({ state: "failed", failureReason: "rebuild_not_configured" })).toEqual({ state: "failed", failureReason: "rebuild_not_configured" });
    expect(clientBuild({ state: "failed", failureReason: "https://github.com/org/repo" })).toEqual({ state: "failed", failureReason: "rebuild_failed" });
    expect(clientBuild({ state: "failed", failureReason: "org/repo@main" })).toEqual({ state: "failed", failureReason: "rebuild_failed" });
    expect(clientBuild({ state: "failed", failureReason: "" })).toEqual({ state: "failed", failureReason: null });
  });

  it("authorIdsOf reads version.createdBy, versions[].createdBy and items[].headCreatedBy, distinct and non-empty", () => {
    expect(authorIdsOf({ version: { createdBy: "a" } })).toEqual(["a"]);
    expect(authorIdsOf({ n: 3, createdBy: "a", blocks: [] })).toEqual(["a"]);
    expect(authorIdsOf({ versions: [{ createdBy: "a" }, { createdBy: "b" }, { createdBy: "a" }, { createdBy: null }] })).toEqual(["a", "b"]);
    expect(authorIdsOf({ items: [{ headCreatedBy: "c" }, { headCreatedBy: null }, {}] })).toEqual(["c"]);
    expect(authorIdsOf({})).toEqual([]);
  });
});

describe.skipIf(!live)("WSK-359 · client-mode follow-ups", () => {
  let app: NestFastifyApplication;
  let A: string; // the serving company
  let B: string; // another company
  let cA1: string, cA2: string;
  let edA1: string, ed2A1: string, edA2: string;
  let staffEditor: string, staffOfB: string, botA: string, strangerA: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const W = (client = cA1) => `/api/${A}/portal/clients/${client}/website`;
  const S = (client = cA1, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `${W(client)}/sites/${slug}/${siteId}`;
  const call = (method: "GET" | "POST", url: string, as: string, payload?: unknown) => app.inject({ method, url, headers: asUser(as), payload: payload as never });

  /** A published item whose draft (v2) changes only an editable field, so a client may publish it. */
  function draft(slug: string, siteId = GAIADA_SITE): FakeItem {
    const it = zb.seedItem({ siteId, slug, collectionKey: "service", publishedVersion: 1, publishState: "published" });
    it.versions[0] = { ...it.versions[0], fields: { h1: "Head", slugLabel: "agency" }, seo: {}, blocks: [], contentHash: "a".repeat(64) };
    it.versions.push({ ...it.versions[0], version: 2, fields: { h1: "Client edit", slugLabel: "agency" }, contentHash: "b".repeat(64) });
    it.headVersion = 2;
    return it;
  }
  const bump = (it: FakeItem, h1: string): void => {
    const n = it.versions.length + 1;
    it.versions.push({ ...it.versions[it.versions.length - 1], version: n, fields: { h1, slugLabel: "agency" }, contentHash: String(n).repeat(64).slice(0, 64) });
    it.headVersion = n;
  };
  const file = async (who: string, client: string, slug: string, siteId: string, items: Array<{ itemId: string; version: number }>) => {
    const r = await call("POST", `${S(client, slug, siteId)}/publish-requests`, who, { items });
    expect(r.statusCode, r.body).toBe(202);
    return r.json().approvalId as string;
  };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.webdeskPublic.baseUrl = "https://webdesk.example.test";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("WSK-359 Serving Co", ["webdev"]);
    B = await createCompany("WSK-359 Other Co", ["webdev"]);
    cA1 = await createClient(A, "Bali Beach Resort");
    cA2 = await createClient(A, "Nusa Coffee");
    const clientRole = await createRole("client");
    const editorRole = await createRole("client_website_editor");
    const mkClient = async (email: string, client: string, name: string) => {
      const u = await createUser(email, name);
      await withTenants([A], (c) =>
        c.query(`INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', $5)`, [newId(), A, client, u, config.originSite]),
      );
      await grantRole(u, clientRole, "company", A);
      await grantRole(u, editorRole, "client", client);
      return u;
    };
    edA1 = await mkClient("ed-a1@w359.test", cA1, "Ayu Wijaya");
    ed2A1 = await mkClient("ed2-a1@w359.test", cA1, "Made Sutra");
    edA2 = await mkClient("ed-a2@w359.test", cA2, "Coffee Person");
    staffEditor = await createUser("staff@w359.test", "Staff Personal Name");
    await addMembership(A, staffEditor);
    await grantRole(staffEditor, await createRole("webdev_staff"), "company", A);
    // A staff member of ANOTHER company only: not this company's staff, so a client sees "Someone else".
    staffOfB = await createUser("staff-b@w359.test", "Other Co Staff");
    await addMembership(B, staffOfB);
    // An automation account that is a member of A (the gaiada.com importer shape).
    botA = await createUser("bot@w359.test", "Content Importer");
    await addMembership(A, botA, "service");
    await adminPool().query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [botA]);
    // A user in no company at all.
    strangerA = await createUser("stranger@w359.test", "Total Stranger");

    zb = new FakeZoneB(A, B);
    zb.tenants.push({ companyRef: A, slug: SLUG2, status: "active", siteId: SITE2 });
    zb.compositions.set("service", SERVICE);
    for (const [slug, siteId, client] of [[GAIADA_SLUG, GAIADA_SITE, cA1], [SLUG2, SITE2, cA2]] as const) {
      await withTenants([A], (c) =>
        c.query(`INSERT INTO webdesk_site_clients (id, tenant_id, tenant_slug, site_id, client_id, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), A, slug, siteId, client, config.originSite]),
      );
    }
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    await adminPool().query(`DELETE FROM automation_approvals WHERE origin = 'webdesk' AND tenant_id = $1`, [A]);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("1 · the publish-request list carries the versions each request named", () => {
    it("`items:[{itemId, version}]` is the requested version, NOT the item's current head; `itemIds` is unchanged", async () => {
      const a = draft("svc.one");
      const b = draft("svc.two");
      const id = await file(edA1, cA1, GAIADA_SLUG, GAIADA_SITE, [{ itemId: a.itemId, version: 2 }, { itemId: b.itemId, version: 1 }]);
      bump(a, "moved on"); // the head is now v3: the request still names v2
      expect(a.headVersion).toBe(3);

      const r = await call("GET", `${W()}/publish-requests`, ed2A1);
      expect(r.statusCode, r.body).toBe(200);
      const row = (r.json().requests as Array<Record<string, unknown>>).find((x) => x.approvalId === id)!;
      expect(row).toBeDefined();
      expect(row.itemIds).toEqual([a.itemId, b.itemId]);
      expect(row.items).toEqual([{ itemId: a.itemId, version: 2 }, { itemId: b.itemId, version: 1 }]);
      expect(row.itemCount).toBe(2);
    });

    it("NEGATIVE CONTROL: another client's request is still invisible, in both directions, and so is its version list", async () => {
      const mine = draft("svc.mine");
      const theirs = draft("svc.theirs", SITE2);
      const idMine = await file(edA1, cA1, GAIADA_SLUG, GAIADA_SITE, [{ itemId: mine.itemId, version: 2 }]);
      const idTheirs = await file(edA2, cA2, SLUG2, SITE2, [{ itemId: theirs.itemId, version: 2 }]);

      const one = await call("GET", `${W(cA1)}/publish-requests?status=all`, edA1);
      expect(one.statusCode).toBe(200);
      expect((one.json().requests as Array<{ approvalId: string }>).map((x) => x.approvalId)).toEqual([idMine]);
      expect(one.body).not.toContain(theirs.itemId);

      const two = await call("GET", `${W(cA2)}/publish-requests?status=all`, edA2);
      expect((two.json().requests as Array<{ approvalId: string; items: unknown[] }>).map((x) => x.approvalId)).toEqual([idTheirs]);
      expect(two.body).not.toContain(mine.itemId);

      // Asking for the other client's list is refused outright (Cerbos: the grant is for cA1 only).
      expect((await call("GET", `${W(cA2)}/publish-requests`, edA1)).statusCode).toBe(403);
    });

    it("a request row whose stored items carry no usable version still lists its ids (items is simply shorter), never a guessed version", async () => {
      const a = draft("svc.legacy");
      const id = await file(edA1, cA1, GAIADA_SLUG, GAIADA_SITE, [{ itemId: a.itemId, version: 2 }]);
      await adminPool().query(
        `UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{items}', jsonb_build_array(jsonb_build_object('itemId', $2::text))) WHERE id = $1`,
        [id, a.itemId],
      );
      const r = await call("GET", `${W()}/publish-requests`, edA1);
      const row = (r.json().requests as Array<Record<string, unknown>>).find((x) => x.approvalId === id)!;
      expect(row.itemIds).toEqual([a.itemId]);
      expect(row.items).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("3 · author labels on the client reads (resolved server-side, in the request's tenant)", () => {
    /** One item whose five versions were written by five kinds of author (plus a non-uuid, which is what a bare seed row holds). */
    function authored(): FakeItem {
      const it = draft("svc.authored");
      const authors = [edA1, staffEditor, botA, staffOfB, strangerA, "seed", edA2];
      it.versions = authors.map((createdBy, i) => ({
        version: i + 1, fields: { h1: `v${i + 1}`, slugLabel: "agency" }, contentHash: String(i + 1).repeat(64).slice(0, 64), createdBy,
        createdAt: new Date(2026, 9, 1 + i).toISOString(), note: null, seo: {}, blocks: [],
      }));
      it.headVersion = authors.length;
      it.publishedVersion = 1;
      return it;
    }
    const EXPECTED = (): Record<string, string> => ({
      [edA1]: "Ayu Wijaya", // a contact of the SAME client: their name
      [staffEditor]: "Gaiada", // staff of the serving company: the label, never the personal name
      [botA]: "Content Importer", // an automation account: its name
      [staffOfB]: "Someone else", // staff of ANOTHER company
      [strangerA]: "Someone else", // in no company
      seed: "Someone else", // not a uuid
      [edA2]: "Someone else", // a contact of ANOTHER client
    });

    it("the versions list: every author id has a label, by the four rules", async () => {
      const it = authored();
      const r = await call("GET", `${S()}/items/${it.itemId}/versions`, edA1);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().authors).toEqual(EXPECTED());
      expect((r.json().versions as unknown[]).length).toBe(7);
    });

    it("a colleague from the same client is named for the viewer too (not only for themselves)", async () => {
      const it = authored();
      const r = await call("GET", `${S()}/items/${it.itemId}/versions`, ed2A1);
      expect(r.json().authors[edA1]).toBe("Ayu Wijaya");
    });

    it("item.get: the head author; version.get: that version's author; the item list: each item's head author", async () => {
      const it = authored();
      const head = await call("GET", `${S()}/items/${it.itemId}`, edA1);
      expect(head.statusCode, head.body).toBe(200);
      expect(head.json().authors).toEqual({ [edA2]: "Someone else" }); // v7's author is the other client's contact
      const v3 = await call("GET", `${S()}/items/${it.itemId}/versions/3`, edA1);
      expect(v3.json().authors).toEqual({ [botA]: "Content Importer" });
      const v2 = await call("GET", `${S()}/items/${it.itemId}/versions/2`, edA1);
      expect(v2.json().authors).toEqual({ [staffEditor]: "Gaiada" });
      const list = await call("GET", `${S()}/collections/service/items`, edA1);
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().authors).toEqual({ [edA2]: "Someone else" });
    });

    it("PRIVACY: no staff personal name, email or id-to-name leak anywhere in a client read that names a staff author", async () => {
      const it = authored();
      for (const url of [`${S()}/items/${it.itemId}/versions`, `${S()}/items/${it.itemId}/versions/2`]) {
        const r = await call("GET", url, edA1);
        expect(r.body).not.toContain("Staff Personal Name");
        expect(r.body).not.toContain("staff@w359.test");
        expect(r.body).not.toContain("Other Co Staff");
        expect(r.body).not.toContain("Total Stranger");
        expect(r.body).not.toContain("Coffee Person");
      }
    });

    it("a body naming no author (a never-edited legacy row) gets no `authors` key and costs no query", async () => {
      const it = zb.seedItem({ siteId: GAIADA_SITE, slug: "svc.legacy-head", collectionKey: "service" });
      it.headVersion = 0;
      it.versions = [];
      const list = await call("GET", `${S()}/collections/service/items`, edA1);
      expect(list.statusCode, list.body).toBe(200);
      expect("authors" in list.json()).toBe(false);
    });

    it("a staff user who is ALSO a contact of this client reads as their own name (the contact rule wins), and one removed from the company is 'Someone else'", async () => {
      const dual = await createUser("dual@w359.test", "Dual Role");
      await addMembership(A, dual);
      await withTenants([A], (c) =>
        c.query(`INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site) VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', $5)`, [newId(), A, cA1, dual, config.originSite]),
      );
      const gone = await createUser("gone@w359.test", "Gone Staff");
      await addMembership(A, gone);
      await adminPool().query(`UPDATE company_memberships SET deleted_at = now() WHERE tenant_id = $1 AND user_id = $2`, [A, gone]);
      const it = draft("svc.dual");
      it.versions[0] = { ...it.versions[0], createdBy: dual };
      it.versions[1] = { ...it.versions[1], createdBy: gone };
      const r = await call("GET", `${S()}/items/${it.itemId}/versions`, edA1);
      expect(r.json().authors).toEqual({ [dual]: "Dual Role", [gone]: "Someone else" });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("4 · the client media list carries capabilities", () => {
    it("a client editor: read, upload and update are true; delete is false (a client never deletes media)", async () => {
      zb.seedMedia({ siteId: GAIADA_SITE, title: "Hero" });
      const r = await call("GET", `${S()}/media`, edA1);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().capabilities).toEqual({ read: true, upload: true, update: true, delete: false });
      expect((r.json().assets as unknown[]).length).toBe(1);
    });

    it("advisory, not authority: the same editor's upload and update succeed as the capabilities say; a denied caller gets no capabilities at all", async () => {
      const a = zb.seedMedia({ siteId: GAIADA_SITE, title: "Hero" });
      expect((await call("POST", `${S()}/media/upload-token`, edA1, { bucket: "media" })).statusCode).toBe(201);
      expect((await call("POST", `${S()}/media/upload-token`, ed2A1, { bucket: "media" })).statusCode).toBe(201);
      expect(((await app.inject({ method: "PATCH", url: `${S()}/media/${a.assetId}`, headers: asUser(edA1), payload: { title: "T" } })).statusCode)).toBe(200);
      const denied = await call("GET", `${S()}/media`, staffEditor);
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain("capabilities");
      // The other client's editor cannot read THIS client's library (and so gets no capabilities for it either).
      const other = await call("GET", `${S(cA1)}/media`, edA2);
      expect(other.statusCode).toBe(403);
    });
  });
});

