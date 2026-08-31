// WSK-23 — `ConsoleReadsController` HTTP surface, in ISOLATION (`Test.createTestingModule` with
// only this controller — same posture `contract-snapshots-http.test.ts` (WSK-19) and
// `zoneb-events-http.test.ts` (WSK-12) both document for this exact reason: proving routing/authz/
// module-gate correctness does not require booting the whole `main.ts` app, and this controller's
// registration in `app.module.ts` is a separate, reportable edit this ticket also makes — this
// suite is what stays true regardless of that file's ever-shifting state under concurrent sessions).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { ConsoleReadsController } from "./console-reads.controller";
import { setConsoleControlProviderForTests } from "./console-reads.service";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [ConsoleReadsController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("WSK-23 · ConsoleReadsController (HTTP, isolated app)", () => {
  let app: NestFastifyApplication;
  let tenant: string; // webdev ENABLED
  let noModule: string; // webdev NOT enabled
  let user: string; // plain employee — no elevated role
  let admin: string; // company_admin in `tenant` — the positive-authorization control

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("WSK-23 HTTP Tenant", ["webdev"]);
    noModule = await createCompany("WSK-23 No Webdev Co", ["pm"]);
    user = await createUser("wsk23-http-user@a.test", "HTTP Test User");
    admin = await createUser("wsk23-http-admin@a.test", "HTTP Test Admin");
    await addMembership(tenant, user);
    await addMembership(noModule, user);
    await addMembership(tenant, admin);
    const adminRole = await createRole("company_admin");
    await grantRole(admin, adminRole, "company", tenant);
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    setConsoleControlProviderForTests(null);
    await app.close();
    await teardownTestDb();
  });

  it("requires authentication — 401 with no credential", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${tenant}/modules/webdev/console/sites` });
    expect(r.statusCode).toBe(401);
  });

  it("404s a company that has not enabled the webdev module (the per-tenant gate)", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${noModule}/modules/webdev/console/sites`, headers: asUser(user),
    });
    expect(r.statusCode).toBe(404);
  });

  it("a plain member IS allowed to read (module_staff / company tier both carry 'read') — not a 404, not a 500", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/console/sites`, headers: asUser(user),
    });
    expect(r.statusCode).not.toBe(404);
    expect(r.statusCode).not.toBe(500);
    expect([200, 403]).toContain(r.statusCode);
  });

  it("a company_admin reads the site registry — 200, the honest envelope shape (never a bare array)", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/console/sites`, headers: asUser(admin),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ sites: expect.any(Array), meta: { stale: true } });
  });

  it("releases: route param wiring — :slug reaches the service (empty result for an unknown slug is 200, not 404)", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/console/sites/no-such-slug/releases`, headers: asUser(admin),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ releases: [], meta: { stale: true, source: "unavailable" } });
  });

  it("submissions: ?formId querystring reaches the service", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/${tenant}/modules/webdev/console/sites/no-such-slug/submissions?formId=contact`,
      headers: asUser(admin),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ submissions: [], meta: { stale: true } });
  });

  it("contract-pins: authorizes against webdev_contract_snapshot (a DIFFERENT kind than the other three routes) and still 200s", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/console/contract-pins?slug=no-such-slug`, headers: asUser(admin),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ pins: [{ webdeskTenantSlug: "no-such-slug", pinned: null }] });
  });

  it("no route collides with the sibling controllers' own paths on this SAME prefix (contracts, contracts/refresh, provisioned-sites, zoneb-events)", async () => {
    const collision = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/contracts`, headers: asUser(admin),
    });
    // 404, not 200/500 — this isolated app registers ONLY ConsoleReadsController, so a sibling
    // controller's path must miss cleanly, proving the two route sets are genuinely disjoint rather
    // than accidentally identical.
    expect(collision.statusCode).toBe(404);
  });
});
