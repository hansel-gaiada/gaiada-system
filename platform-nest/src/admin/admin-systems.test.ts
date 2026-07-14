// Phase C: Systems/Intelligence admin aggregator. Stubs each downstream service with a tiny
// HTTP server, points config.services at it, and asserts the reshape + auth + graceful
// fallbacks. Needs live PG + Cerbos (buildApp + authorize) like the other suites.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// One stub server that answers for every downstream system, routed by path prefix.
function startStub(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const send = (code: number, body: unknown, json = true) => {
      res.writeHead(code, { "content-type": json ? "application/json" : "text/plain" });
      res.end(json ? JSON.stringify(body) : String(body));
    };
    if (url === "/gw/health") return send(200, { ok: true, providers: { llm: "closed", media: "closed" }, budget: { callsToday: 5, cap: 2000 }, classifierReachable: true });
    if (url === "/gw/egress-audit") return send(200, [{ ts: 1_752_000_000_000, capability: "llm", provider: "gemini", ok: true, latencyMs: 42, redactions: 0 }]);
    if (url === "/bot/health") return send(200, { ok: true, ai: "on" });
    if (url === "/hub/health") return send(200, { ok: true, tools: ["capture", "actions"] });
    if (url === "/hub/tools") return send(200, [{ name: "capture", description: "Capture a note", minAssurance: "linked" }]);
    if (url === "/hubnotools/health") return send(200, { ok: true, tools: ["onlyname"] });
    if (url === "/hubnotools/tools") return send(404, { error: "nope" });
    if (url === "/kn/health") return send(200, { ok: true });
    if (url.startsWith("/kn/sources")) return send(200, [{ sourceRef: "handbook.pdf", kind: "doc", chunks: 3, provenance: "human", status: "indexed", updatedAt: "2026-07-14T00:00:00Z" }]);
    if (url === "/n8n/healthz") return send(200, "OK", false);
    if (url === "/n8n/api/v1/workflows") {
      // Requires the API key header; without it n8n 401s (we assert the fail-soft path separately).
      if (req.headers["x-n8n-api-key"] !== "n8n-key") return send(401, { message: "unauthorized" });
      return send(200, { data: [{ id: "wf1", name: "summarize-via-mcp", active: true }, { id: "wf2", name: "draft-flow", active: false }] });
    }
    if (url.startsWith("/n8n/api/v1/executions")) {
      if (req.headers["x-n8n-api-key"] !== "n8n-key") return send(401, { message: "unauthorized" });
      return send(200, { data: [{ workflowId: "wf1", status: "success", finished: true, stoppedAt: "2026-07-15T00:00:00Z" }] });
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

describe.skipIf(!TEST_URL)("admin systems aggregator (Phase C)", () => {
  let app: NestFastifyApplication;
  let stub: Server;
  let tenantA: string;
  let admin: string;
  let member: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    const { server, base } = await startStub();
    stub = server;
    config.services.gateway = { url: `${base}/gw`, token: "gw-token" };
    config.services.bot = { url: `${base}/bot`, token: "bot-token" };
    config.services.hub = { url: `${base}/hub`, token: "hub-token" };
    config.services.knowledge = { url: `${base}/kn`, token: "kn-token" };
    config.services.automation = { url: `${base}/n8n`, token: "" };

    tenantA = await createCompany("Agency A", ["agency"]);
    admin = await createUser("admin@a.test");
    member = await createUser("member@a.test");
    await addMembership(tenantA, admin);
    await addMembership(tenantA, member);
    const adminRole = await createRole("platform_admin");
    const memberRole = await createRole("member");
    await grantRole(admin, adminRole, "global", null);
    await grantRole(member, memberRole, "company", tenantA);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await new Promise<void>((r) => stub.close(() => r()));
    await teardownTestDb();
  });

  it("gateway status reshapes health (budget -> counters, providers -> detail)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/admin/gateway/status`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    const s = r.json() as { ok: boolean; counters?: Record<string, number>; detail?: Record<string, unknown> };
    expect(s.ok).toBe(true);
    expect(s.counters).toMatchObject({ callsToday: 5, cap: 2000 });
    expect(s.detail).toMatchObject({ classifierReachable: true });
  });

  it("bot/hub/knowledge status shapes; agents reports not-an-HTTP-service; automation healthz ok", async () => {
    const bot = (await app.inject({ method: "GET", url: `/api/admin/bot/status`, headers: asUser(admin) })).json() as { ok: boolean; detail?: { ai?: string } };
    expect(bot).toMatchObject({ ok: true, detail: { ai: "on" } });
    const hub = (await app.inject({ method: "GET", url: `/api/admin/hub/status`, headers: asUser(admin) })).json() as { ok: boolean; counters?: { tools?: number } };
    expect(hub.ok).toBe(true);
    expect(hub.counters?.tools).toBe(2);
    const kn = (await app.inject({ method: "GET", url: `/api/admin/knowledge/status`, headers: asUser(admin) })).json() as { ok: boolean };
    expect(kn.ok).toBe(true);
    const agents = (await app.inject({ method: "GET", url: `/api/admin/agents/status`, headers: asUser(admin) })).json() as { ok: boolean; detail?: { note?: string } };
    expect(agents.ok).toBe(false);
    expect(agents.detail?.note).toContain("CLI/library");
    const auto = (await app.inject({ method: "GET", url: `/api/admin/automation/status`, headers: asUser(admin) })).json() as { ok: boolean; detail?: { workflows?: unknown[] } };
    expect(auto.ok).toBe(true);
    // No API key configured -> alive but no workflow list (UI degrades gracefully).
    expect(auto.detail?.workflows).toEqual([]);
  });

  it("automation lists n8n workflows + last-run when a Public-API key is configured", async () => {
    config.services.automation = { url: config.services.automation.url, token: "n8n-key" };
    const r = (await app.inject({ method: "GET", url: `/api/admin/automation/status`, headers: asUser(admin) })).json() as {
      ok: boolean;
      counters?: { workflows?: number };
      detail?: { n8nUrl?: string; workflows?: Array<{ name: string; status: string; lastRun: string | null }> };
    };
    expect(r.ok).toBe(true);
    expect(r.detail?.n8nUrl).toContain("/n8n");
    expect(r.counters?.workflows).toBe(2);
    const byName = Object.fromEntries((r.detail?.workflows ?? []).map((w) => [w.name, w]));
    expect(byName["summarize-via-mcp"]).toMatchObject({ status: "success", lastRun: "2026-07-15T00:00:00Z" });
    expect(byName["draft-flow"]).toMatchObject({ status: "inactive" }); // inactive workflow, no run
    config.services.automation = { url: config.services.automation.url, token: "" };
  });

  it("status of an unreachable service is ok:false with an error, not a throw", async () => {
    config.services.bot = { url: "http://127.0.0.1:9/bad", token: "" };
    const s = (await app.inject({ method: "GET", url: `/api/admin/bot/status`, headers: asUser(admin) })).json() as { ok: boolean; detail?: { error?: string } };
    expect(s.ok).toBe(false);
    expect(s.detail?.error).toBeTruthy();
    config.services.bot = { url: "", token: "" };
    const s2 = (await app.inject({ method: "GET", url: `/api/admin/bot/status`, headers: asUser(admin) })).json() as { ok: boolean; detail?: { note?: string } };
    expect(s2.ok).toBe(false);
    expect(s2.detail?.note).toContain("not configured");
  });

  it("config returns a read-only connection descriptor", async () => {
    const cfg = (await app.inject({ method: "GET", url: `/api/admin/gateway/config`, headers: asUser(admin) })).json() as { fields: Array<{ key: string; value: unknown; editable: boolean }> };
    const url = cfg.fields.find((f) => f.key === "url")!;
    expect(url.editable).toBe(false);
    const tok = cfg.fields.find((f) => f.key === "tokenConfigured")!;
    expect(tok.value).toBe(true);
  });

  it("non-elevated user is 403 on systems endpoints", async () => {
    expect((await app.inject({ method: "GET", url: `/api/admin/gateway/status`, headers: asUser(member) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/admin/hub/tools`, headers: asUser(member) })).statusCode).toBe(403);
  });

  it("egress-audit proxies gateway rows; hub tools proxies full catalog", async () => {
    const audit = (await app.inject({ method: "GET", url: `/api/admin/gateway/egress-audit`, headers: asUser(admin) })).json() as Array<{ provider?: string; decision?: string; detail?: string; time?: string }>;
    expect(audit[0].provider).toBe("gemini");
    expect(audit[0].decision).toBe("allow");
    expect(audit[0].detail).toContain("llm");
    expect(audit[0].time).toBeTruthy();
    const tools = (await app.inject({ method: "GET", url: `/api/admin/hub/tools`, headers: asUser(admin) })).json() as Array<{ name: string; description: string }>;
    expect(tools[0]).toMatchObject({ name: "capture", description: "Capture a note" });
  });

  it("hub tools falls back to names-only when /tools is absent", async () => {
    const base = config.services.hub.url.replace(/\/hub$/, "");
    config.services.hub = { url: `${base}/hubnotools`, token: "" };
    const tools = (await app.inject({ method: "GET", url: `/api/admin/hub/tools`, headers: asUser(admin) })).json() as Array<{ name: string; description: string }>;
    expect(tools).toEqual([{ name: "onlyname", description: "", minAssurance: "" }]);
  });

  it("knowledge sources proxied; agent goals honest-empty", async () => {
    const sources = (await app.inject({ method: "GET", url: `/api/${tenantA}/knowledge/sources`, headers: asUser(member) })).json() as Array<{ source: string }>;
    expect(sources[0].source).toBe("handbook.pdf");
    const goals = (await app.inject({ method: "GET", url: `/api/${tenantA}/agents/goals`, headers: asUser(member) })).json();
    expect(goals).toEqual([]);
  });
});
