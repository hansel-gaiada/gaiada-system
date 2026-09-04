// VLT-2 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — the HTTP surface for the
// `webdev_sites` registry's first write path, against REAL Cerbos + RLS (same posture as
// `webdev-controller-http.test.ts` in this directory).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { withTenants } from "../../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("webdev sites registry HTTP surface (VLT-2)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let other: string;
  let member: string;
  let admin: string;
  let connectionId: string;
  let otherConnectionId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Site Registry Co", ["webdev"]);
    other = await createCompany("Rival Site Registry Co", ["webdev"]);
    member = await createUser("member@siteregistry.test");
    admin = await createUser("admin@siteregistry.test");
    await addMembership(co, member);
    await addMembership(co, admin);
    await grantRole(member, await createRole("member"), "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    const conn = await withTenants([co], (c) =>
      c.query<{ id: string }>(
        `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, origin_site)
         VALUES (gen_random_uuid(), $1, 'company', $1, 'github', 'linked', 'test') RETURNING id`,
        [co],
      ),
    );
    connectionId = conn.rows[0].id;
    const otherConn = await withTenants([other], (c) =>
      c.query<{ id: string }>(
        `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, origin_site)
         VALUES (gen_random_uuid(), $1, 'company', $1, 'github', 'linked', 'test') RETURNING id`,
        [other],
      ),
    );
    otherConnectionId = otherConn.rows[0].id;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const base = (t = co) => `/api/${t}/modules/webdev/sites`;

  it("member CANNOT create a registry row — write is manager-tier → 403", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(member), payload: { domain: "member-denied.test" },
    });
    expect(r.statusCode).toBe(403);
  });

  let siteId: string;
  it("company_admin creates a registry row (201)", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(admin),
      payload: { domain: "http-created.test", environment: "staging" },
    });
    expect(r.statusCode).toBe(201);
    siteId = r.json().id;
    expect(r.json()).toMatchObject({ domain: "http-created.test", environment: "staging", vaultRef: null });
  });

  it("create REJECTS vaultRef in the body — that field only exists on the dedicated PATCH", async () => {
    const r = await app.inject({
      method: "POST", url: base(), headers: asUser(admin),
      payload: { domain: "reject-vaultref-on-create.test", vaultRef: connectionId },
    });
    expect(r.statusCode).toBe(400);
  });

  it("GET reads the row back", async () => {
    const r = await app.inject({ method: "GET", url: `${base()}/${siteId}`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    expect(r.json().id).toBe(siteId);
  });

  it("PATCH sets vaultRef to a valid same-tenant connection", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin), payload: { vaultRef: connectionId },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().vaultRef).toBe(connectionId);
  });

  // ── Acceptance criterion 3: cannot become a backdoor write path for any other column ────────────
  it("PATCH rejects ANY other field in the same payload, even alongside a valid vaultRef", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin),
      payload: { vaultRef: connectionId, domain: "hijacked.test" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("PATCH rejects a bare {} and a field-only-typo payload", async () => {
    expect((await app.inject({ method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin), payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin), payload: { vault_ref: connectionId } })).statusCode,
    ).toBe(400);
  });

  // ── Acceptance criterion 2's negative case, at the HTTP boundary ─────────────────────────────────
  it("PATCH rejects a vaultRef that resolves to a DIFFERENT tenant's connection", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin), payload: { vaultRef: otherConnectionId },
    });
    expect(r.statusCode).toBe(400);
  });

  it("PATCH rejects a credential-looking string outright (not uuid-shaped)", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin),
      payload: { vaultRef: "hunter2-my-ftp-password" },
    });
    expect(r.statusCode).toBe(400);
  });

  // ── Acceptance criterion 4: cross-tenant RLS/tenancy denial, proven end to end ───────────────────
  it("a rival tenant's admin PATCHing this site's :id under THEIR OWN tenant path gets 404 (tenant-scoped row load)", async () => {
    const rivalAdmin = await createUser("rivaladmin@siteregistry.test");
    await addMembership(other, rivalAdmin);
    await grantRole(rivalAdmin, await createRole("company_admin"), "company", other);
    const r = await app.inject({
      method: "PATCH", url: `${base(other)}/${siteId}`, headers: asUser(rivalAdmin), payload: { vaultRef: null },
    });
    expect([403, 404]).toContain(r.statusCode);
    // Confirm the row itself is untouched under the legitimate tenant's own view.
    const check = await app.inject({ method: "GET", url: `${base()}/${siteId}`, headers: asUser(admin) });
    expect(check.json().vaultRef).toBe(connectionId);
  });

  it("clears vaultRef with null", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin), payload: { vaultRef: null },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().vaultRef).toBeNull();
  });
});
