// PV6-05 — the three agent tools for a client's Business drive the REAL staff routes. Each tool def in
// `clientsModule.mcpTools` is filled from its own pathTemplate and sent through app.inject, so a tool
// that points at the wrong route, or with the wrong method, fails here rather than in the hub.
// Modeled on clients-centre.db.test.ts (same harness). Needs DATABASE_URL_TEST + a live Cerbos; skips
// silently otherwise, so check the skip count.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../../config";
import { buildApp } from "../../../main";
import { resetModules } from "../../registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../../testing/fixtures";
import { clientsModule } from "../index";
import type { McpToolDef } from "../../contract";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

function tool(name: string): McpToolDef {
  const t = clientsModule.mcpTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} is not registered on the clients module`);
  return t;
}

/** Fill a tool's pathTemplate with real ids, exactly as the hub would before calling the route. */
function urlFor(t: McpToolDef, ids: Record<string, string>): string {
  return t.pathTemplate.replace(/:(\w+)/g, (_, k: string) => {
    const v = ids[k];
    if (!v) throw new Error(`no value for :${k} in ${t.pathTemplate}`);
    return v;
  });
}

describe.skipIf(!TEST_URL)("PV6-05 · clients.*Business* agent tools drive the real routes", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;   // company_admin — client read + update
  let viewer: string;  // viewer — client read only, no update
  let clientA: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    co = await createCompany("Centre Agent Tools Co", ["clients"]);
    admin = await createUser("centre-agent-admin@a.test");
    viewer = await createUser("centre-agent-viewer@a.test");
    await addMembership(co, admin);
    await addMembership(co, viewer);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    clientA = await createClient(co, "Agent Tool Co");

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const ids = () => ({ tenantId: co, clientId: clientA });

  it("getBusinessProfile is a GET on the centre route and returns the profile golden shape", async () => {
    const t = tool("clients.getBusinessProfile");
    expect(t.method).toBe("GET");
    const r = await app.inject({ method: "GET", url: urlFor(t, ids()), headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ clientId: clientA, clientName: "Agent Tool Co", canEdit: true });
    expect(body).toHaveProperty("businessType");
    expect(body).toHaveProperty("profile");
  });

  it("updateBusinessProfile is a PATCH on the same centre route and writes the field back", async () => {
    const t = tool("clients.updateBusinessProfile");
    expect(t.method).toBe("PATCH");
    const r = await app.inject({
      method: "PATCH", url: urlFor(t, ids()), headers: asUser(admin),
      payload: { profile: { legal: "Agent Tool Co Pte Ltd" } },
    });
    expect(r.statusCode).toBe(200);
    const back = await app.inject({ method: "GET", url: urlFor(tool("clients.getBusinessProfile"), ids()), headers: asUser(admin) });
    expect(back.json().profile.legal).toBe("Agent Tool Co Pte Ltd");
  });

  it("updateBusinessProfile refuses a principal without client update, with a typed reason", async () => {
    const t = tool("clients.updateBusinessProfile");
    const r = await app.inject({
      method: "PATCH", url: urlFor(t, ids()), headers: asUser(viewer),
      payload: { profile: { legal: "Should Not Land" } },
    });
    expect(r.statusCode).toBe(403);
    // authorize() names the denial reason in the message; the hub reads this as the typed reason.
    expect(r.json().message).toMatch(/^not authorized: /);
  });

  it("getBusinessResults is a GET on the results route and returns the results golden shape", async () => {
    const t = tool("clients.getBusinessResults");
    expect(t.method).toBe("GET");
    const r = await app.inject({ method: "GET", url: urlFor(t, ids()), headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ clientId: clientA });
    expect(typeof body.generatedAt).toBe("string");
    expect(Array.isArray(body.services)).toBe(true);
    expect(Array.isArray(body.unavailable)).toBe(true);
  });
});
