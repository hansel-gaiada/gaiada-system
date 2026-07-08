// Ported parity oracle (from platform/src/me.api.test.ts) — runs UNCHANGED in intent against
// the NestJS app via buildApp()/app.inject. /api/me, tenant activity, cross-project tasks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "./config";
import { withTenants, newId } from "./db";
import { resetModules } from "./modules/registry";
import { buildApp } from "./main";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "./testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("me / activity / tasks API (nest)", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let hansel: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    tenant = await createCompany("Gaiada HQ");
    hansel = await createUser("hansel@gaiada.com", "Clement Hansel", "AI Manager");
    await addMembership(tenant, hansel);
    const managerRole = await createRole("manager");
    await grantRole(hansel, managerRole, "company", tenant);
    app = await buildApp();

    const projectId = newId();
    const taskId = newId();
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO projects (id, tenant_id, name, owner_id, origin_site) VALUES ($1,$2,$3,$4,$5)`,
        [projectId, tenant, "ERP UI build", hansel, "main"],
      );
      await c.query(
        `INSERT INTO tasks (id, tenant_id, project_id, title, assignee_id, due_date, origin_site)
         VALUES ($1,$2,$3,$4,$5, now()::date, $6)`,
        [taskId, tenant, projectId, "Port design system", hansel, "main"],
      );
    });
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("GET /api/me returns principal + profile + companies", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me", headers: asUser(hansel) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("Clement Hansel");
    expect(body.title).toBe("AI Manager");
    expect(body.companies.map((c: { name: string }) => c.name)).toContain("Gaiada HQ");
    expect(body.roles.some((r: { role: string }) => r.role === "manager")).toBe(true);
  });

  it("GET /api/:tenantId/tasks?assignee=me returns my tasks with project name", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/tasks?assignee=me`, headers: asUser(hansel) });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Port design system");
    expect(rows[0].project_name).toBe("ERP UI build");
  });

  it("GET /api/:tenantId/activity returns recent audit rows with actor name", async () => {
    const create = await app.inject({
      method: "POST", url: `/api/${tenant}/projects`, headers: asUser(hansel), payload: { name: "Second project" },
    });
    expect(create.statusCode).toBe(201);
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/activity?limit=5`, headers: asUser(hansel) });
    expect(res.statusCode).toBe(200);
    const rows = res.json();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].verb).toBe("created");
    expect(rows[0].actor_name).toBe("Clement Hansel");
  });

  it("GET /api/:tenantId/activity?limit=-5 clamps to a positive limit instead of erroring", async () => {
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/activity?limit=-5`, headers: asUser(hansel) });
    expect(res.statusCode).toBe(200);
  });

  it("outsider without membership gets 403 on tasks/activity", async () => {
    const outsider = await createUser("outsider@x.test");
    const res = await app.inject({ method: "GET", url: `/api/${tenant}/tasks?assignee=me`, headers: asUser(outsider) });
    expect(res.statusCode).toBe(403);
  });

  it("dev login lookup resolves email → user id (service token required)", async () => {
    const ok = await app.inject({ method: "GET", url: "/dev/user-by-email?email=hansel@gaiada.com", headers: svc });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(hansel);
    const noAuth = await app.inject({ method: "GET", url: "/dev/user-by-email?email=hansel@gaiada.com" });
    expect(noAuth.statusCode).toBe(401);
  });
});
