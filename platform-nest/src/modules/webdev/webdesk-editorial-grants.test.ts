// M5-W1b — the writers' room grant routes over the REAL surface (`app.inject`), and the generic grant surfaces'
// refusals (docs/plans/2026-10-11-m5-writers-room-design.md §2.5, §2.6, §9 row W1b).
//
// Real: Postgres (RLS, the grant + scope rows, the audit ledger, session_version), Cerbos (the W1a policies:
// `webdesk_collection:manage_editorial`, and the writers' room derived roles for the after-grant probes), the full NestJS
// app. Stand-in: Zone B, the in-process FakeZoneB (its `tenant.list` filters by companyRef like the real SQL, and it
// records every call, so "no egress for a denied caller" is asserted on what was actually sent).
//
// DENIAL TESTS SEND VALID BODIES, each beside a positive control on the same route (the "validation pre-empts authz"
// trap). Needs DATABASE_URL_TEST + CERBOS_URL. NOT RUN LOCALLY (owner order: no docker on the laptop); the Linux gate.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal } from "../../rbac/principal";
import { check } from "../../rbac/cerbos";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const ORG_BLOB = {
  root: {
    id: "d-corp", name: "Corp", kind: "company", assigneeId: null, assigneeName: null,
    children: [{ id: "d-web", name: "Web", kind: "department", assigneeId: null, assigneeName: null, children: [] }],
  },
};

