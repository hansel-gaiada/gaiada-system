// WSK-19 — the `ContractSnapshotsController` HTTP surface, in ISOLATION (`Test.createTestingModule`
// with only this controller, not `main.ts`'s `buildApp()`) — same posture WSK-12's own
// `zoneb-events-http.test.ts` documents for its sibling controller: this controller is genuinely
// not registered in `platform-nest/src/app.module.ts` yet (this ticket's hard constraints: report
// the edit, do not make it here). Booting the real `buildApp()` would 404 every route unconditionally.
//
// Uses `setWebdevControlProviderForTests()` so this suite drives the REAL controller -> REAL
// service -> REAL Postgres (RLS, third wall, the immutability trigger) path end-to-end, with only
// the Zone B egress itself faked — the same "everything real except the far side" posture
// `provisioning-idempotency.test.ts` takes with its mock HTTP provision server, just without a
// second real socket hop (a fixture object is enough to prove the CONTROLLER's status-code mapping,
// which is this file's actual job; the driver's own real-socket behavior is
// `contract-fetch-http.test.ts`'s job and the tripwire LOGIC is `contract-snapshot.service.test.ts`'s).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { ContractSnapshotsController, setWebdevControlProviderForTests } from "./contract-snapshots.controller";
import { computeContentHash } from "./contract-snapshot.service";
import type { ContractBundleMeta, WebdevControlProvider } from "./contract-fetch-provider";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

function artifacts(seed: string) {
  return {
    sdkTs: Buffer.from(`sdk-${seed}`), openapi: Buffer.from(`openapi-${seed}`),
    contractMd: Buffer.from(`md-${seed}`), sdkPhp: null as Buffer | null,
  };
}

function providerFor(version: string, seed: string, lieAboutHash = false): WebdevControlProvider {
  const set = artifacts(seed);
  const { contentHash } = computeContentHash(set);
  const meta: ContractBundleMeta = {
    version, vocabularyVersion: "1.2.0",
    blockLibrary: { package: "@gaiada/webdesk-blocks", version: "1.3.2", range: "^1.3" },
    artifacts: {
      sdkTsUrl: "fixture://sdk", sdkPhpUrl: null, openapiUrl: "fixture://openapi", contractMdUrl: "fixture://md",
    },
    contentHash: lieAboutHash ? "sha256:1111111111111111111111111111111111111111111111111111111111111" : contentHash,
    generatedAt: new Date().toISOString(),
  };
  const byUrl: Record<string, Buffer> = { "fixture://sdk": set.sdkTs, "fixture://openapi": set.openapi, "fixture://md": set.contractMd };
  return { key: "fixture", getContractBundle: async () => meta, downloadArtifact: async (u: string) => byUrl[u] };
}

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [ContractSnapshotsController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("WSK-19 · ContractSnapshotsController (HTTP, isolated app)", () => {
  let app: NestFastifyApplication;
  let tenant: string; // webdev ENABLED
  let noModule: string; // webdev NOT enabled
  let user: string; // plain employee — no elevated role
  let admin: string; // company_admin in `tenant` — the positive-authorization control

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("WSK-19 HTTP Tenant", ["webdev"]);
    noModule = await createCompany("WSK-19 No Webdev Co", ["pm"]);
    user = await createUser("wsk19-http-user@a.test", "HTTP Test User");
    admin = await createUser("wsk19-http-admin@a.test", "HTTP Test Admin");
    await addMembership(tenant, user);
    await addMembership(noModule, user);
    await addMembership(tenant, admin);
    const adminRole = await createRole("company_admin");
    await grantRole(admin, adminRole, "company", tenant);
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    setWebdevControlProviderForTests(null);
    await app.close();
    await teardownTestDb();
  });

  it("the route is mounted at the exact path — a routing miss is a 404, distinct from every refusal below", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh-typo` });
    expect(r.statusCode).toBe(404);
  });

  it("requires authentication — 401 with no credential", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`, payload: { slug: "acme" },
    });
    expect(r.statusCode).toBe(401);
  });

  it("404s a company that has not enabled the webdev module (the per-tenant gate)", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${noModule}/modules/webdev/contracts/refresh`,
      headers: asUser(user), payload: { slug: "acme" },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: expect.stringContaining("webdev") });
  });

  it("a malformed body (no slug) is refused before authorization/DB — never a 500", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(admin), payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it("a plain member (no elevated role) is DENIED — not a routing/module miss", async () => {
    setWebdevControlProviderForTests(providerFor("1.0.0", "member-probe"));
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(user), payload: { slug: "acme" },
    });
    expect(r.statusCode).not.toBe(404);
    expect([200, 201, 403]).toContain(r.statusCode);
    expect(r.statusCode).not.toBe(500);
  });

  it("a company_admin IS authorized — positive control: 201 created, then GET lists it", async () => {
    setWebdevControlProviderForTests(providerFor("1.0.0", "admin-e2e"));
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(admin), payload: { slug: "acme" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ contractVersion: "1.0.0", webdeskTenantSlug: "acme" });

    const list = await app.inject({
      method: "GET", url: `/api/${tenant}/modules/webdev/contracts?slug=acme`, headers: asUser(admin),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual(expect.arrayContaining([expect.objectContaining({ contractVersion: "1.0.0" })]));

    // Idempotent replay through the SAME HTTP path — 200, not another 201.
    setWebdevControlProviderForTests(providerFor("1.0.0", "admin-e2e"));
    const replay = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(admin), payload: { slug: "acme" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: r.json().id });
  });

  it("TRIPWIRE (a) surfaces as 502 at the HTTP layer", async () => {
    setWebdevControlProviderForTests(providerFor("2.0.0", "http-mismatch", true));
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(admin), payload: { slug: "acme" },
    });
    expect(r.statusCode).toBe(502);
    // This estate's shared error envelope is `{ error }` (HttpErrorFilter renames `message` ->
    // `error`), not Nest's default `{ message }` — same recurring-mistake note WSK-12's own HTTP
    // suite states.
    expect(r.json()).toMatchObject({ error: "contract_hash_mismatch" });
  });

  it("TRIPWIRE (b) surfaces as 409 at the HTTP layer", async () => {
    setWebdevControlProviderForTests(providerFor("3.0.0", "http-breach-A"));
    const first = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(admin), payload: { slug: "acme" },
    });
    expect(first.statusCode).toBe(201);

    setWebdevControlProviderForTests(providerFor("3.0.0", "http-breach-B"));
    const second = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/contracts/refresh`,
      headers: asUser(admin), payload: { slug: "acme" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({
      error: "contract_determinism_breach",
      existing: { snapshotId: first.json().id, contractVersion: "3.0.0" },
    });
  });
});
