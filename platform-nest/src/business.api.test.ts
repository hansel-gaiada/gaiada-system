// Plan 2 platform additions — detail/update/members/custom-fields/agency-briefs — live PG + RLS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "./config";
import { newId, withTenants } from "./db";
import { resetModules, registerModule } from "./modules/registry";
import { agencyModule } from "./modules/agency";
import { buildApp } from "./main";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, defineCustomField } from "./testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("business API — projects/members", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let manager: string;
  let projectId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(agencyModule);
    tenant = await createCompany("Gaiada HQ", ["agency"]);
    manager = await createUser("mgr@gaiada.com", "Manager One", "Ops Lead");
    await addMembership(tenant, manager);
    await grantRole(manager, await createRole("manager"), "company", tenant);
    app = await buildApp();

    projectId = newId();
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO projects (id, tenant_id, name, owner_id, origin_site) VALUES ($1,$2,$3,$4,'main')`,
        [projectId, tenant, "Alpha", manager]),
    );
  });
  afterAll(async () => { await app?.close(); await teardownTestDb(); });

  it("GET project detail returns owner name + fields", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: projectId, name: "Alpha", owner_name: "Manager One" });
  });

  it("GET project detail 404s for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/projects/${newId()}`, headers: asUser(manager) });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH project updates status + validated custom field, audits", async () => {
    await defineCustomField(tenant, "project", "phase", "text", false);
    const res = await app.inject({
      method: "PATCH", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager),
      payload: { status: "on_hold", customFields: { phase: "discovery" } },
    });
    expect(res.statusCode).toBe(200);
    const check = await app.inject({ method: "GET", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager) });
    expect(check.json().status).toBe("on_hold");
    expect(check.json().custom_fields.phase).toBe("discovery");
  });

  it("PATCH rejects an unknown custom field with 400", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/${tenant}/projects/${projectId}`, headers: asUser(manager),
      payload: { customFields: { bogus: "x" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET members lists active memberships with names", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/members`, headers: asUser(manager) });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.some((m: { name: string }) => m.name === "Manager One")).toBe(true);
  });
});
