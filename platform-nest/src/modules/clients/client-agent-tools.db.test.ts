// PV7-08 — the four agent tools for client health and client reports drive the REAL staff routes. Each tool def in
// `clientsModule.mcpTools` is filled from its own pathTemplate and sent through app.inject, so a tool pointing at the wrong
// route or method fails here, not in the hub. Same harness as centre-agent-tools.db.test.ts (PV6-05). Needs DATABASE_URL_TEST
// + a live Cerbos; skips silently otherwise, so check the skip count.
// The hub reads tools from GET /mcp/tool-defs at runtime (mcp-hub/src/module-tools.ts), so registering them here is what
// publishes them; there is no hub allow-list to update.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../../testing/fixtures";
import { withGlobal } from "../../db";
import { clientsModule } from "./index";
import type { McpToolDef } from "../contract";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

function tool(name: string): McpToolDef {
  const t = clientsModule.mcpTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} is not registered on the clients module`);
  return t;
}

/** Fill a tool's pathTemplate with real ids, exactly as the hub would before calling the route. */
function urlFor(t: McpToolDef, ids: Record<string, string>): string {
  const template = t.pathTemplate;
  if (!template) throw new Error(`tool ${t.name} has no pathTemplate`);
  return template.replace(/:(\w+)/g, (_, k: string) => {
    const v = ids[k];
    if (!v) throw new Error(`no value for :${k} in ${template}`);
    return v;
  });
}

describe("PV7-08 · registration (pure)", () => {
  it("registers the four tools with the briefed method, path and impact", () => {
    const want: Array<[string, string, string, boolean]> = [
      ["clients.getHealthBoard", "GET", "/api/:tenantId/clients/health", false],
      ["clients.getHealth", "GET", "/api/:tenantId/clients/:clientId/health", false],
      ["clientReports.list", "GET", "/api/:tenantId/clients/:clientId/reports", false],
      ["clientReports.draftSummary", "POST", "/api/:tenantId/clients/:clientId/reports/summary", true],
    ];
    for (const [name, method, path, write] of want) {
      const t = tool(name);
      expect(t.method).toBe(method);
      expect(t.pathTemplate).toBe(path);
      expect(!!t.write, name).toBe(write);
      if (write) expect(t.impact).toBe("low");
      else expect(t.impact).toBeUndefined();
    }
  });

  it("publish and withdraw of a client report are NOT agent tools (L6: staff only)", () => {
    for (const t of clientsModule.mcpTools) {
      expect(t.pathTemplate ?? "", t.name).not.toMatch(/client-reports\/.*\/(publish|withdraw)/);
      expect(t.pathTemplate ?? "", t.name).not.toMatch(/\/(publish|withdraw)$/);
      expect(t.name, t.name).not.toMatch(/publish|withdraw/i);
    }
  });
});

describe.skipIf(!TEST_URL)("PV7-08 · client health and client reports agent tools drive the real routes", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;    // company_admin
  let viewer: string;   // viewer: reads, may not draft
  let outsider: string; // no membership, no role
  let contact: string;  // a client contact
  let agent: string;    // manager, users.kind = 'automation'
  let clientA: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    co = await createCompany("Client Agent Tools Co", ["clients", "invoice", "pm", "social", "webdev", "monitoring", "reports"]);
    admin = await createUser("pv708-admin@a.test", "Ada Admin");
    viewer = await createUser("pv708-viewer@a.test");
    outsider = await createUser("pv708-outsider@a.test");
    contact = await createUser("pv708-contact@a.test");
    agent = await createUser("pv708-agent@a.test");
    for (const u of [admin, viewer, contact, agent]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(viewer, await createRole("viewer"), "company", co);
    await grantRole(contact, await createRole("client"), "company", co);
    await grantRole(agent, await createRole("manager"), "company", co);
    await withGlobal((q) => q.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [contact]));
    await withGlobal((q) => q.query(`UPDATE users SET kind = 'automation' WHERE id = $1`, [agent]));
    clientA = await createClient(co, "Agent Health Co");

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const ids = () => ({ tenantId: co, clientId: clientA });
  const call = (name: string, user: string, payload?: unknown) => {
    const t = tool(name);
    return app.inject({
      method: t.method as "GET" | "POST", url: urlFor(t, ids()), headers: asUser(user),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  };

  it("getHealthBoard returns the board exactly as the route does, and refuses a non-member and a client contact", async () => {
    const r = await call("clients.getHealthBoard", admin);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    const direct = await app.inject({ method: "GET", url: `/api/${co}/clients/health`, headers: asUser(admin) });
    expect(r.json()).toEqual(direct.json());
    expect(JSON.stringify(r.json())).toContain(clientA);
    for (const u of [outsider, contact]) {
      const d = await call("clients.getHealthBoard", u);
      expect(d.statusCode).toBe(403);
      expect(d.json().error).toMatch(/^not authorized: /);
    }
  });

  it("getHealth returns one client's health exactly as the route does, and refuses a non-member", async () => {
    const r = await call("clients.getHealth", admin);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    const direct = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientA}/health`, headers: asUser(admin) });
    expect(r.json()).toEqual(direct.json());
    expect((await call("clients.getHealth", outsider)).statusCode).toBe(403);
  });

  it("list returns the staff list as the route does, and refuses a non-member and a client contact", async () => {
    const r = await call("clientReports.list", admin);
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    expect(Array.isArray(r.json().reports)).toBe(true);
    for (const u of [outsider, contact]) expect((await call("clientReports.list", u)).statusCode).toBe(403);
  });

  it("draftSummary creates a draft, a second call returns the SAME draft (created: false), and it shows in the list", async () => {
    const first = await call("clientReports.draftSummary", admin, { period: "2026-09" });
    expect(first.statusCode, first.body.slice(0, 300)).toBe(200);
    expect(first.json().created).toBe(true);
    expect(first.json().report.status).toBe("draft");
    const second = await call("clientReports.draftSummary", admin, { period: "2026-09" });
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().report.id).toBe(first.json().report.id);
    const list = (await call("clientReports.list", admin)).json().reports as Array<{ id: string; status: string }>;
    expect(list.filter((x) => x.id === first.json().report.id)).toHaveLength(1);
  });

  it("draftSummary: an agent (automation) may draft; a viewer and a non-member are refused, even with a malformed body", async () => {
    const ok = await call("clientReports.draftSummary", agent, { period: "2026-08" });
    expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
    for (const u of [viewer, outsider]) {
      const d = await call("clientReports.draftSummary", u, { period: "nonsense" });
      expect(d.statusCode).toBe(403);
      expect(d.json().error).toMatch(/^not authorized: /);
    }
  });

  it("the agent principal cannot publish or withdraw through the routes either (Cerbos, L6)", async () => {
    const made = await call("clientReports.draftSummary", agent, { period: "2026-07" });
    const id = made.json().report.id as string;
    const pub = await app.inject({ method: "POST", url: `/api/${co}/client-reports/${id}/publish`, headers: asUser(agent) });
    expect(pub.statusCode).toBe(403);
    const wd = await app.inject({
      method: "POST", url: `/api/${co}/client-reports/${id}/withdraw`, headers: asUser(agent), payload: { reason: "x" },
    });
    expect(wd.statusCode).toBe(403);
  });
});
