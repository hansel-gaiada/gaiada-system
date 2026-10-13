// PV1-05 — the Platform server gate (PV-D18 + PV-D20), narrowed by PV-D31 (D21, 2026-10-13).
// `isPlatformOperator` (./elevated.ts) admits `platform_admin` at global scope OR the owner of the
// OPERATOR ROOT (the root company with `companies.is_operator_root`, migration 202610132137), and it
// guards the SYSTEM surfaces only: admin-systems.controller.ts, bot-admin.controller.ts,
// observability.controller.ts.
//
// HOW THIS FILE BITES:
//   * drop the owner arm (back to isElevated)      -> every "operator root owner gets 2xx" case fails;
//   * widen it to any owner, or to "owner grant whose scopeId is in rootCompanies"
//                                                   -> every "child-company owner is 403" case fails.
//     The second widening is the tempting one, and the first `it` below pins WHY it is wrong:
//     `rootCompanies` holds the whole root TREE, so the child owner's own company is in it.
//   * drop the PV-D31 marker condition (`AND is_operator_root`, i.e. back to "owner of ANY root")
//                                                   -> every "CUSTOMER root owner is 403" case fails.
//     The customer root is a real root with a real, anchored owner; only the marker tells them apart,
//     which the second `it` pins.
//
// One read and one write route per surface family where a write exists (observability has only
// its one GET). Downstream services are a local stub, as in admin-systems.test.ts / bot-admin.test.ts;
// observability runs with PROMETHEUS_URL/ALERTMANAGER_URL unset, which answers 200 available:false
// without any network call.
//
// Needs DATABASE_URL_TEST + CERBOS_URL — skips silently otherwise (see platform-nest/CLAUDE.md).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withGlobal } from "../db";
import { assemblePrincipal } from "../rbac/principal";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const asUser = (id: string) => ({ authorization: "Bearer svc-token", "x-user-id": id });

