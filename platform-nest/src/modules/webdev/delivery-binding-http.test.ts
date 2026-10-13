// M6-P6g — `POST sites/:id/delivery-binding` and `POST sites/:id/production` over HTTP, isolated app (WebdevController only, the
// deploy-grant-http.test.ts posture), with REAL Postgres and REAL Cerbos. What only this layer can prove:
//   * the existing `webdev_site` actions, unchanged policy: `update` (bind) and `create` (production) are manager-tier; a member,
//     a webdev_staff (read only) and a client-only principal are refused, with a VALID body so validation cannot pre-empt the
//     authorization under test, and a malformed body does not change that answer;
//   * a refusal answers its token as `{error, reason}` with the token's status; the body is CLOSED (a host, user, path or
//     secret key is a 400 and nothing is stored);
//   * another tenant's vault record is a 422 and another tenant's site is a 404;
//   * a write leaves an `activities` row beside its neighbours, and never the vault pointer in it;
//   * `GET provisioned-sites/:id` shows the host side (`delivery`) NEXT TO the GitHub side (`deployGrant`), as two facts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { HttpErrorFilter } from "../../http-error.filter";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { newId } from "../../db";
import { WebdevController } from "./webdev.controller";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function buildIsolatedApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [WebdevController] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false, abortOnError: false });
  app.useGlobalFilters(new HttpErrorFilter());
  await app.init();
  return app;
}

