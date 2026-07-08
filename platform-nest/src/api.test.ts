// Tasks 4.3–4.6: module enable-gate, RBAC enforcement + decision audit, D4 principal
// resolution, core CRUD with D17 custom-field validation — against live Postgres + RLS.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "./config";
import { withTenants, withGlobal } from "./db";
import { registerModule, resetModules } from "./modules/registry";
import { agencyModule } from "./modules/agency";
import { buildApp } from "./main";
import { initTestDb, teardownTestDb, TEST_URL } from "./testing/setup";
import {
  createCompany,
  createUser,
  addMembership,
  createRole,
  grantRole,
  linkIdentity,
  defineCustomField,
} from "./testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("platform API", () => {
  let app: NestFastifyApplication;
  let tenantA: string;
  let tenantB: string;
  let manager: string;
  let member: string;
  let outsider: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenantA = await createCompany("Agency A", ["agency"]);
    tenantB = await createCompany("Resort B");

    manager = await createUser("manager@a.test");
    member = await createUser("member@a.test");
    outsider = await createUser("outsider@b.test");
    await addMembership(tenantA, manager);
    await addMembership(tenantA, member);
    await addMembership(tenantB, outsider);

    const managerRole = await createRole("manager");
    const memberRole = await createRole("member");
    await grantRole(manager, managerRole, "company", tenantA);
    await grantRole(member, memberRole, "company", tenantA);
    await grantRole(outsider, memberRole, "company", tenantB);

    await linkIdentity(member, "telegram", "tg:555", true);
    await linkIdentity(outsider, "whatsapp", "628999@c.us", false); // unverified

    // NestJS port: the enable-gate contract is exercised with the real agency module
    // (tenantA enables "agency"; tenantB does not) instead of the Fastify-era inline demo module.
    resetModules();
    registerModule(agencyModule);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("fail-closed service auth: no token → 401; no acting user → 401", async () => {
    expect((await app.inject({ method: "GET", url: `/api/${tenantA}/projects` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: svc })).statusCode).toBe(401);
  });

  it("manager creates a project; the mutation is recorded in activities", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenantA}/projects`,
      headers: asUser(manager),
      payload: { name: "Website relaunch" },
    });
    expect(r.statusCode).toBe(201);
    const acts = await withTenants([tenantA], (c) =>
      c.query(`SELECT verb, target_entity_type FROM activities WHERE verb = 'created'`),
    );
    expect(acts.rows).toContainEqual({ verb: "created", target_entity_type: "project" });
  });

  it("member reads projects; outsider from another tenant is denied AND the deny is audited", async () => {
    const ok = await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: asUser(member) });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as unknown[]).length).toBe(1);

    const denied = await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: asUser(outsider) });
    expect(denied.statusCode).toBe(403);
    const denials = await withTenants([tenantA], (c) =>
      c.query(`SELECT metadata FROM activities WHERE verb = 'authz.deny'`),
    );
    expect(denials.rows.length).toBeGreaterThan(0);
  });

  it("D17: custom fields validated on write (unknown key, wrong type, missing required)", async () => {
    await defineCustomField(tenantA, "task", "storey", "number", true);
    const projects = await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: asUser(member) });
    const projectId = (projects.json() as Array<{ id: string }>)[0].id;
    const url = `/api/${tenantA}/projects/${projectId}/tasks`;

    const missing = await app.inject({ method: "POST", url, headers: asUser(member), payload: { title: "t1" } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain("required");

    const wrongType = await app.inject({
      method: "POST", url, headers: asUser(member),
      payload: { title: "t1", customFields: { storey: "three" } },
    });
    expect(wrongType.statusCode).toBe(400);

    const unknown = await app.inject({
      method: "POST", url, headers: asUser(member),
      payload: { title: "t1", customFields: { storey: 3, bogus: 1 } },
    });
    expect(unknown.statusCode).toBe(400);

    const ok = await app.inject({
      method: "POST", url, headers: asUser(member),
      payload: { title: "t1", customFields: { storey: 3 } },
    });
    expect(ok.statusCode).toBe(201);
  });

  it("module gate: enabled tenant reaches the module route; others get 404", async () => {
    const on = await app.inject({ method: "GET", url: `/api/${tenantA}/modules/agency/campaigns`, headers: asUser(member) });
    expect(on.statusCode).toBe(200);
    const off = await app.inject({ method: "GET", url: `/api/${tenantB}/modules/agency/campaigns`, headers: asUser(outsider) });
    expect(off.statusCode).toBe(404);
  });

  it("D4: /principal/resolve — verified link → linked principal; unverified/unknown → low, no companies", async () => {
    const linked = await app.inject({
      method: "POST", url: "/principal/resolve", headers: svc,
      payload: { provider: "telegram", externalId: "tg:555" },
    });
    const p = linked.json();
    expect(p.assurance).toBe("linked");
    expect(p.companies).toContain(tenantA);
    expect(p.roles.some((r: { role: string }) => r.role === "member")).toBe(true);

    const unverified = await app.inject({
      method: "POST", url: "/principal/resolve", headers: svc,
      payload: { provider: "whatsapp", externalId: "628999@c.us" },
    });
    expect(unverified.json().assurance).toBe("low");
    expect(unverified.json().companies).toEqual([]);

    const unknown = await app.inject({
      method: "POST", url: "/principal/resolve", headers: svc,
      payload: { provider: "whatsapp", externalId: "nobody" },
    });
    expect(unknown.json().assurance).toBe("low");
    expect(unknown.json().userId).toBeNull();
  });

  it("OBO envelope on the API (Task 4.9): verified link reads its tenant; unverified gets nothing", async () => {
    const linked = await app.inject({
      method: "GET",
      url: `/api/${tenantA}/projects`,
      headers: { ...svc, "x-obo-provider": "telegram", "x-obo-external-id": "tg:555" },
    });
    expect(linked.statusCode).toBe(200);

    const unverified = await app.inject({
      method: "GET",
      url: `/api/${tenantB}/projects`,
      headers: { ...svc, "x-obo-provider": "whatsapp", "x-obo-external-id": "628999@c.us" },
    });
    expect(unverified.statusCode).toBe(403); // minimal principal → deny-by-default
  });

  it("D11: a disabled user is cut off immediately", async () => {
    await withGlobal((c) =>
      c.query(`UPDATE users SET status = 'disabled', session_version = session_version + 1 WHERE id = $1`, [member]),
    );
    const r = await app.inject({ method: "GET", url: `/api/${tenantA}/projects`, headers: asUser(member) });
    expect(r.statusCode).toBe(401);
    await withGlobal((c) => c.query(`UPDATE users SET status = 'active' WHERE id = $1`, [member]));
  });
});
