import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { config } from "./config";
import { buildHttpApp } from "./server";
import { resetRegistry } from "./registry";

let server: Server;
let base: string;

describe("mcp-hub HTTP entrypoint", () => {
  beforeAll(async () => {
    resetRegistry();
    config.serviceToken = "svc-token";
    const app = buildHttpApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("GET /health is open and lists tools", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { tools: string[] };
    expect(body.tools).toContain("whoami");
  });

  it("POST /mcp without the service token is rejected (fail-closed)", async () => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });

  it("a real MCP client over HTTP: lists filtered tools and calls whoami with the OBO principal", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: {
          Authorization: "Bearer svc-token",
          "x-obo-provider": "telegram",
          "x-obo-external-id": "tg:555",
        },
      },
    });
    const client = new Client({ name: "http-test", version: "0.0.0" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("whoami");
    expect(tools).not.toContain("rollup.metrics");
    const res = await client.callTool({ name: "whoami", arguments: {} });
    const principal = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(principal).toEqual({ provider: "telegram", externalId: "tg:555", assurance: "low" });
    await client.close();
  });

  it("GET /audit is bearer-gated and returns decisions newest-first", async () => {
    expect((await fetch(`${base}/audit`)).status).toBe(401);

    const { auditToolCall } = await import("./audit");
    const principal = { provider: "telegram", externalId: "tg:555", assurance: "low" as const };
    auditToolCall({ ts: 1, tool: "older", principal, decision: "allow", ok: true });
    auditToolCall({ ts: 2, tool: "newer", principal, decision: "deny", reason: "insufficient assurance" });

    const r = await fetch(`${base}/audit?limit=10`, { headers: { Authorization: "Bearer svc-token" } });
    expect(r.status).toBe(200);
    const rows = (await r.json()) as Array<{ tool: string; decision: string; reason?: string }>;
    expect(rows[0].tool).toBe("newer");
    expect(rows[0].decision).toBe("deny");
    expect(rows[0].reason).toBe("insufficient assurance");
    expect(rows.some((x) => x.tool === "older")).toBe(true);
  });

  it("GET /admin/info is bearer-gated and reports posture, primitives and workflow scopes", async () => {
    expect((await fetch(`${base}/admin/info`)).status).toBe(401);

    const r = await fetch(`${base}/admin/info`, { headers: { Authorization: "Bearer svc-token" } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      policy: { engine: string; denyByDefault: boolean };
      rateLimit: { perPrincipalPerMin: number; perServiceTokenPerMin: number };
      transport: { tlsMode: string; topology: string };
      tools: { total: number; bySource: Record<string, number> };
      resources: unknown[];
      prompts: Array<{ name: string }>;
      workflowScopes: Array<{ workflow: string; tools: string[] }>;
    };
    // In-code engine in tests (no CERBOS_URL) — the console must be able to say which one decided.
    expect(body.policy.engine).toBe("in-code");
    expect(body.policy.denyByDefault).toBe(true);
    // The per-service-token ceiling is 10x the per-principal one; the console shows both.
    expect(body.rateLimit.perServiceTokenPerMin).toBe(body.rateLimit.perPrincipalPerMin * 10);
    expect(body.transport.tlsMode).toBeTruthy();
    expect(body.tools.total).toBeGreaterThan(0);
    expect(body.tools.bySource.core).toBeGreaterThan(0);
    expect(body.resources.length).toBeGreaterThan(0);
    expect(body.prompts.some((p) => p.name === "summarize-project-status")).toBe(true);
    const summarize = body.workflowScopes.find((w) => w.workflow === "wf:summarize-via-mcp");
    expect(summarize?.tools).toEqual(["llm.summarize"]);
    // No secret may appear anywhere in the posture block.
    expect(JSON.stringify(body)).not.toContain("svc-token");
  });

  it("GET /tools attributes each tool to its registration group", async () => {
    const r = await fetch(`${base}/tools`);
    const rows = (await r.json()) as Array<{ name: string; source: string }>;
    expect(rows.find((t) => t.name === "whoami")?.source).toBe("core");
  });

  it("rejects everything when no service token is configured", async () => {
    const original = config.serviceToken;
    config.serviceToken = "";
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer svc-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    config.serviceToken = original;
    expect(r.status).toBe(401);
  });
});