function startStub(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // AI gateway (systems console).
    if (url === "/gw/health") return send(200, { ok: true, budget: { callsToday: 1, cap: 10 } });
    if (url.startsWith("/gw/admin/config") && req.method === "PUT") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { key?: string; value?: unknown };
        send(200, { ok: true, key: body.key, applied: body.value });
      });
      return;
    }
    // WhatsApp bot's own /admin surface (bot console).
    if (url === "/bot/admin/session/status" && req.method === "GET") return send(200, { status: "WORKING" });
    if (url === "/bot/admin/actions/off" && req.method === "POST") return send(200, { actions: "off" });
    // n8n Public API (automation reads, IT-or-operator).
    if (url === "/n8n/api/v1/workflows") {
      if (req.headers["x-n8n-api-key"] !== "n8n-key") return send(401, { message: "unauthorized" });
      return send(200, { data: [{ id: "wf1", name: "flow", active: true }] });
    }
    return send(404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

type Req = { method: "GET" | "POST" | "PUT"; url: string; payload?: Record<string, unknown> };

// Each route with the status a permitted caller gets. Bodies are VALID on purpose: a validation 400
// that fired before the gate would make a 403 assertion stop testing authz (validation-preempts-authz).
const ROUTES: Array<{ family: string; kind: "read" | "write"; req: Req; ok: number }> = [
  { family: "systems", kind: "read", req: { method: "GET", url: "/api/admin/gateway/status" }, ok: 200 },
  {
    family: "systems",
    kind: "write",
    req: { method: "PUT", url: "/api/admin/gateway/config", payload: { key: "dailyCallCap", value: 500 } },
    ok: 200,
  },
  { family: "bot", kind: "read", req: { method: "GET", url: "/api/admin/bot/session/status" }, ok: 200 },
  { family: "bot", kind: "write", req: { method: "POST", url: "/api/admin/bot/actions/off" }, ok: 200 },
  { family: "observability", kind: "read", req: { method: "GET", url: "/api/admin/observability" }, ok: 200 },
  // isItOrPlatformOperator: the operator arm of the automation reads.
  { family: "automation", kind: "read", req: { method: "GET", url: "/api/admin/automation/workflows" }, ok: 200 },
];

describe.skipIf(!TEST_URL)("PV1-05 · platform-operator gate on the system surfaces (PV-D18/PV-D20/PV-D31)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let root: string;
  let child: string;
  let customerRoot: string;
  let rootOwner: string;
  let customerOwner: string;
  let childOwner: string;
  let member: string;
  let admin: string;
  let itUser: string;

  const prior = {
    gateway: config.services.gateway,
    bot: config.services.bot,
    automation: config.services.automation,
    prometheusUrl: config.observability.prometheusUrl,
    alertmanagerUrl: config.observability.alertmanagerUrl,
  };

  const call = (user: string, r: Req) =>
    app.inject({ method: r.method, url: r.url, headers: asUser(user), ...(r.payload ? { payload: r.payload } : {}) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    const { server, base } = await startStub();
    stub = server;
    config.services.gateway = { url: `${base}/gw`, token: "gw-token" };
    config.services.bot = { url: `${base}/bot`, token: "bot-token" };
    config.services.automation = { url: `${base}/n8n`, token: "n8n-key" };
    config.observability.prometheusUrl = "";
    config.observability.alertmanagerUrl = "";

    // A root and a child under it. The MON-00a trigger sets root.root_company_id = root.id and
    // child.root_company_id = root.id.
    root = await createCompany("PV105 Root Holding");
    child = await createCompany("PV105 Child Co", [], root);
    // PV-D31: the test database migrated an EMPTY schema, so the migration marked nothing. Mark the
    // operator root exactly as an operator would on an estate (data, never an id in code).
    await withGlobal((c) => c.query(`UPDATE companies SET is_operator_root = true WHERE id = $1`, [root]));
    // A second, UNMARKED root: a future subscriber's organization (PV-D13). Its own root, its own owner.
    customerRoot = await createCompany("PV105 Customer Root");

    const ownerRole = await createRole("owner");
    const memberRole = await createRole("member");
    const adminRole = await createRole("platform_admin");
    const itRole = await createRole("it");

    rootOwner = await createUser("root-owner@pv105.test");
    customerOwner = await createUser("customer-owner@pv105.test");
    childOwner = await createUser("child-owner@pv105.test");
    member = await createUser("member@pv105.test");
    admin = await createUser("admin@pv105.test");
    itUser = await createUser("it@pv105.test");

    // Root owner: modelled on src/seed/owner-grant.ts — membership + company-scope owner grant +
    // home_company_id on the holding (the anchor rootCompanies is derived from).
    await addMembership(root, rootOwner);
    await grantRole(rootOwner, ownerRole, "company", root);

    // Child-only owner: the same shape, on the CHILD. Its anchor resolves to the same root, so its
    // rootCompanies contains both companies — see the first test.
    await addMembership(child, childOwner);
    await grantRole(childOwner, ownerRole, "company", child);

    // Customer-root owner: the same shape as the operator root's owner, on the OTHER root.
    await addMembership(customerRoot, customerOwner);
    await grantRole(customerOwner, ownerRole, "company", customerRoot);

    await addMembership(root, member);
    await grantRole(member, memberRole, "company", root);

    await addMembership(root, admin);
    await grantRole(admin, adminRole, "global", null);

    await addMembership(root, itUser);
    await grantRole(itUser, itRole, "company", root);

    await withGlobal(async (c) => {
      await c.query(`UPDATE users SET home_company_id = $1 WHERE id = ANY($2::uuid[])`, [
        root,
        [rootOwner, member, admin, itUser],
      ]);
      await c.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [child, childOwner]);
      await c.query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [customerRoot, customerOwner]);
    });

    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => stub.close(() => r()));
    config.services.gateway = prior.gateway;
    config.services.bot = prior.bot;
    config.services.automation = prior.automation;
    config.observability.prometheusUrl = prior.prometheusUrl;
    config.observability.alertmanagerUrl = prior.alertmanagerUrl;
    await teardownTestDb();
  });

  it("fixture premise: the child owner's rootCompanies includes the child, so rootCompanies alone cannot identify a root", async () => {
    const roots = await withGlobal((c) =>
      c.query<{ id: string; root_company_id: string }>(
        `SELECT id, root_company_id FROM companies WHERE id = ANY($1::uuid[])`,
        [[root, child]],
      ),
    );
    const rootOf = new Map(roots.rows.map((r) => [r.id, r.root_company_id]));
    expect(rootOf.get(root)).toBe(root);
    expect(rootOf.get(child)).toBe(root);

    const p = await assemblePrincipal(childOwner, "high");
    expect(p?.rootCompanies).toEqual(expect.arrayContaining([root, child]));
    expect(p?.roles).toContainEqual({ role: "owner", scopeType: "company", scopeId: child });
  });

  it("fixture premise (PV-D31): the customer root is a real root with an anchored owner; only the marker differs", async () => {
    const rows = await withGlobal((c) =>
      c.query<{ id: string; root_company_id: string; is_operator_root: boolean }>(
        `SELECT id, root_company_id, is_operator_root FROM companies WHERE id = ANY($1::uuid[])`,
        [[root, customerRoot]],
      ),
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(customerRoot)).toMatchObject({ root_company_id: customerRoot, is_operator_root: false });
    expect(byId.get(root)).toMatchObject({ root_company_id: root, is_operator_root: true });

    const p = await assemblePrincipal(customerOwner, "high");
    expect(p?.rootCompanies).toContain(customerRoot);
    expect(p?.roles).toContainEqual({ role: "owner", scopeType: "company", scopeId: customerRoot });
  });

  it("GET /api/me carries isOperatorRoot: true on the operator root only (PV-D31, additive)", async () => {
    const mine = (await app.inject({ method: "GET", url: "/api/me", headers: asUser(rootOwner) })).json() as {
      companies: { id: string; isOperatorRoot: boolean }[];
    };
    expect(mine.companies.find((c) => c.id === root)?.isOperatorRoot).toBe(true);
    const cust = (await app.inject({ method: "GET", url: "/api/me", headers: asUser(customerOwner) })).json() as {
      companies: { id: string; isOperatorRoot: boolean }[];
    };
    expect(cust.companies.find((c) => c.id === customerRoot)?.isOperatorRoot).toBe(false);
    const kid = (await app.inject({ method: "GET", url: "/api/me", headers: asUser(childOwner) })).json() as {
      companies: { id: string; isOperatorRoot: boolean }[];
    };
    expect(kid.companies.find((c) => c.id === child)?.isOperatorRoot).toBe(false);
  });

  for (const r of ROUTES) {
    const label = `${r.family} ${r.kind}: ${r.req.method} ${r.req.url}`;

    it(`${label} — the owner of the OPERATOR ROOT gets ${r.ok}`, async () => {
      const res = await call(rootOwner, r.req);
      expect(res.statusCode, res.body).toBe(r.ok);
    });

    it(`${label} — the owner of a CUSTOMER root (unmarked) gets 403 (PV-D31)`, async () => {
      const res = await call(customerOwner, r.req);
      expect(res.statusCode, res.body).toBe(403);
    });

    it(`${label} — an owner of only the CHILD company gets 403`, async () => {
      const res = await call(childOwner, r.req);
      expect(res.statusCode, res.body).toBe(403);
    });

    it(`${label} — a plain member gets 403`, async () => {
      const res = await call(member, r.req);
      expect(res.statusCode, res.body).toBe(403);
    });

    it(`${label} — platform_admin still gets ${r.ok}`, async () => {
      const res = await call(admin, r.req);
      expect(res.statusCode, res.body).toBe(r.ok);
    });
  }

  it("the root owner's success is real data, not an empty degrade (gateway status + bot session)", async () => {
    const gw = (await call(rootOwner, { method: "GET", url: "/api/admin/gateway/status" })).json() as { ok: boolean };
    expect(gw.ok).toBe(true);
    const bot = (await call(rootOwner, { method: "GET", url: "/api/admin/bot/session/status" })).json() as {
      status: string;
    };
    expect(bot.status).toBe("WORKING");
  });

  it("automation reads keep their IT arm; the automation WRITE does not (IT is not an operator)", async () => {
    const read = await call(itUser, { method: "GET", url: "/api/admin/automation/workflows" });
    expect(read.statusCode, read.body).toBe(200);
    // Not a stubbed route, so a 2xx here could only come from a broken gate; 403 is the gate.
    const write = await call(itUser, { method: "POST", url: "/api/admin/automation/workflows/wf1/deactivate" });
    expect(write.statusCode, write.body).toBe(403);
  });
});
