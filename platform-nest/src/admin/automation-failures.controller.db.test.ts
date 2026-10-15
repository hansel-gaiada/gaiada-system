// DW-7i-1 (BFF §52.12) — GET /api/:tenantId/automation/failures over the real HTTP surface (buildApp + app.inject) against live
// Postgres, with n8n faked by a stub HTTP server the controller really fetches from. Covers: 403 `not_in_audience` and 404 (module
// off, the platform operator still answered), `on`, `not_configured`, `unavailable` (down, 401, wrong shape: never `[]`), the window,
// the 200 cap with the full `count`, the page cap, the name fallback and 400 `window`.
//
// ⚠ Needs DATABASE_URL_TEST (CI only: no local Postgres). Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { addMembership, createCompany, createRole, createUser, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Run = { id: string; workflowId: string; status: string; mode: string; startedAt: string; stoppedAt: string };
const H = 3_600_000;
const run = (id: number, agoMs: number, workflowId = "wf1"): Run => ({
  id: String(id), workflowId, status: "error", mode: "trigger",
  startedAt: new Date(Date.now() - agoMs).toISOString(), stoppedAt: new Date(Date.now() - agoMs + 2000).toISOString(),
});

describe.skipIf(!TEST_URL)("DW-7i-1 failing workflows route (live PG)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let on: string;
  let off: string;
  let owner: string;
  let admin: string; // company_admin only
  let itAdmin: string;
  let gm: string;
  let operator: string;
  let outsider: string;

  // what the stub answers, per test
  let executions: (cursor: string | null) => { status: number; body: unknown };
  let workflows: { status: number; body: unknown };
  let executionCalls: string[];
  // The stub's address, kept here: cases blank `config.services.automation.url`, so restoring from config would restore a blank.
  let stubUrl = "";

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub");
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers["x-n8n-api-key"] !== "n8n-key") return send(401, { message: "unauthorized" });
      if (url.pathname === "/api/v1/executions") {
        executionCalls.push(url.search);
        const r = executions(url.searchParams.get("cursor"));
        return send(r.status, r.body);
      }
      if (url.pathname === "/api/v1/workflows") return send(workflows.status, workflows.body);
      return send(404, {});
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    config.services.automation = { url: stubUrl, token: "n8n-key" };
    config.automationPublicUrl = "https://erp.example.test/n8n";

    on = await createCompany("DW-7i-1 On", ["automation-console"]);
    off = await createCompany("DW-7i-1 Off", []);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = ANY($1::uuid[])`, [[on, off]]));

    owner = await createUser("owner@dw7i1http.test");
    admin = await createUser("admin@dw7i1http.test");
    itAdmin = await createUser("it@dw7i1http.test");
    gm = await createUser("gm@dw7i1http.test");
    operator = await createUser("operator@dw7i1http.test");
    outsider = await createUser("outsider@dw7i1http.test");
    for (const t of [on, off]) for (const u of [owner, admin, itAdmin, gm]) await addMembership(t, u);

    const ownerRole = await createRole("owner");
    const adminRole = await createRole("company_admin");
    const itRole = await createRole("it_admin");
    const platformRole = await createRole("platform_admin");
    for (const t of [on, off]) {
      await grantRole(owner, ownerRole, "company", t);
      await grantRole(admin, adminRole, "company", t);
      await grantRole(itAdmin, itRole, "company", t);
    }
    await grantRole(operator, platformRole, "global", null);

    // the GM: lead seat of the company's GM unit
    const seatId = newId();
    await withTenants([on], async (c) => {
      const root = {
        id: `root-${on}`, name: "Root", kind: "company", assigneeId: null, assigneeName: null,
        children: [{ id: "d-gm", name: "GM", kind: "department", assigneeId: null, assigneeName: null, children: [] }],
      };
      await c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)`, [on, JSON.stringify({ root }), config.originSite]);
      await c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title, is_lead) VALUES ($1,$2,'d-gm','General Manager',true)`, [seatId, on]);
      await c.query(`INSERT INTO position_assignments (tenant_id, position_id, user_id) VALUES ($1,$2,$3)`, [on, seatId, gm]);
    });

    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((r) => stub?.close(() => r()));
    await teardownTestDb();
  });

  beforeEach(() => {
    executionCalls = [];
    workflows = { status: 200, body: { data: [{ id: "wf1", name: "Chase invoices" }] } };
    executions = () => ({ status: 200, body: { data: [run(1, 2 * H)] } });
    config.services.automation = { url: stubUrl, token: "n8n-key" };
  });

  const get = (tenant: string, as: string, qs = "") =>
    app.inject({ method: "GET", url: `/api/${tenant}/automation/failures${qs}`, headers: asUser(as) });
  type Answer = { asOf: string; window: string; state: string; reason?: string; failed: Array<{ executionId: string; workflowName: string }>; count: number; capped?: boolean; editorUrl?: string };

  it("403 not_in_audience for IT staff, company_admin and someone with no grant", async () => {
    for (const who of [itAdmin, admin, outsider]) {
      const r = await get(on, who);
      expect(r.statusCode).toBe(403);
      expect(r.json()).toMatchObject({ reason: "not_in_audience" });
    }
    expect(executionCalls).toHaveLength(0); // never reached n8n
  });

  it("404 where the module is off, for the owner; the platform operator is answered", async () => {
    expect((await get(off, owner)).statusCode).toBe(404);
    const r = await get(off, operator);
    expect(r.statusCode).toBe(200);
    expect((r.json() as Answer).state).toBe("on");
  });

  it("the owner and the GM get the list, with the editor origin", async () => {
    for (const who of [owner, gm, operator]) {
      const r = await get(on, who);
      expect(r.statusCode).toBe(200);
      const a = r.json() as Answer;
      expect(a).toMatchObject({ window: "24h", state: "on", count: 1, editorUrl: "https://erp.example.test/n8n" });
      expect(a.failed[0]).toMatchObject({ executionId: "1", workflowName: "Chase invoices" });
    }
    expect(executionCalls[0]).toContain("status=error");
  });

  it("the window: 24h drops a run 30h old, 7d keeps it; anything else is 400 window", async () => {
    executions = () => ({ status: 200, body: { data: [run(1, 2 * H), run(2, 30 * H)] } });
    expect((await get(on, owner)).json<Answer>().count).toBe(1);
    expect((await get(on, owner, "?window=7d")).json<Answer>().count).toBe(2);
    const bad = await get(on, owner, "?window=1y");
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ field: "window" });
  });

  it("validation never pre-empts a 403", async () => {
    expect((await get(on, itAdmin, "?window=1y")).statusCode).toBe(403);
  });

  it("answers at most 200 runs and counts all of them", async () => {
    executions = () => ({ status: 200, body: { data: Array.from({ length: 250 }, (_, i) => run(i + 1, (i + 1) * 1000)) } });
    const a = (await get(on, owner)).json<Answer>();
    expect(a.failed).toHaveLength(200);
    expect(a.count).toBe(250);
  });

  it("pages through nextCursor and says so when the page cap cuts the window short", async () => {
    executions = (cursor) => {
      const n = cursor ? Number(cursor) : 0;
      return { status: 200, body: { data: [run(n * 2 + 1, (n + 1) * 60_000), run(n * 2 + 2, (n + 1) * 60_000 + 1)], nextCursor: String(n + 1) } };
    };
    const a = (await get(on, owner)).json<Answer>();
    expect(executionCalls).toHaveLength(5);
    expect(a).toMatchObject({ state: "on", count: 10, capped: true });
    expect(a.reason).toMatch(/at least/);
  });

  it("falls back to the workflow id when the workflows list cannot be read", async () => {
    workflows = { status: 500, body: {} };
    const a = (await get(on, owner)).json<Answer>();
    expect(a.state).toBe("on");
    expect(a.failed[0].workflowName).toBe("wf1");
  });

  it("not_configured when the automation service has no key or no url (never 0 failures)", async () => {
    config.services.automation = { url: stubUrl, token: "" };
    const a = (await get(on, owner)).json<Answer>();
    expect(a).toMatchObject({ state: "not_configured", failed: [], count: 0 });
    expect(a.reason).toBeTruthy();
    config.services.automation = { url: "", token: "n8n-key" };
    expect((await get(on, owner)).json<Answer>().state).toBe("not_configured");
  });

  it("unavailable, with a reason, when n8n errors, refuses the key or answers a wrong shape", async () => {
    executions = () => ({ status: 500, body: {} });
    const down = (await get(on, owner)).json<Answer>();
    expect(down).toMatchObject({ state: "unavailable", failed: [], count: 0 });
    expect(down.reason).toBeTruthy();

    config.services.automation = { url: stubUrl, token: "wrong-key" };
    expect((await get(on, owner)).json<Answer>().state).toBe("unavailable");

    config.services.automation = { url: stubUrl, token: "n8n-key" };
    executions = () => ({ status: 200, body: { oops: true } });
    expect((await get(on, owner)).json<Answer>().state).toBe("unavailable");
  });

  it("unavailable when n8n is unreachable", async () => {
    config.services.automation = { url: "http://127.0.0.1:9", token: "n8n-key" };
    expect((await get(on, owner)).json<Answer>().state).toBe("unavailable");
  });
});