describe.skipIf(!TEST_URL)("M6-P6g · delivery binding + production-from-staging routes (HTTP, isolated app, real Cerbos)", () => {
  let app: NestFastifyApplication;
  let T: string;
  let O: string;
  let manager: string;
  let member: string;
  let staff: string;
  let clientOnly: string;
  let otherManager: string;

  const db = () => adminPool();

  /** A provisioned staging registry row plus the provisioned mirror row the console lists. */
  async function provisioned(tenant = T) {
    const siteId = newId();
    const id = newId();
    await db().query(
      `INSERT INTO webdev_sites (id, tenant_id, domain, environment, kind, repo_url, adoption, origin, origin_site)
       VALUES ($1, $2, $3, 'staging', 'static', 'https://github.com/acme-org/x', 'mandated', 'provisioned', 'main')`,
      [siteId, tenant, `p6g-${siteId.slice(-12)}.provisioned.invalid`],
    );
    await db().query(
      `INSERT INTO webdev_provisioned_sites (id, tenant_id, provider, provider_ref, slug, framework, status, origin_site, completion_state, webdev_site_id)
       VALUES ($1, $2, 'erp_repo', $3, $4, 'astro', 'live', 'main', 'registered', $5)`,
      [id, tenant, newId(), `p6g-${id.slice(-12)}`, siteId],
    );
    return { id, siteId };
  }

  async function vault(tenant = T, provider = "ftp", status = "linked"): Promise<string> {
    const id = newId();
    await db().query(
      `INSERT INTO integration_connections (id, tenant_id, owner_kind, owner_id, provider, status, origin_site)
       VALUES ($1, $2, 'company', $3, $4, $5, 'test')`,
      [id, tenant, newId(), provider, status],
    );
    return id;
  }

  const body = (vaultRef: string, over: Record<string, unknown> = {}) => ({
    hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp", vaultRef, ...over,
  });
  const bindUrl = (siteId: string, tenant = T) => `/api/${tenant}/modules/webdev/sites/${siteId}/delivery-binding`;
  const prodUrl = (siteId: string, tenant = T) => `/api/${tenant}/modules/webdev/sites/${siteId}/production`;
  const bind = (siteId: string, user: string, payload: unknown, tenant = T) =>
    app.inject({ method: "POST", url: bindUrl(siteId, tenant), headers: asUser(user), payload: payload as Record<string, unknown> });
  const promote = (siteId: string, user: string, payload: unknown, tenant = T) =>
    app.inject({ method: "POST", url: prodUrl(siteId, tenant), headers: asUser(user), payload: payload as Record<string, unknown> });
  const row = async (id: string) => (await db().query(`SELECT * FROM webdev_sites WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    T = await createCompany("P6g HTTP Co", ["webdev"]);
    O = await createCompany("P6g HTTP Rival Co", ["webdev"]);
    manager = await createUser("p6g-manager@a.test", "P6g Manager");
    member = await createUser("p6g-member@a.test", "P6g Member");
    staff = await createUser("p6g-staff@a.test", "P6g Staff");
    clientOnly = await createUser("p6g-client@a.test", "P6g Client");
    otherManager = await createUser("p6g-other-manager@a.test", "P6g Other Manager");
    for (const [u, role, tenant] of [
      [manager, "manager", T], [member, "member", T], [staff, "webdev_staff", T], [clientOnly, "client", T], [otherManager, "manager", O],
    ] as const) {
      await addMembership(tenant, u);
      await grantRole(u, await createRole(role), "company", tenant);
    }
    app = await buildIsolatedApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("401 without a credential, on both routes", async () => {
    expect((await app.inject({ method: "POST", url: bindUrl(newId()) })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: prodUrl(newId()) })).statusCode).toBe(401);
  });

  it("403 for a member, a webdev_staff (read only) and a client-only principal, on both routes, with a VALID body; nothing changes", async () => {
    const s = await provisioned();
    const v = await vault();
    for (const u of [member, staff, clientOnly]) {
      expect((await bind(s.siteId, u, body(v))).statusCode, "bind").toBe(403);
      expect((await promote(s.siteId, u, { domain: "denied.example.test" })).statusCode, "production").toBe(403);
    }
    // a malformed body does not change the answer: authorization comes first
    expect((await bind(s.siteId, member, { nonsense: true })).statusCode).toBe(403);
    expect((await promote(s.siteId, member, {})).statusCode).toBe(403);
    expect(await row(s.siteId)).toMatchObject({ host_kind: "unknown", vault_ref: null });
    const n = await db().query(`SELECT count(*)::int AS n FROM webdev_sites WHERE promoted_from_site_id = $1`, [s.siteId]);
    expect(n.rows[0].n).toBe(0);
  });

  it("200 for a manager: bound, ready, an activity row, and the vault pointer is not echoed into the ledger", async () => {
    const s = await provisioned();
    const v = await vault();
    const r = await bind(s.siteId, manager, body(v));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: s.siteId, hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp", vaultRef: v, deliveryState: "ready" });
    const act = await db().query(
      `SELECT verb, metadata FROM activities WHERE target_entity_id = $1 AND target_entity_type = 'webdev_site'`, [s.siteId],
    );
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0].verb).toBe("updated");
    expect(act.rows[0].metadata).toMatchObject({ deliveryBound: true, hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp", deliveryState: "ready" });
    expect(JSON.stringify(act.rows[0].metadata)).not.toContain(v);
  });

  it("the body is CLOSED: a host, user, path or secret key is a 400 with a named token, and nothing is stored", async () => {
    const s = await provisioned();
    const v = await vault();
    for (const extra of [{ host: "ftp.example.com" }, { username: "u123" }, { path: "/public_html" }, { password: "x" }, { port: 22 }]) {
      const r = await bind(s.siteId, manager, body(v, extra));
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
      expect(r.json()).toMatchObject({ error: "binding_body_invalid" });
    }
    for (const [over, token] of [
      [{ hostRef: "deploy@ftp.example.com" }, "host_ref_invalid"],
      [{ hostRef: "/home/u1/public_html" }, "host_ref_invalid"],
      [{ hostRef: "ftp.example.com" }, "host_ref_invalid"],
      [{ hostKind: "client-cpanel" }, "host_kind_not_bindable"],
      [{ access: "cpanel" }, "access_not_bindable"],
      [{ vaultRef: "ftp://u:p@host/" }, "vault_ref_invalid"],
    ] as const) {
      const r = await bind(s.siteId, manager, body(v, over));
      expect(r.statusCode, token).toBe(400);
      expect(r.json()).toMatchObject({ error: token });
    }
    expect((await bind(s.siteId, manager, null)).statusCode).toBe(400);
    expect(await row(s.siteId)).toMatchObject({ host_kind: "unknown", host_ref: null, access: "none", vault_ref: null });
  });

  it("422 for another tenant's vault record and for an unknown one (same token); the row is unchanged", async () => {
    const s = await provisioned();
    const foreign = await vault(O);
    const a = await bind(s.siteId, manager, body(foreign));
    const b = await bind(s.siteId, manager, body(newId()));
    expect(a.statusCode).toBe(422);
    expect(a.json()).toMatchObject({ error: "vault_ref_unknown" });
    expect(b.statusCode).toBe(422);
    expect(b.json()).toEqual(a.json());
    expect((await bind(s.siteId, manager, body(await vault(T, "github")))).json()).toMatchObject({ error: "vault_ref_wrong_provider" });
    expect((await bind(s.siteId, manager, body(await vault(T, "ftp", "revoked")))).json()).toMatchObject({ error: "vault_ref_not_linked" });
    expect(await row(s.siteId)).toMatchObject({ host_kind: "unknown", vault_ref: null });
  });

  it("another tenant: its manager gets 404 on this tenant's site under its own tenant id, and 403 under ours", async () => {
    const s = await provisioned();
    const ov = await vault(O);
    expect((await bind(s.siteId, otherManager, body(ov), O)).statusCode).toBe(404);
    expect((await promote(s.siteId, otherManager, { domain: "takeover.example.test" }, O)).statusCode).toBe(404);
    expect((await bind(s.siteId, otherManager, body(await vault(T)))).statusCode).toBe(403);
    expect((await promote(s.siteId, otherManager, { domain: "takeover2.example.test" })).statusCode).toBe(403);
    expect(await row(s.siteId)).toMatchObject({ host_kind: "unknown", vault_ref: null });
    expect((await bind("not-a-uuid", manager, body(await vault()))).statusCode).toBe(404);
  });

  it("production: 201 for a manager, once only (409 production_row_exists), a held domain is 409 domain_taken, the body is closed; one activity row", async () => {
    const s = await provisioned();
    const r = await promote(s.siteId, manager, { domain: "p6g-prod.example.test" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      domain: "p6g-prod.example.test", environment: "production", origin: "provisioned", hostKind: "unknown", access: "none",
      deliveryState: "awaiting_deploy_credential",
    });
    const prodId = r.json().id as string;
    const act = await db().query(`SELECT verb, metadata FROM activities WHERE target_entity_id = $1`, [prodId]);
    expect(act.rows).toHaveLength(1);
    expect(act.rows[0]).toMatchObject({ verb: "created", metadata: { environment: "production", promotedFromSiteId: s.siteId } });

    const again = await promote(s.siteId, manager, { domain: "p6g-prod-2.example.test" });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "production_row_exists" });

    const s2 = await provisioned();
    const held = await promote(s2.siteId, manager, { domain: "p6g-prod.example.test" });
    expect(held.statusCode).toBe(409);
    expect(held.json()).toMatchObject({ error: "domain_taken" });
    expect(String(held.json().reason)).toContain("p6g-prod.example.test");

    expect((await promote(s2.siteId, manager, { domain: "x.example.test", extra: 1 })).json()).toMatchObject({ error: "production_body_invalid" });
    expect((await promote(s2.siteId, manager, {})).statusCode).toBe(400);
    expect((await promote(s2.siteId, manager, { domain: "placeholder.provisioned.invalid" })).json()).toMatchObject({ error: "production_domain_invalid" });
    expect((await promote(prodId, manager, { domain: "from-prod.example.test" })).json()).toMatchObject({ error: "not_a_provisioned_staging_row" });
  });

  it("GET provisioned-sites/:id shows the host side (`delivery`) beside the GitHub side (`deployGrant`) as two separate facts", async () => {
    const s = await provisioned();
    const get = async () => (await app.inject({ method: "GET", url: `/api/${T}/modules/webdev/provisioned-sites/${s.id}`, headers: asUser(manager) })).json();
    let g = await get();
    expect(g.delivery.environments).toEqual([
      expect.objectContaining({ siteId: s.siteId, environment: "staging", state: "awaiting_deploy_credential" }),
    ]);
    expect(g.deployGrant.state).toBeNull(); // no GitHub-side grant either, and the two are read separately
    await bind(s.siteId, manager, body(await vault()));
    g = await get();
    expect(g.delivery.environments[0]).toMatchObject({ state: "ready", hostKind: "shared-hosting", hostRef: "hostinger-1", access: "ftp" });
    expect(g.deployGrant.state).toBeNull(); // binding the host did not touch the grant
    expect(JSON.stringify(g.delivery)).not.toMatch(/vaultRef|password|secret/i);
    await promote(s.siteId, manager, { domain: "p6g-get-prod.example.test" });
    g = await get();
    expect(g.delivery.environments.map((e: { environment: string; state: string }) => `${e.environment}:${e.state}`)).toEqual([
      "staging:ready", "production:awaiting_deploy_credential",
    ]);
  });

  it("GET console/sites: the row carries `delivery` too (module-scoped read through the console controller)", async () => {
    // The console controller is a separate class; its own suite (console-reads-http) covers routing. This pins the service shape.
    const { getSiteRegistry } = await import("./console-reads.service");
    const s = await provisioned();
    const reg = await getSiteRegistry(T);
    expect(reg.sites.find((x) => x.id === s.id)!.delivery.environments.map((e) => e.state)).toEqual(["awaiting_deploy_credential"]);
  });
});
