// GHT-2 (docs/blueprints/github-tenant-scope-ruling.md §9) — HTTP-level tests for
// `GET /api/:t/github/org-status`. Mirrors github-repos-http.test.ts's GHT-1 fixture shape
// (holding root + `co` org tenant child + a wholly separate `secondRoot`) so the same resolver
// behaviour is exercised for this new route: holding-context reach succeeds with org meta,
// same-root-without-org-reach is 403, a different root and an unconfigured org tenant are both
// 503-family, never a fake 200.
//
// The ticket's hard requirement is secret non-exposure (§9 "Done when": the response never
// contains access_token_enc/refresh_token_enc/PEM material). Two REAL sealed credentials (one per
// GitHub App role) are seeded with fixture "secret" strings via integrations.service.ts directly
// (createConnection + setConnectionTokens — the same vault path credential-store.ts uses), and
// every response below is asserted byte-for-byte free of those fixture strings, of the ciphertext
// envelope prefix, and of the raw column names — not merely "the JSON has no `token` key", which
// would miss a leak inside `meta` or a differently-cased field.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { createConnection, setConnectionTokens } from "./integrations.service";
import { githubConnectionOwnerId } from "./github/apps";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// Fixture "secret" bytes — a real PEM shape for the erp App's credential, and a plain string for
// its refresh-token column, so both ciphertext families (access/refresh) are exercised. If either
// ever appears — even truncated — in a response body, that is the leak this suite exists to catch.
const ERP_PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAghtOrgStatusFixtureSecretPemBodyNeverEgressXYZ==\n-----END RSA PRIVATE KEY-----";
const ERP_REFRESH = "rt_ORG_STATUS_FIXTURE_secret_should_never_egress_abc";

