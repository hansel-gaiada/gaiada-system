// W0 — proof that a contact provisioned by the INVITE flow can actually use the portal.
//
// This is the gap that made the whole of W0 inert and that no existing test could catch:
// `PortalController.callerClientId()` resolved clients ONLY via the legacy `clients.portal_user_id`
// column, which the invite/accept flow never writes. So an invited contact could accept, get a
// Keycloak account, receive the `client` role, gain the tenant through principal.ts's client_contacts
// union, pass `resource_portal` authz — and then be refused with "not a portal client". Every step
// upstream reported success and the portal showed nothing.
//
// `portal.test.ts` covers the legacy scheme and therefore proved nothing about this path. These tests
// exercise the client_contacts route with NO `portal_user_id` row anywhere, which is the only
// configuration the invite flow actually produces.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function addContact(
  tenantId: string,
  clientId: string,
  userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null } = {},
): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "signer", opts.status ?? "active", config.originSite],
    ),
  );
  return id;
}

async function makeRun(tenantId: string, clientId: string, projectId: string | null, title: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO pipeline_runs (id, tenant_id, client_id, project_id, title, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'extracting', $6)`,
      [id, tenantId, clientId, projectId, title, config.originSite],
    ),
  );
  return id;
}

describe.skipIf(!TEST_URL)("W0: the portal admits a client_contacts-provisioned contact", () => {
  let app: NestFastifyApplication;
  let co: string;
  let clientA: string;
  let clientB: string;
  let projX: string;
  let projY: string;
  let clientRole: string;

  // one contact per shape, so each test asserts exactly one thing
  let wide: string; // active, client-wide, clientA
  let scoped: string; // active, scoped to projX only
  let invited: string;
  let revoked: string;
  let dual: string; // active on BOTH clients — the D-1 many-clients case
  let runAX: string;
  let runAY: string;
  let runB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    clientRole = await createRole("client");

    clientA = await createClient(co, "Bali Beach Resort");
    clientB = await createClient(co, "Nusa Coffee Co");
    projX = await createProject(co, "Rebrand X");
    projY = await createProject(co, "Microsite Y");
    await withTenants([co], (c) =>
      c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projX, clientA]),
    );
    await withTenants([co], (c) =>
      c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projY, clientA]),
    );

    runAX = await makeRun(co, clientA, projX, "A/X run");
    runAY = await makeRun(co, clientA, projY, "A/Y run");
    runB = await makeRun(co, clientB, null, "B run");

    for (const [name, setup] of [
      ["wide@client.test", async (u: string) => addContact(co, clientA, u, {})],
      ["scoped@client.test", async (u: string) => addContact(co, clientA, u, { projectId: projX })],
      ["invited@client.test", async (u: string) => addContact(co, clientA, u, { status: "invited" })],
      ["revoked@client.test", async (u: string) => addContact(co, clientA, u, { status: "revoked" })],
    ] as const) {
      const u = await createUser(name);
      await setup(u);
      await grantRole(u, clientRole, "company", co);
      if (name.startsWith("wide")) wide = u;
      if (name.startsWith("scoped")) scoped = u;
      if (name.startsWith("invited")) invited = u;
      if (name.startsWith("revoked")) revoked = u;
    }
    dual = await createUser("dual@client.test");
    await addContact(co, clientA, dual, {});
    await addContact(co, clientB, dual, {});
    await grantRole(dual, clientRole, "company", co);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("admits a client-wide contact with NO portal_user_id and NO company_membership", async () => {
    // The payoff of W0-2: principal.ts unions client_contacts into principal.companies, so the tenant
    // (and therefore Cerbos's `inTenant`) holds without a staff membership row. If this 403s, the
    // union regressed; if it 404s, the resolver regressed.
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(wide) });
    expect(r.statusCode).toBe(200);
    const titles = (r.json() as { title: string }[]).map((x) => x.title).sort();
    expect(titles).toEqual(["A/X run", "A/Y run"]);
  });

  it("does NOT show another client's runs", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(wide) });
    expect((r.json() as { title: string }[]).map((x) => x.title)).not.toContain("B run");
  });

  it("a PROJECT-SCOPED contact sees only that project's runs (D-1 scoping is enforced, not cosmetic)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(scoped) });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { title: string }[]).map((x) => x.title)).toEqual(["A/X run"]);
  });

  it("a project-scoped contact cannot open a run outside their project", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${co}/portal/runs/${runAX}`, headers: asUser(scoped) });
    expect(ok.statusCode).toBe(200);
    const denied = await app.inject({ method: "GET", url: `/api/${co}/portal/runs/${runAY}`, headers: asUser(scoped) });
    // 404 rather than 403: the run is simply not in their world, and a 403 would confirm it exists.
    expect(denied.statusCode).toBe(404);
  });

  it("a contact on TWO clients sees both (D-1's many-clients case)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(dual) });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { title: string }[]).map((x) => x.title).sort()).toEqual(["A/X run", "A/Y run", "B run"]);
  });

  it("an INVITED contact is refused — status governs access, and they have no account yet", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(invited) });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("a REVOKED contact is refused", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(revoked) });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("a staff member is still not a portal client", async () => {
    // The portal is not a staff surface by accident: a member of the tenant with no contact row must
    // not fall through into it.
    const staff = await createUser("staff@cc-portal.test");
    await addMembership(co, staff);
    await grantRole(staff, await createRole("member"), "company", co);
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(staff) });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("a client-wide grant WIDENS access even alongside a narrower project row", async () => {
    // Adding a project-scoped row to someone who already had client-wide access must not TAKE access
    // away — the resolver treats any client-wide row as unrestricted.
    const both = await createUser("both-scopes@client.test");
    await addContact(co, clientA, both, {});
    await addContact(co, clientA, both, { projectId: projX });
    await grantRole(both, clientRole, "company", co);
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/runs`, headers: asUser(both) });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { title: string }[]).map((x) => x.title).sort()).toEqual(["A/X run", "A/Y run"]);
  });
});
