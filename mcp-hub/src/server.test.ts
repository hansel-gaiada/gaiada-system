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
