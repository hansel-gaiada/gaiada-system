import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";

// Lineage spec 4/4 — a project belongs to a client. The one client-less shape is the company's own
// work, and it must be declared (`isInternal: true`). An omitted client is a 400 on the field, never
// a silent NULL: that silence is how `client_id IS NULL` came to mean two things on the live estate.
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("projects belong to a client (lineage spec 4/4)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let rival: string;
  let admin: string;
  let rivalAdmin: string;
  let client: string;
  let rivalClient: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Gaiada Creative");
    rival = await createCompany("Rival Co");
    admin = await createUser("admin@projects.test");
    rivalAdmin = await createUser("admin@rival-projects.test");
    await addMembership(co, admin);
    await addMembership(rival, rivalAdmin);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(rivalAdmin, await createRole("company_admin"), "company", rival);
    client = await createClient(co, "Northwind");
    rivalClient = await createClient(rival, "Rival's client");
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const row = (id: string) =>
    withTenants([co], (c) =>
      c.query<{ client_id: string | null; is_internal: boolean }>(`SELECT client_id, is_internal FROM projects WHERE id = $1`, [id]),
    ).then((r) => r.rows[0]);
  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${co}/projects`, headers: asUser(admin), payload });

  it("a project with neither a client nor an internal declaration is refused on the clientId field", async () => {
    const r = await create({ name: "Orphan" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "clientId" });
    expect(String(r.json().error)).toMatch(/clientId required/);
  });

  // ORDERING, not shape. The gate above is thrown from inside the handler, so it only says what it
  // means if `authorize` has already run. When it did not, a caller with no rights on `co` received
  // a field-level description of the create contract instead of a denial — and, worse, every
  // denial-path test that posts an incomplete payload silently degraded from asserting 403 to
  // asserting a payload 400 (seed/automation.test.ts's unseeded-workflow probe did exactly that).
  // rivalAdmin is a real, resolvable principal — company_admin of `rival`, nothing on `co`.
  it("a caller who may not create here is denied on identity, not handed the clientId contract", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/projects`, headers: asUser(rivalAdmin),
      payload: { name: "Orphan" }, // invalid on purpose: no clientId, no isInternal
    });
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.json())).not.toMatch(/clientId/);
  });

  it("a client's project stores the client and is not internal", async () => {
    const r = await create({ name: "Northwind relaunch", clientId: client });
    expect(r.statusCode).toBe(201);
    expect(await row(r.json().id)).toEqual({ client_id: client, is_internal: false });
  });

  it("the company's own work is allowed when declared internal — and is flagged as such", async () => {
    const r = await create({ name: "Office move", isInternal: true });
    expect(r.statusCode).toBe(201);
    expect(await row(r.json().id)).toEqual({ client_id: null, is_internal: true });
  });

  it("a project cannot be both a client's and internal", async () => {
    const r = await create({ name: "Both", clientId: client, isInternal: true });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "isInternal" });
  });

  it("another tenant's client is 'unknown' here — 400 on the field, not a cross-tenant link", async () => {
    const r = await create({ name: "Smuggled", clientId: rivalClient });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "clientId" });
  });

  it("a malformed clientId is a 400 on the field, not a 500 on a uuid cast", async () => {
    const r = await create({ name: "Typo", clientId: "not-a-uuid" });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ field: "clientId" });
  });

  describe("PATCH", () => {
    it("detaching a project from its client is refused (it used to be a silent COALESCE no-op)", async () => {
      const id = (await create({ name: "Attached", clientId: client })).json().id as string;
      const r = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(admin), payload: { clientId: null } });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ field: "clientId" });
      expect((await row(id)).client_id).toBe(client);
    });

    it("giving an internal project a client converts it", async () => {
      const id = (await create({ name: "Was internal", isInternal: true })).json().id as string;
      const r = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(admin), payload: { clientId: client } });
      expect(r.statusCode).toBe(200);
      expect(await row(id)).toEqual({ client_id: client, is_internal: false });
    });

    it("an unknown or foreign client is refused on the field", async () => {
      const id = (await create({ name: "Stays", clientId: client })).json().id as string;
      const r = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(admin), payload: { clientId: rivalClient } });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ field: "clientId" });
      expect((await row(id)).client_id).toBe(client);
    });

    it("a PATCH that does not mention the client leaves it alone (archiving a legacy client-less row still works)", async () => {
      const id = (await create({ name: "Legacy-ish", isInternal: true })).json().id as string;
      const r = await app.inject({ method: "PATCH", url: `/api/${co}/projects/${id}`, headers: asUser(admin), payload: { status: "archived" } });
      expect(r.statusCode).toBe(200);
      expect(await row(id)).toEqual({ client_id: null, is_internal: true });
    });
  });
});
