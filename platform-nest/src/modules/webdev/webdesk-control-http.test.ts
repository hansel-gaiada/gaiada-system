// WSK-31 — `WebdeskControlController`'s HTTP surface, in ISOLATION (`Test.createTestingModule`
// with only this controller). Same posture `zoneb-events-http.test.ts` already took for its own
// not-yet-app.module.ts-registered sibling (this ticket's report names the exact app.module.ts
// addition made). Every route is an honest 501 stub — see the controller's own header — so what
// this suite proves is the GATE, not a fake success: routing, authentication, the per-tenant module
// gate, Cerbos authorization (operate for MEDIUM routes, promote for HIGH routes), and that every
// authorized call reaches the SAME typed `webdesk_control_plane_not_wired` answer, never a 500.
//
// Cerbos caveat, same as zoneb-events-http.test.ts's own: a plain-member 403 is tolerant of whether
// the sidecar under test has been RESTARTED to pick up this ticket's new `operate`/`promote` rules
// on `resource_webdev_provisioned_site.yaml` (the standing bind-mount-does-not-hot-reload trap) —
// an unlisted action denies the same way a loaded-but-insufficient-role denies. The POSITIVE control
// (company_admin succeeding) is what proves the policy genuinely loaded and grants correctly.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { WebdeskControlController } from "./webdesk-control.controller";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [WebdeskControlController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("WSK-31 · WebdeskControlController (HTTP, isolated app)", () => {
  let app: NestFastifyApplication;
  let tenant: string; // webdev ENABLED
  let noModule: string; // webdev NOT enabled
  let member: string; // plain employee — no elevated role
  let admin: string; // company_admin in `tenant` — the positive-authorization control

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("WSK-31 HTTP Tenant", ["webdev"]);
    noModule = await createCompany("WSK-31 No Webdev Co", ["pm"]);
    member = await createUser("wsk31-http-member@a.test", "HTTP Test Member");
    admin = await createUser("wsk31-http-admin@a.test", "HTTP Test Admin");
    await addMembership(tenant, member);
    await addMembership(noModule, member);
    await addMembership(tenant, admin);
    const adminRole = await createRole("company_admin");
    await grantRole(admin, adminRole, "company", tenant);
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("the routes are mounted at the exact §07 paths — a routing miss is a 404, distinct from every refusal below", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${tenant}/modules/webdev/control/sites-typo` });
    expect(r.statusCode).toBe(404);
  });

  it("requires authentication — 401 with no credential", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${tenant}/modules/webdev/control/sites` });
    expect(r.statusCode).toBe(401);
  });

  it("404s a company that has not enabled the webdev module (the per-tenant gate)", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${noModule}/modules/webdev/control/sites`, headers: asUser(member),
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: expect.stringContaining("webdev") });
  });

  it("a plain member (no elevated role) is DENIED reading the registry", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/control/sites`, headers: asUser(member),
    });
    expect(r.statusCode).not.toBe(404);
    expect([501, 403]).toContain(r.statusCode);
    expect(r.statusCode).not.toBe(500);
  });

  it("a company_admin CAN read — the positive control proving read authz genuinely loaded (WSK-59: the route is LIVE, and with no channel configured here it answers a typed 503, never a 501 or a 500)", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/control/sites`, headers: asUser(admin),
    });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "webdesk_not_configured", reason: "control_channel_not_configured" });
  });

  describe("the three read routes (Cerbos action: read)", () => {
    for (const [method, path] of [
      ["GET", "sites/s1/status"],
      ["GET", "sites/s1/submissions"],
    ] as const) {
      it(`${method} ${path}: member DENIED, admin 501`, async () => {
        const denied = await app.inject({ method, url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(member) });
        expect([501, 403]).toContain(denied.statusCode);
        const allowed = await app.inject({ method, url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(admin) });
        expect(allowed.statusCode).toBe(501);
      });
    }
  });

  describe("the four MEDIUM/LOW write routes (Cerbos action: operate)", () => {
    for (const [path, body] of [
      ["schema/propose", { siteId: "s1" }],
      ["sites/s1/deploy/staging", {}],
    ] as const) {
      it(`POST ${path}: member DENIED, admin 501`, async () => {
        const denied = await app.inject({
          method: "POST", url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(member), payload: body,
        });
        expect([501, 403]).toContain(denied.statusCode);
        const allowed = await app.inject({
          method: "POST", url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(admin), payload: body,
        });
        expect(allowed.statusCode).toBe(501);
        expect(allowed.json()).toMatchObject({ error: "webdesk_control_plane_not_wired" });
      });
    }

    // WSK-59: these two stopped being stubs. Denied for a member; for an admin a VALID body reaches the egress
    // seam, which (no channel configured in this isolated app) answers a typed 503, and an INVALID body is a 400.
    for (const [path, body] of [
      ["schema/apply", { tenantSlug: "acme", siteId: "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", collectionKey: "service", schema: {} }],
      ["sites", { tenantSlug: "acme", kind: "astro", name: "Main" }],
    ] as const) {
      it(`POST ${path} (LIVE): member DENIED with a VALID body; admin with the identical body reaches the channel (503 not configured); a bad body is 400`, async () => {
        const denied = await app.inject({ method: "POST", url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(member), payload: body });
        expect(denied.statusCode).toBe(403);
        const allowed = await app.inject({ method: "POST", url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(admin), payload: body });
        expect(allowed.statusCode).toBe(503);
        expect(allowed.json()).toMatchObject({ error: "webdesk_not_configured" });
        const bad = await app.inject({ method: "POST", url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(admin), payload: { nonsense: 1 } });
        expect(bad.statusCode).toBe(400);
      });
    }

    it("a malformed (non-object) JSON body is refused before reaching the stub — never a 500", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/modules/webdev/control/schema/apply`,
        headers: { ...asUser(admin), "content-type": "application/json" },
        payload: JSON.stringify(["not", "an", "object"]),
      });
      expect(r.statusCode).toBe(400);
    });
  });

  describe("🔴 the HIGH write routes (Cerbos action: promote — §07 always-WS4 commands)", () => {
    // 2026-10-11: `sites/:siteId/keys` FILES a key.mint approval now (webdesk-key-mint.test.ts covers it end to
    // end); here it keeps only the gate-first pairing: member 403, admin past the gate into body validation.
    it("POST sites/s1/keys: member DENIED; admin passes the gate and an incomplete body is a typed 400 (not 501, not 500)", async () => {
      const body = { scope: "read" };
      const denied = await app.inject({
        method: "POST", url: `/api/${tenant}/modules/webdev/control/sites/s1/keys`, headers: asUser(member), payload: body,
      });
      expect(denied.statusCode).toBe(403);
      const allowed = await app.inject({
        method: "POST", url: `/api/${tenant}/modules/webdev/control/sites/s1/keys`, headers: asUser(admin), payload: body,
      });
      expect(allowed.statusCode).toBe(400);
      expect(allowed.json()).toMatchObject({ reason: "invalid_request" });
    });
    // 2026-10-12: `sites/:siteId/archive` FILES a site.archive approval now (webdesk-site-archive.test.ts covers it end
    // to end); here it keeps only the gate-first pairing: member 403, admin past the gate into body validation.
    it("POST sites/s1/archive: member DENIED; admin passes the gate and a body without tenantSlug is a typed 400 (not 501, not 500)", async () => {
      const denied = await app.inject({
        method: "POST", url: `/api/${tenant}/modules/webdev/control/sites/s1/archive`, headers: asUser(member), payload: {},
      });
      expect(denied.statusCode).toBe(403);
      const allowed = await app.inject({
        method: "POST", url: `/api/${tenant}/modules/webdev/control/sites/s1/archive`, headers: asUser(admin), payload: {},
      });
      expect(allowed.statusCode).toBe(400);
      expect(allowed.json()).toMatchObject({ reason: "invalid_request" });
    });
    // M6-P6i: `sites/:siteId/domain` FILES a site.setDomain approval now (webdesk-site-set-domain.test.ts covers it end to end);
    // here it keeps only the gate-first pairing: member 403, admin past the gate into body validation.
    it("POST sites/s1/domain: member DENIED; admin passes the gate and a body without tenantSlug is a typed 400 (not 501, not 500)", async () => {
      const denied = await app.inject({
        method: "POST", url: `/api/${tenant}/modules/webdev/control/sites/s1/domain`, headers: asUser(member), payload: { domain: "example.com" },
      });
      expect(denied.statusCode).toBe(403);
      const allowed = await app.inject({
        method: "POST", url: `/api/${tenant}/modules/webdev/control/sites/s1/domain`, headers: asUser(admin), payload: { domain: "example.com" },
      });
      expect(allowed.statusCode).toBe(400);
      expect(allowed.json()).toMatchObject({ reason: "invalid_request" });
    });
    for (const [path, body] of [
      ["sites/s1/promote", {}],
      ["sites/s1/rollback", {}],
      ["keys/k1/rotate", {}],
      ["keys/k1/revoke", {}],
    ] as const) {
      it(`POST ${path}: member DENIED, admin 501 (the stub) — the always-WS4 gate itself lives at mcp-hub, not here`, async () => {
        const denied = await app.inject({
          method: "POST", url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(member), payload: body,
        });
        expect([501, 403]).toContain(denied.statusCode);
        const allowed = await app.inject({
          method: "POST", url: `/api/${tenant}/modules/webdev/control/${path}`, headers: asUser(admin), payload: body,
        });
        expect(allowed.statusCode).toBe(501);
        expect(allowed.json()).toMatchObject({ error: "webdesk_control_plane_not_wired" });
      });
    }
  });
});
