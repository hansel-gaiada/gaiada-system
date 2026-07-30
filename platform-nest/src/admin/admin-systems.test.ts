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
    if (url.startsWith("/gw/egress-audit")) return send(200, [{ ts: 1_752_000_000_000, capability: "llm", provider: "gemini", ok: true, latencyMs: 42, redactions: 0 }]);
    if (url.startsWith("/gw/admin/config") && req.method === "GET")
      return send(200, {
        chains: {
          llm: { order: ["ollama", "gemini"], providers: [{ name: "ollama", position: 1, state: "ok", available: true }, { name: "gemini", position: 2, state: "open", available: true, consecutiveFails: 0, rateLimited: true, openUntil: "2026-07-27T00:00:00Z" }] },
          media: { order: ["whisper"], providers: [] },
          embed: { order: ["ollama"], providers: [] },
        },
        providers: [{ name: "gemini", model: "gemini-1.5-flash", keyRequired: true, keyConfigured: true }],
        budget: { day: "2026-07-27", used: 12, cap: 2000, effectiveCap: 2000, perTenantCap: 1000, tenants: { acme: 12 }, drActive: false },
        reliability: { breakerThreshold: 3, breakerCooldownMs: 60000, providerTimeoutMs: 60000 },
        security: { tlsMode: "off", egressAllowlist: [], dlpClassifierEnabled: false, dlpClassifierModel: "llama3.2", classifierReachable: false },
        topology: { mode: "central", centralConfigured: false, drBurstCap: 2000, drDurationMinutes: 1440 },
        // Deliberately omits tlsMode/egressAllowlist/topologyMode: the console must render those
        // read-only because the GATEWAY says they are not runtime-writable.
        writableKeys: ["dailyCallCap", "perTenantDailyCallCap", "breakerThreshold", "llmChain"],
        overriddenKeys: { dailyCallCap: true },
      });
    if (url === "/gw/admin/dr-mode") return send(200, { drMode: true, budget: { cap: 2000 } });
    if (url.startsWith("/gw/admin/config") && (req.method === "PUT" || req.method === "DELETE")) {
      // The gateway is the validator; this stub reproduces both of its answer shapes so the proxy's
      // status/message mapping is exercised rather than assumed.
      if (req.method === "DELETE") {
        if (url.includes("key=tlsMode")) return send(400, { error: "tlsMode is not runtime-writable" });
        return send(200, { ok: true, key: "dailyCallCap", revertedToEnv: true });
      }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { key?: string; value?: unknown };
        if (body.key === "tlsMode") return send(400, { error: "tlsMode is not runtime-writable (env + restart only)" });
        if (body.key === "dailyCallCap" && body.value === 0) return send(400, { error: "dailyCallCap must be between 1 and 10000000" });
        if (body.key === "dlpClassifierEnabled") return send(409, { error: "no DLP classifier is loaded in this process" });
        return send(200, { ok: true, key: body.key, applied: body.value });
      });
      return;
    }
    if (url === "/bot/health") return send(200, { ok: true, ai: "on" });
    if (url === "/hub/admin/info")
      return send(200, {
        policy: { engine: "in-code", cerbosConfigured: false, denyByDefault: true, automationWriteGate: "low only", revocationCheck: true },
        rateLimit: { perPrincipalPerMin: 120, perPrincipalBurst: 40, perServiceTokenPerMin: 1200, perServiceTokenBurst: 400 },
        transport: { tlsMode: "off", peerAllowlist: ["bot"], topology: "site", serviceAuthConfigured: true },
        tools: { total: 2, bySource: { core: 2 } },
        resources: [{ uriTemplate: "gaiada://{tenantId}/projects", name: "Projects", description: "", mimeType: "application/json" }],
        prompts: [{ name: "draft-client-update", description: "", arguments: [] }],
        workflowScopes: [{ workflow: "wf:task-sla", tools: ["tasks.list", "tasks.update"] }],
      });
    if (url.startsWith("/hub/audit"))
      return send(200, [{ ts: 1_752_000_000_000, tool: "tasks.update", principal: { provider: "n8n", externalId: "wf:task-sla", assurance: "verified" }, decision: "deny", reason: "suspend: medium-impact write" }]);
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
    const toggle = url.match(/^\/n8n\/api\/v1\/workflows\/([^/]+)\/(activate|deactivate)$/);
    if (toggle && req.method === "POST") {
      if (req.headers["x-n8n-api-key"] !== "n8n-key") return send(401, { message: "unauthorized" });
      if (toggle[1] === "missing") return send(404, { message: "workflow not found" });
      return send(200, { id: toggle[1], active: toggle[2] === "activate" });
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

    tenantA = await createCompany("Agency A", ["agency", "knowledge"]);
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

  it("bot/hub/knowledge status shapes; agents reports not-configured (no AGENTS_URL in this suite); automation healthz ok", async () => {
    const bot = (await app.inject({ method: "GET", url: `/api/admin/bot/status`, headers: asUser(admin) })).json() as { ok: boolean; detail?: { ai?: string } };
    expect(bot).toMatchObject({ ok: true, detail: { ai: "on" } });
    const hub = (await app.inject({ method: "GET", url: `/api/admin/hub/status`, headers: asUser(admin) })).json() as { ok: boolean; counters?: { tools?: number } };
    expect(hub.ok).toBe(true);
    expect(hub.counters?.tools).toBe(2);
    const kn = (await app.inject({ method: "GET", url: `/api/admin/knowledge/status`, headers: asUser(admin) })).json() as { ok: boolean };
    expect(kn.ok).toBe(true);
    const agents = (await app.inject({ method: "GET", url: `/api/admin/agents/status`, headers: asUser(admin) })).json() as { ok: boolean; detail?: { note?: string } };
    expect(agents.ok).toBe(false);
    expect(agents.detail?.note).toContain("not configured");
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

  it("gateway config projects the service's real admin surface (chain order, caps, posture)", async () => {
    const cfg = (await app.inject({ method: "GET", url: `/api/admin/gateway/config`, headers: asUser(admin) })).json() as {
      fields: Array<{ key: string; value: unknown; kind: string }>;
    };
    const byKey = new Map(cfg.fields.map((f) => [f.key, f]));
    // `providers` is the key the gateway page's ordered chain list reads — previously never emitted.
    expect(byKey.get("providers")?.value).toEqual(["ollama", "gemini"]);
    expect(byKey.get("dailyCallCap")?.value).toBe(2000);
    expect(byKey.get("breakerThreshold")?.value).toBe(3);
    expect(byKey.get("tlsMode")?.value).toBe("off");
    // The honest connection descriptor is still appended, never replaced.
    expect(byKey.get("url")).toBeTruthy();
    // No credential value may appear anywhere in a config projection.
    expect(JSON.stringify(cfg)).not.toContain("gw-token");
  });

  it("gateway detail exposes chain order with breaker state and per-tenant budget spend", async () => {
    const d = (await app.inject({ method: "GET", url: `/api/admin/gateway/detail`, headers: asUser(admin) })).json() as {
      chains: { llm: { providers: Array<{ name: string; state: string; rateLimited?: boolean }> } };
      budget: { tenants: Record<string, number> };
    };
    expect(d.chains.llm.providers[1]).toMatchObject({ name: "gemini", state: "open", rateLimited: true });
    expect(d.budget.tenants.acme).toBe(12);
  });

  it("egress audit filters by decision and carries the structured block reason", async () => {
    const all = (await app.inject({ method: "GET", url: `/api/admin/gateway/egress-audit`, headers: asUser(admin) })).json() as Array<{ ok: boolean; capability: string | null }>;
    expect(all[0]).toMatchObject({ ok: true, capability: "llm" });
    const blocked = (await app.inject({ method: "GET", url: `/api/admin/gateway/egress-audit?decision=blocked`, headers: asUser(admin) })).json() as unknown[];
    expect(blocked).toEqual([]);
  });

  it("DR mode is proxied (the gateway token never leaves the platform)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/admin/gateway/dr-mode`,
      headers: asUser(admin),
      payload: { enable: true, durationMinutes: 60 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ drMode: true });
    // Non-elevated callers cannot touch a budget lever.
    expect((await app.inject({ method: "POST", url: `/api/admin/gateway/dr-mode`, headers: asUser(member), payload: { enable: true } })).statusCode).toBe(403);
  });

  it("hub detail + config expose the policy engine, limits and primitives", async () => {
    const d = (await app.inject({ method: "GET", url: `/api/admin/hub/detail`, headers: asUser(admin) })).json() as {
      policy: { engine: string };
      prompts: unknown[];
      workflowScopes: Array<{ workflow: string; tools: string[] }>;
    };
    expect(d.policy.engine).toBe("in-code");
    expect(d.prompts.length).toBe(1);
    expect(d.workflowScopes[0].tools).toContain("tasks.update");

    const cfg = (await app.inject({ method: "GET", url: `/api/admin/hub/config`, headers: asUser(admin) })).json() as {
      fields: Array<{ key: string; value: unknown }>;
    };
    expect(cfg.fields.find((f) => f.key === "policyEngine")?.value).toBe("in-code");
    expect(cfg.fields.find((f) => f.key === "rateLimitPerMin")?.value).toBe(120);
  });

  it("hub audit proxies the decision trail with its deny reason", async () => {
    const rows = (await app.inject({ method: "GET", url: `/api/admin/hub/audit`, headers: asUser(admin) })).json() as Array<{ tool: string; decision: string; reason?: string }>;
    expect(rows[0]).toMatchObject({ tool: "tasks.update", decision: "deny" });
    expect(rows[0].reason).toContain("suspend");
  });

  it("automation exposes execution history and bridge health", async () => {
    config.services.automation = { url: config.services.automation.url, token: "n8n-key" };
    const runs = (await app.inject({ method: "GET", url: `/api/admin/automation/executions`, headers: asUser(admin) })).json() as Array<{ workflowName: string; status: string }>;
    // workflowId is resolved to a human name via the workflows list.
    expect(runs[0]).toMatchObject({ workflowName: "summarize-via-mcp", status: "success" });
    config.services.automation = { url: config.services.automation.url, token: "" };

    const bridge = (await app.inject({ method: "GET", url: `/api/admin/automation/bridge`, headers: asUser(admin) })).json() as { enabled: boolean; maxRetries: number; streams: unknown[] };
    // Unconfigured in this suite — the point is that it reports honestly instead of throwing.
    expect(bridge.enabled).toBe(false);
    expect(bridge.maxRetries).toBe(5);
    expect(bridge.streams).toEqual([]);
  });

  it("automation config reports the n8n + bridge posture", async () => {
    const cfg = (await app.inject({ method: "GET", url: `/api/admin/automation/config`, headers: asUser(admin) })).json() as {
      fields: Array<{ key: string; value: unknown }>;
    };
    expect(cfg.fields.find((f) => f.key === "bridgeEnabled")?.value).toBe(false);
    expect(cfg.fields.find((f) => f.key === "bridgeMaxRetries")?.value).toBe(5);
  });

  it("gateway config writes are proxied and the gateway's editable allowlist drives `editable`", async () => {
    const cfg = (await app.inject({ method: "GET", url: `/api/admin/gateway/config`, headers: asUser(admin) })).json() as {
      fields: Array<{ key: string; editable: boolean }>;
    };
    const byKey = new Map(cfg.fields.map((f) => [f.key, f]));
    // The stub's writableKeys omits tlsMode, so it must stay read-only even though it is rendered.
    expect(byKey.get("dailyCallCap")?.editable).toBe(true);
    expect(byKey.get("llmChain")?.editable).toBe(true);
    expect(byKey.get("tlsMode")?.editable).toBe(false);
    expect(byKey.get("egressAllowlist")?.editable).toBe(false);

    const ok = await app.inject({
      method: "PUT",
      url: `/api/admin/gateway/config`,
      headers: asUser(admin),
      payload: { key: "dailyCallCap", value: 500 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, key: "dailyCallCap", applied: 500 });
  });

  it("a gateway validation failure surfaces its own message, not a generic 502", async () => {
    const bounds = await app.inject({
      method: "PUT",
      url: `/api/admin/gateway/config`,
      headers: asUser(admin),
      payload: { key: "dailyCallCap", value: 0 },
    });
    expect(bounds.statusCode).toBe(400);
    expect((bounds.json() as { error: string }).error).toContain("between 1 and 10000000");

    // A non-writable key is refused by the gateway; the proxy must not swallow that into a 5xx.
    const readOnly = await app.inject({
      method: "PUT",
      url: `/api/admin/gateway/config`,
      headers: asUser(admin),
      payload: { key: "tlsMode", value: "off" },
    });
    expect(readOnly.statusCode).toBe(400);
    expect((readOnly.json() as { error: string }).error).toContain("not runtime-writable");

    // "Can't take effect" is a 409, distinct from "your value is wrong".
    const conflict = await app.inject({
      method: "PUT",
      url: `/api/admin/gateway/config`,
      headers: asUser(admin),
      payload: { key: "dlpClassifierEnabled", value: true },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("config writes require a key and are elevated-only", async () => {
    expect(
      (await app.inject({ method: "PUT", url: `/api/admin/gateway/config`, headers: asUser(admin), payload: {} })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "PUT", url: `/api/admin/gateway/config`, headers: asUser(member), payload: { key: "dailyCallCap", value: 5 } })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/admin/gateway/config?key=dailyCallCap`, headers: asUser(member) })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/admin/gateway/config`, headers: asUser(admin) })).statusCode,
    ).toBe(400);
  });

  it("reverting an override is proxied", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/admin/gateway/config?key=dailyCallCap`,
      headers: asUser(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, revertedToEnv: true });
  });

  it("workflow activate/deactivate reports n8n's resulting state and is platform-admin only", async () => {
    config.services.automation = { url: config.services.automation.url, token: "n8n-key" };

    const off = await app.inject({ method: "POST", url: `/api/admin/automation/workflows/wf1/deactivate`, headers: asUser(admin) });
    expect(off.statusCode).toBe(201);
    expect(off.json()).toMatchObject({ id: "wf1", active: false });

    const on = await app.inject({ method: "POST", url: `/api/admin/automation/workflows/wf1/activate`, headers: asUser(admin) });
    expect(on.json()).toMatchObject({ id: "wf1", active: true });

    // An unknown action must not reach n8n at all.
    expect(
      (await app.inject({ method: "POST", url: `/api/admin/automation/workflows/wf1/delete`, headers: asUser(admin) })).statusCode,
    ).toBe(400);

    // Deactivating stops business automation, so this is elevated-only — NOT the IT gate the
    // read-only canvas uses.
    expect(
      (await app.inject({ method: "POST", url: `/api/admin/automation/workflows/wf1/deactivate`, headers: asUser(member) })).statusCode,
    ).toBe(403);

    // n8n's own failure is surfaced, not silently swallowed into a success.
    expect(
      (await app.inject({ method: "POST", url: `/api/admin/automation/workflows/missing/activate`, headers: asUser(admin) })).statusCode,
    ).toBe(503);

    config.services.automation = { url: config.services.automation.url, token: "" };
    // With no API key there is nothing to talk to — 404, which the UI degrades to "not available".
    expect(
      (await app.inject({ method: "POST", url: `/api/admin/automation/workflows/wf1/activate`, headers: asUser(admin) })).statusCode,
    ).toBe(404);
  });

  it("dead-letter replay refuses unwatched streams and is platform-admin only", async () => {
    // Nothing is configured as a watched stream in this suite, so every name is unwatched — the
    // point being that an arbitrary Redis key can't be targeted through this route.
    const res = await app.inject({ method: "POST", url: `/api/admin/automation/bridge/anything/replay`, headers: asUser(admin) });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("not a watched bridge stream");

    expect(
      (await app.inject({ method: "POST", url: `/api/admin/automation/bridge/client/replay`, headers: asUser(member) })).statusCode,
    ).toBe(403);
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
