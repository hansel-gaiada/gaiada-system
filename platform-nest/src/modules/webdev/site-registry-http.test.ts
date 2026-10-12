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
  let webdevManager: string; // module_manager: create + update, like company_admin
  let webdevStaff: string; // module_staff: read only
  let clientOnly: string; // the client grant appears nowhere in resource_webdev_site.yaml
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
    webdevManager = await createUser("webdevmanager@siteregistry.test");
    webdevStaff = await createUser("webdevstaff@siteregistry.test");
    clientOnly = await createUser("client@siteregistry.test");
    for (const [u, role] of [[webdevManager, "webdev_manager"], [webdevStaff, "webdev_staff"], [clientOnly, "client"]] as const) {
      await addMembership(co, u);
      await grantRole(u, await createRole(role), "company", co);
    }
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

  // ── M6-P3c: `webdev_site` (create / read / update) — behaviour-preserving against the borrowed kind ──
  it("module tiers on webdev_site: webdev_manager creates (201) and updates (200); webdev_staff reads (200) but cannot create or update (403); client-only is 403 everywhere", async () => {
    const created = await app.inject({
      method: "POST", url: base(), headers: asUser(webdevManager), payload: { domain: "manager-created.test" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect((await app.inject({ method: "PATCH", url: `${base()}/${id}`, headers: asUser(webdevManager), payload: { vaultRef: connectionId } })).statusCode).toBe(200);

    expect((await app.inject({ method: "GET", url: `${base()}/${id}`, headers: asUser(webdevStaff) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: base(), headers: asUser(webdevStaff), payload: { domain: "staff-denied.test" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `${base()}/${id}`, headers: asUser(webdevStaff), payload: { vaultRef: null } })).statusCode).toBe(403);

    expect((await app.inject({ method: "GET", url: `${base()}/${id}`, headers: asUser(clientOnly) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: base(), headers: asUser(clientOnly), payload: { domain: "client-denied.test" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `${base()}/${id}`, headers: asUser(clientOnly), payload: { vaultRef: null } })).statusCode).toBe(403);
    // and the member (no webdev tier at all) cannot read either
    expect((await app.inject({ method: "GET", url: `${base()}/${id}`, headers: asUser(member) })).statusCode).toBe(403);
  });

  it("clears vaultRef with null", async () => {
    const r = await app.inject({
      method: "PATCH", url: `${base()}/${siteId}`, headers: asUser(admin), payload: { vaultRef: null },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().vaultRef).toBeNull();
  });

  // ── M6-P4c2: POST sites/:id/domain — a provisioned site claims its real domain ───────────────────
  describe("POST sites/:id/domain (M6-P4c2)", () => {
    const provisionedSite = async (slug: string) => {
      const r = await app.inject({
        method: "POST", url: base(), headers: asUser(admin),
        payload: { domain: `${slug}.provisioned.invalid`, origin: "provisioned", adoption: "mandated", environment: "staging" },
      });
      expect(r.statusCode).toBe(201);
      return r.json().id as string;
    };
    const claim = (id: string, who: string, payload: object, tenant = co) =>
      app.inject({ method: "POST", url: `${base(tenant)}/${id}/domain`, headers: asUser(who), payload });
    const domainOf = async (id: string) =>
      (await app.inject({ method: "GET", url: `${base()}/${id}`, headers: asUser(admin) })).json().domain as string;

    it("company_admin claims the real domain (200) and the registry row carries it", async () => {
      const id = await provisionedSite("http-claim");
      const r = await claim(id, admin, { domain: "Http-Claim.example.com" });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ id, domain: "http-claim.example.com", origin: "provisioned" });
      expect(await domainOf(id)).toBe("http-claim.example.com");
    });

    it("webdev_manager (module_manager tier) may claim; a second claim is 409 domain_already_set", async () => {
      const id = await provisionedSite("http-claim-mgr");
      expect((await claim(id, webdevManager, { domain: "http-claim-mgr.example.com" })).statusCode).toBe(200);
      const again = await claim(id, admin, { domain: "http-claim-mgr-2.example.com" });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("domain_already_set");
    });

    // AUTHZ IS NOT PRE-EMPTED BY VALIDATION. Every denial below sends a VALID body for a claimable site, so a
    // 403 can only come from the policy. (An invalid body would 400 for a validation reason and the test
    // would silently stop testing authz.)
    it("denied principals get 403 with a VALID body: member, webdev_staff (read-only tier), client-only", async () => {
      const id = await provisionedSite("http-claim-denied");
      for (const who of [member, webdevStaff, clientOnly]) {
        expect((await claim(id, who, { domain: "http-claim-denied.example.com" })).statusCode).toBe(403);
      }
      // nothing was written: still on the placeholder, and an authorised claim still succeeds
      expect(await domainOf(id)).toBe("http-claim-denied.provisioned.invalid");
      expect((await claim(id, admin, { domain: "http-claim-denied.example.com" })).statusCode).toBe(200);
    });

    it("a denied principal sending an INVALID body still gets 403, not 400 (authz runs first)", async () => {
      const id = await provisionedSite("http-claim-denied-bad");
      expect((await claim(id, webdevStaff, { domain: "" })).statusCode).toBe(403);
      expect((await claim(id, webdevStaff, { domain: "x.example.com", vaultRef: null })).statusCode).toBe(403);
    });

    it("an authorised caller gets 400 for a bad body: extra field, missing domain, non-string, bad format, .invalid", async () => {
      const id = await provisionedSite("http-claim-bad");
      expect((await claim(id, admin, { domain: "http-claim-bad.example.com", notes: "x" })).statusCode).toBe(400);
      expect((await claim(id, admin, {})).statusCode).toBe(400);
      expect((await claim(id, admin, { domain: 42 })).statusCode).toBe(400);
      expect((await claim(id, admin, { domain: "has a space.example.com" })).statusCode).toBe(400);
      expect((await claim(id, admin, { domain: "real.provisioned.invalid" })).statusCode).toBe(400);
      expect(await domainOf(id)).toBe("http-claim-bad.provisioned.invalid");
    });

    it("404 for an unknown site; a row not on its placeholder is 409; a duplicate domain is 409", async () => {
      expect((await claim("00000000-0000-0000-0000-000000000000", admin, { domain: "nowhere.example.com" })).statusCode).toBe(404);
      // `siteId` (created above: origin manual, real domain) is not claimable
      expect((await claim(siteId, admin, { domain: "not-claimable.example.com" })).statusCode).toBe(409);
      const id = await provisionedSite("http-claim-dupe");
      expect((await claim(id, admin, { domain: "http-created.test" })).statusCode).toBe(409); // held by `siteId`
      expect(await domainOf(id)).toBe("http-claim-dupe.provisioned.invalid");
    });

    it("a rival tenant's admin cannot claim this tenant's site under their own tenant path", async () => {
      const id = await provisionedSite("http-claim-rival");
      const rivalAdmin = await createUser("rivaladmin-claim@siteregistry.test");
      await addMembership(other, rivalAdmin);
      await grantRole(rivalAdmin, await createRole("company_admin"), "company", other);
      const r = await claim(id, rivalAdmin, { domain: "http-claim-rival.example.com" }, other);
      expect([403, 404]).toContain(r.statusCode);
      expect(await domainOf(id)).toBe("http-claim-rival.provisioned.invalid");
    });
  });
});