describe.skipIf(!TEST_URL)("github org-status HTTP surface (GHT-2)", () => {
  let app: NestFastifyApplication;
  let holding: string;
  let co: string; // the ORG TENANT — child of `holding`
  let secondRoot: string;
  let manager: string; // reach into `co` only
  let holdingOnlyUser: string; // reach into `holding` only — same root, no org-tenant reach
  let originalOrgTenantId: string;
  let originalRepoSyncTenantId: string;
  let originalTokenKey: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    originalTokenKey = config.integrationTokenKey;
    config.integrationTokenKey = randomBytes(32).toString("base64");
    resetModules();
    resetCoreRollupProviders();

    holding = await createCompany("GHT-2 Holding");
    co = await createCompany("Gaiada GHT-2 Co", [], holding);
    secondRoot = await createCompany("GHT-2 Second Root");

    manager = await createUser("manager@ght2.test");
    await addMembership(co, manager);
    await grantRole(manager, await createRole("manager"), "company", co);

    holdingOnlyUser = await createUser("holding-only@ght2.test");
    await addMembership(holding, holdingOnlyUser);
    await grantRole(holdingOnlyUser, await createRole("manager"), "company", holding);

    // Seal the `erp` App's credential for real (access + refresh columns both populated), so the
    // secret-hygiene assertions below exercise a genuinely token-bearing row, not an empty one.
    const erpConn = await createConnection(co, {
      ownerKind: "github_app",
      ownerId: githubConnectionOwnerId("erp"),
      provider: "github",
      externalAccount: "gaiada-erp",
      scopes: ["read", "write"],
      meta: { appId: "111", installationId: "222", role: "erp", readOnly: false, appSlug: "gaiada-erp" },
      createdBy: null,
    });
    await setConnectionTokens(co, erpConn.id, { accessToken: ERP_PEM, refreshToken: ERP_REFRESH });
    // `agents` deliberately left UNSEALED — proves the "configured:false" branch alongside the
    // "configured:true" `erp` branch in the same response.

    originalOrgTenantId = config.githubOrgTenantId;
    originalRepoSyncTenantId = config.githubRepoSync.tenantId;
    config.githubOrgTenantId = co;
    config.githubRepoSync.tenantId = co;

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    config.githubOrgTenantId = originalOrgTenantId;
    config.githubRepoSync.tenantId = originalRepoSyncTenantId;
    config.integrationTokenKey = originalTokenKey;
  });

  const assertNoSecrets = (raw: string, label: string) => {
    expect(raw, `${label}: PEM body leaked`).not.toContain(ERP_PEM);
    // A PEM's markers alone, absent the body, are not a leak — but the fixture's distinctive
    // substring inside the body must never appear even truncated.
    expect(raw, `${label}: PEM fixture substring leaked (even truncated)`).not.toContain(
      "OrgStatusFixtureSecretPemBody",
    );
    expect(raw, `${label}: refresh token leaked`).not.toContain(ERP_REFRESH);
    expect(raw, `${label}: ciphertext envelope leaked`).not.toContain("enc:v1:");
    expect(raw, `${label}: token_enc column name leaked`).not.toMatch(/token_enc/);
    expect(raw, `${label}: access_token_enc field name leaked`).not.toContain("access_token_enc");
    expect(raw, `${label}: refresh_token_enc field name leaked`).not.toContain("refresh_token_enc");
    expect(raw, `${label}: privateKeyPem field name leaked`).not.toContain("privateKeyPem");
  };

  it("returns org meta + both App roles' health, with hasToken booleans only — no secret bytes or field names", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/github/org-status`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    const raw = r.body;
    assertNoSecrets(raw, "org-status same-tenant");

    const body = JSON.parse(raw);
    expect(body.org).toEqual({ login: config.githubOrg, tenantId: co, tenantName: "Gaiada GHT-2 Co" });

    const erp = body.apps.find((a: { role: string }) => a.role === "erp");
    expect(erp).toMatchObject({
      role: "erp", slug: "gaiada-erp", readOnly: false, configured: true,
      externalAccount: "gaiada-erp", status: "linked", hasToken: true,
    });
    expect(Object.keys(erp)).not.toContain("hasRefreshToken"); // response shape is deliberately narrower than ConnectionResponse
    expect(Object.keys(erp).sort()).toEqual(
      ["configured", "externalAccount", "hasToken", "readOnly", "role", "slug", "status", "tokenExpiresAt"].sort(),
    );

    const agents = body.apps.find((a: { role: string }) => a.role === "agents");
    expect(agents).toMatchObject({
      role: "agents", slug: "gaiada-agents", readOnly: true, configured: false,
      externalAccount: null, status: "unconfigured", hasToken: false, tokenExpiresAt: null,
    });

    expect(body.sync).toHaveProperty("asOf");
    expect(typeof body.sync.asOf).toBe("string");
    expect(body.sync.lastRepoSyncAt).toBeNull(); // no github_repos rows seeded in this suite
    expect(body.sync.lastWebhookReceivedAt).toBeNull();
    expect(body.sync.lastWebhookErrorClass).toBeNull();
  });

  it("a holding-context request by a principal with ONLY agency (co) reach sees the same status, with org meta naming co", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${holding}/github/org-status`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    assertNoSecrets(r.body, "org-status holding-context");
    const body = JSON.parse(r.body);
    expect(body.org.tenantId).toBe(co);
    expect(body.apps.find((a: { role: string }) => a.role === "erp").hasToken).toBe(true);
  });

  it("a same-root principal WITHOUT org-tenant reach is refused 403, not served a fake unconfigured state", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${holding}/github/org-status`, headers: asUser(holdingOnlyUser),
    });
    expect(r.statusCode).toBe(403);
    assertNoSecrets(r.body, "org-status denied");
  });

  it("a DIFFERENT root's tenant in the URL is refused 503-family before any query runs, never 200 or 403", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${secondRoot}/github/org-status`, headers: asUser(manager),
    });
    expect(r.statusCode).toBe(503);
    assertNoSecrets(r.body, "org-status second-root");
  });

  it("an unconfigured org tenant refuses with 503, never a fake status 200", async () => {
    const saved = config.githubOrgTenantId;
    config.githubOrgTenantId = "";
    try {
      const r = await app.inject({ method: "GET", url: `/api/${co}/github/org-status`, headers: asUser(manager) });
      expect(r.statusCode).toBe(503);
    } finally {
      config.githubOrgTenantId = saved;
    }
  });

  it("the route is read-only: no POST/PATCH/DELETE variant exists on this path", async () => {
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const r = await app.inject({ method, url: `/api/${co}/github/org-status`, headers: asUser(manager) });
      expect([404, 405]).toContain(r.statusCode);
    }
  });
});