describe.skipIf(!live)("M5-W1b · writers' room grants over HTTP", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let admin: string, publisher: string, staffEditor: string, coManager: string, member: string, scopedEditor: string, adminB: string;
  let writerA: string, translatorA: string, onlyInB: string;
  let writerRoleId: string, memberRoleId: string, managerRoleId: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const BASE = (slug = GAIADA_SLUG, site = GAIADA_SITE, tenant = A) => `/api/${tenant}/modules/webdev/content/sites/${slug}/${site}/editorial/grants`;
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, as: string, payload?: unknown) =>
    app.inject({ method, url, headers: asUser(as), ...(payload !== undefined ? { payload: payload as never } : {}) });
  const validGrant = (userId: string, over: Record<string, unknown> = {}) => ({
    userId, role: "webdesk_writer", collections: ["post"], locales: ["en"], ...over,
  });
  const grantRows = async (userId: string) =>
    (await adminPool().query<{ role: string; site_id: string | null; collections: string[] | null }>(
      `SELECT r.name AS role, s.site_id, s.collections FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         LEFT JOIN user_role_editorial_scopes s ON s.user_role_id = ur.id
        WHERE ur.user_id = $1 AND r.name LIKE 'webdesk\\_%'`,
      [userId],
    )).rows;
  const sessionVersion = async (userId: string) =>
    Number((await adminPool().query(`SELECT session_version FROM users WHERE id = $1`, [userId])).rows[0].session_version);
  const audits = async (verb: string) =>
    (await adminPool().query<{ actor_id: string; target_entity_type: string; target_entity_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_id, target_entity_type, target_entity_id, metadata FROM activities WHERE tenant_id = $1 AND verb = $2 ORDER BY occurred_at`,
      [A, verb],
    )).rows;
  const noEgress = () => expect(zb.calls.map((c) => c.command)).toEqual([]);
  const contentRead = (collectionKey: string, siteId = GAIADA_SITE) =>
    ({ kind: "webdesk_content_item", tenantId: A, module: "webdev", id: "11111111-2222-4333-8444-555555555555", siteId, collectionKey, locale: "id" }) as const;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("W1b Serving Co", ["webdev", "hr", "reports"]);
    B = await createCompany("W1b Other Co", ["webdev"]);
    const staff = async (email: string, role: string | null, tenant = A) => {
      const u = await createUser(email);
      await addMembership(tenant, u);
      if (role) await grantRole(u, await createRole(role), "company", tenant);
      return u;
    };
    admin = await staff("admin@w1b-http.test", "company_admin");
    publisher = await staff("publisher@w1b-http.test", "webdev_manager");
    staffEditor = await staff("editor@w1b-http.test", "webdev_staff");
    coManager = await staff("manager@w1b-http.test", "manager");
    member = await staff("member@w1b-http.test", "member");
    adminB = await staff("admin-b@w1b-http.test", "company_admin", B);
    writerA = await staff("writer@w1b-http.test", "member");
    translatorA = await staff("translator@w1b-http.test", "member");
    onlyInB = await staff("only-b@w1b-http.test", "member", B);
    // A scoped webdesk_editor on THIS site (a writers' room role does not carry manage_editorial).
    scopedEditor = await staff("scoped-editor@w1b-http.test", "member");
    writerRoleId = await createRole("webdesk_writer");
    memberRoleId = await createRole("member");
    managerRoleId = await createRole("manager");
    const editorRoleId = await createRole("webdesk_editor");
    await grantRole(scopedEditor, editorRoleId, "company", A);
    const edGrant = (await adminPool().query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [scopedEditor, editorRoleId])).rows[0].id;
    await adminPool().query(
      `INSERT INTO user_role_editorial_scopes (user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
       VALUES ($1, $2, $3, $4, true, '{}', true, '{}', $5)`,
      [edGrant, A, GAIADA_SLUG, GAIADA_SITE, config.originSite],
    );

    zb = new FakeZoneB(A, B);
    zb.compositions.set("post", { ui: { label: "Posts" } });
    zb.compositions.set("guide", { ui: { label: "Guides" } });
    app = await buildApp();
    const org = await call("PUT", `/api/${A}/org-structure`, admin, ORG_BLOB);
    expect(org.statusCode).toBe(200);
  }, 120_000);

  beforeEach(() => {
    zb.reset();
    zb.failWith = null;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
  });
  afterAll(async () => {
    setWebdeskApprovedCommandDepsForTests(null);
    await app?.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  describe("authorization comes first: a denied caller gets 403 for a VALID body, and nothing is read or written", () => {
    it.each([
      ["webdev_staff (the unscoped editor tier)", () => staffEditor],
      ["manager (no manage_editorial)", () => coManager],
      ["member", () => member],
      ["a scoped webdesk_editor on this very site", () => scopedEditor],
      ["company B's admin on company A's path", () => adminB],
    ])("%s: POST, GET and DELETE are 403", async (_l, who) => {
      const before = await grantRows(writerA);
      expect((await call("POST", BASE(), who(), validGrant(writerA))).statusCode).toBe(403);
      expect((await call("GET", BASE(), who())).statusCode).toBe(403);
      expect((await call("DELETE", `${BASE()}/${writerA}/webdesk_writer`, who())).statusCode).toBe(403);
      noEgress();
      expect(await grantRows(writerA)).toEqual(before);
    });
  });

  describe("grant → the principal → revoke, as company_admin and as webdev_manager", () => {
    it("POST grants role + scope atomically, audits identifiers only, bumps the session; the writer can then read in scope", async () => {
      const sv = await sessionVersion(writerA);
      const res = await call("POST", BASE(), admin, validGrant(writerA, { collections: ["post"], allLocales: true, locales: undefined }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({
        userId: writerA, role: "webdesk_writer", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE,
        allCollections: false, collections: ["post"], allLocales: true, locales: [], expiresAt: null,
        changed: true, createdGrant: true,
      });
      expect(await grantRows(writerA)).toEqual([{ role: "webdesk_writer", site_id: GAIADA_SITE, collections: ["post"] }]);
      expect(await sessionVersion(writerA)).toBe(sv + 1);
      // the proof came from WebDesk: the wall, then the site's collections; nothing was written there
      expect(zb.calls.map((c) => c.command)).toEqual(["tenant.list", "collection.list"]);
      expect(zb.writes).toEqual([]);
      const [a] = await audits("webdesk.editorial.role_granted");
      expect(a).toMatchObject({ actor_id: admin, target_entity_type: "user_role", target_entity_id: res.json().grantId });
      expect(a.metadata).toMatchObject({ role: "webdesk_writer", siteId: GAIADA_SITE, targetUserId: writerA, collections: ["post"], allLocales: true });
      expect(JSON.stringify(a.metadata)).not.toContain("@w1b-http.test"); // identifiers only, never an email

      // The grant now reaches Cerbos through assemblePrincipal(): in scope ALLOW, other collection / site DENY.
      const p = (await assemblePrincipal(writerA, "high"))!;
      expect((await check(p, contentRead("post"), "read")).allow).toBe(true);
      expect((await check(p, contentRead("guide"), "read")).allow).toBe(false);
      expect((await check(p, contentRead("post", OTHER_SITE), "read")).allow).toBe(false);

      // GET lists it
      const list = await call("GET", BASE(), admin);
      expect(list.statusCode).toBe(200);
      expect(list.json().grants.find((g: { userId: string }) => g.userId === writerA)).toMatchObject({
        role: "webdesk_writer", siteId: GAIADA_SITE, collections: ["post"], allLocales: true,
      });
    });

    it("re-posting the same grant is a 200 no-op (changed:false): no second audit row, no session bump", async () => {
      const sv = await sessionVersion(writerA);
      const n = (await audits("webdesk.editorial.role_granted")).length;
      const res = await call("POST", BASE(), admin, validGrant(writerA, { collections: ["post"], allLocales: true, locales: undefined }));
      expect(res.json()).toMatchObject({ changed: false, createdGrant: false });
      expect((await audits("webdesk.editorial.role_granted")).length).toBe(n);
      expect(await sessionVersion(writerA)).toBe(sv);
    });

    it("webdev_manager may grant too (the publisher tier holds manage_editorial)", async () => {
      const res = await call("POST", BASE(), publisher, validGrant(translatorA, { role: "webdesk_translator", locales: ["id"] }));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ role: "webdesk_translator", locales: ["id"], changed: true });
    });

    it("DELETE revokes on this site (the last site takes the grant), audits, bumps the session; again is a no-op; WebDesk is not consulted", async () => {
      zb.failWith = new Error("WebDesk is down"); // a de-escalation must not wait for WebDesk
      const sv = await sessionVersion(writerA);
      const res = await call("DELETE", `${BASE()}/${writerA}/webdesk_writer`, admin);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ userId: writerA, role: "webdesk_writer", siteId: GAIADA_SITE, changed: true, removedGrant: true });
      expect(await grantRows(writerA)).toEqual([]);
      expect(await sessionVersion(writerA)).toBe(sv + 1);
      expect((await audits("webdesk.editorial.role_revoked")).at(-1)).toMatchObject({ actor_id: admin, metadata: { targetUserId: writerA, removedGrant: true } });
      expect((await assemblePrincipal(writerA, "high"))!.roles.some((g) => g.role === "webdesk_writer")).toBe(false);
      const again = await call("DELETE", `${BASE()}/${writerA}/webdesk_writer`, admin);
      expect(again.json()).toMatchObject({ changed: false, removedGrant: false });
      noEgress();
    });
  });

  describe("what the grant path refuses (each beside the positive controls above)", () => {
    it("another company's site: the uniform 404 site-not-found, nothing written", async () => {
      const res = await call("POST", BASE(OTHER_SLUG, OTHER_SITE), admin, validGrant(writerA));
      expect(res.statusCode).toBe(404);
      expect(String(res.json().type)).toMatch(/site-not-found$/);
      expect(await grantRows(writerA)).toEqual([]);
    });

    it("an unknown collection or locale: 400, nothing written", async () => {
      const c = await call("POST", BASE(), admin, validGrant(writerA, { collections: ["case-study"] }));
      expect(c.statusCode).toBe(400);
      expect(c.json().error).toMatch(/^unknown_collection/);
      const l = await call("POST", BASE(), admin, validGrant(writerA, { locales: ["fr"] }));
      expect(l.statusCode).toBe(400);
      expect(l.json().error).toMatch(/^unknown_locale/);
      expect(await grantRows(writerA)).toEqual([]);
    });

    it("a self-grant, a target outside this company, a role outside the four: 400", async () => {
      expect((await call("POST", BASE(), admin, validGrant(admin))).json().error).toMatch(/self_grant_forbidden/);
      expect((await call("POST", BASE(), admin, validGrant(onlyInB))).json().error).toMatch(/editorial_target_not_eligible/);
      const r = await call("POST", BASE(), admin, validGrant(writerA, { role: "webdev_manager" }));
      expect(r.statusCode).toBe(400);
      expect(await grantRows(admin)).toEqual([]);
      expect(await grantRows(onlyInB)).toEqual([]);
    });

    it("an empty list never means 'all', and an unknown body key is refused (strict body, AFTER authorization)", async () => {
      expect((await call("POST", BASE(), admin, validGrant(writerA, { collections: [] }))).statusCode).toBe(400);
      expect((await call("POST", BASE(), admin, validGrant(writerA, { scopeType: "global" }))).statusCode).toBe(400);
      expect(await grantRows(writerA)).toEqual([]);
    });

    it("the MCP tool's request shape (the hub strips path args into the URL, the rest is the body) is accepted as-is", async () => {
      const args = { tenantId: A, tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, userId: writerA, role: "webdesk_editor", allCollections: true, allLocales: true };
      const { tenantId: _t, tenantSlug: _s, siteId: _i, ...body } = args;
      const res = await call("POST", BASE(), admin, body);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ role: "webdesk_editor", allCollections: true, allLocales: true });
      const del = await call("DELETE", `${BASE()}/${writerA}/webdesk_editor`, admin, {}); // the hub sends {} on a DELETE
      expect(del.json()).toMatchObject({ changed: true, removedGrant: true });
    });
  });

  describe("the generic grant surfaces refuse the four roles by name (editorial_role_dedicated_path), with VALID bodies", () => {
    it("legacy admin (POST /:t/users/:u/roles): refused; the same route grants `member` (positive control)", async () => {
      const bad = await call("POST", `/api/${A}/users/${member}/roles`, admin, { roleId: writerRoleId, scopeType: "company" });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/^editorial_role_dedicated_path/);
      const ok = await call("POST", `/api/${A}/users/${translatorA}/roles`, admin, { roleId: managerRoleId, scopeType: "company" });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await grantRows(member)).toEqual([]);
    });

    it("the `ui` origin (POST /:t/role-grants): refused; the same route grants `member` (positive control)", async () => {
      const bad = await call("POST", `/api/${A}/role-grants`, admin, { userId: member, roleId: writerRoleId });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/^editorial_role_dedicated_path/);
      const ok = await call("POST", `/api/${A}/role-grants`, admin, { userId: coManager, roleId: memberRoleId });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(await grantRows(member)).toEqual([]);
    });

    it("positions: a role set naming a writers' room role is refused, the composer lists it as not attachable", async () => {
      const bad = await call("POST", `/api/${A}/positions`, admin, { unitNodeId: "d-web", title: "Writer seat", roles: [{ roleId: writerRoleId, scopeKind: "company" }] });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/^editorial_role_dedicated_path/);
      const ok = await call("POST", `/api/${A}/positions`, admin, { unitNodeId: "d-web", title: "Manager seat", roles: [{ roleId: managerRoleId, scopeKind: "company" }] });
      expect(ok.statusCode, ok.body).toBe(201);
      const opts = await call("GET", `/api/${A}/positions/attachable-roles`, admin);
      expect(opts.json().roles.find((r: { role: string }) => r.role === "webdesk_writer")).toMatchObject({ attachable: false, reason: "editorial_role_dedicated_path" });
    });
  });
});
