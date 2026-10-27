// AIP-03b — the hub's gateway call site (gateway-client.ts), driven through the REAL hub (buildHubServer + an in-memory MCP client) with a stubbed
// `fetch` for the gateway and a spy on the reporter. Proves what the hub knows at the call and what it sends:
//   * surface `agent` when the principal carries an agent (an agent-driven call), `other` otherwise (n8n, an MCP client, the bot);
//   * the tenant is the tool call's own `tenantId` argument; with none there is no company to bill (the reporter then writes nothing);
//   * the person is the envelope's user id for a `platform` envelope, never a chat identity;
//   * task is the tool's name; tokens and cost are the gateway's `usage`; 429 / 503 / other failures map to blocked_budget / blocked_dlp / error;
//   * two overlapping calls never swap attribution; a media call is capability `media`; the tool's own result and failures are unchanged.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config } from "./config";
import { buildHubServer } from "./hub";
import { resetRegistry } from "./registry";
import { registerCoreTools } from "./tools";
import { toolCallUsageFor } from "./gateway-client";
import { usageReporter, type UsageEvent } from "./usage-reporter";
import type { Principal } from "./principal";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "55555555-5555-4555-8555-555555555555";
const U = "22222222-2222-4222-8222-222222222222";
const AUDIT_DIR = "data/test-audit-aip03b";

const agentPrincipal: Principal = { provider: "platform", externalId: U, assurance: "low", agent: "statusReporter" };
const n8nPrincipal: Principal = { provider: "n8n", externalId: "wf:summarize-via-mcp", assurance: "low" };
const chatPrincipal: Principal = { provider: "whatsapp", externalId: "628110@c.us", assurance: "low" };

let reported: UsageEvent[];
const realAuditFile = config.auditFile;

beforeEach(() => {
  reported = [];
  resetRegistry();
  registerCoreTools();
  config.auditFile = `${AUDIT_DIR}/tools.jsonl`;
  vi.spyOn(usageReporter, "report").mockImplementation((e) => { reported.push(e); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); config.auditFile = realAuditFile; });
afterAll(() => rmSync(AUDIT_DIR, { recursive: true, force: true }));

async function connect(principal: Principal): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildHubServer(principal).connect(serverT);
  const client = new Client({ name: "t", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}
const gateway = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
const call = (c: Client, name: string, args: Record<string, unknown>) => c.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

describe("AIP-03b · the hub's /complete", () => {
  it("an agent-driven call: surface agent, the call's tenant, the platform person, the tool as task, the gateway's usage and cost", async () => {
    gateway(200, { text: "a summary", provider: "openai", usage: { promptTokens: 200, completionTokens: 40, costUsd: 0.003, source: "provider" } });
    const r = await call(await connect(agentPrincipal), "llm.summarize", { text: "long text", tenantId: T1 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toBe("a summary");
    expect(reported).toEqual([{
      tenantId: T1, userId: U, surface: "agent", capability: "llm", task: "llm.summarize", runId: null, provider: "openai",
      promptTokens: 200, completionTokens: 40, tokensSource: "provider", costUsd: 0.003, costSource: "provider", outcome: "ok",
    }]);
    expect(JSON.stringify(reported)).not.toContain("long text");
  });

  it("a call from n8n or a chat identity is surface other and has no person", async () => {
    gateway(200, { text: "summary", provider: "openai" });
    await call(await connect(n8nPrincipal), "llm.summarize", { text: "x", tenantId: T1 });
    await call(await connect(chatPrincipal), "llm.summarize", { text: "x", tenantId: T1 });
    expect(reported.map((e) => [e.surface, e.userId, e.tenantId, e.tokensSource])).toEqual([["other", null, T1, "none"], ["other", null, T1, "none"]]);
  });

  it("a call with no tenantId has no company to bill: the event carries none (the reporter then writes nothing)", async () => {
    gateway(200, { text: "summary" });
    const r = await call(await connect(n8nPrincipal), "llm.summarize", { text: "x" });
    expect(r.isError).toBeFalsy();
    expect(reported).toHaveLength(1);
    expect(reported[0].tenantId).toBeNull();
  });

  it("maps 429 to blocked_budget, 503 to blocked_dlp, other failures to error; the tool still fails as before", async () => {
    for (const [status, outcome] of [[429, "blocked_budget"], [503, "blocked_dlp"], [500, "error"]] as const) {
      reported.length = 0;
      gateway(status, {});
      const r = await call(await connect(agentPrincipal), "llm.summarize", { text: "x", tenantId: T1 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(`gateway /complete ${status}`);
      expect(reported[0], String(status)).toMatchObject({ outcome, tokensSource: "none", promptTokens: null, costUsd: null, tenantId: T1 });
    }
    reported.length = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const net = await call(await connect(agentPrincipal), "llm.summarize", { text: "x", tenantId: T1 });
    expect(net.isError).toBe(true);
    expect(reported[0].outcome).toBe("error");
  });

  it("overlapping calls from two tenants never swap attribution", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, status: 200, json: async () => ({ text: "s", provider: "openai" }) };
    }));
    const a = await connect(agentPrincipal);
    const b = await connect(n8nPrincipal);
    await Promise.all([call(a, "llm.summarize", { text: "x", tenantId: T1 }), call(b, "llm.summarize", { text: "y", tenantId: T2 })]);
    expect(reported.map((e) => [e.tenantId, e.surface]).sort()).toEqual([[T1, "agent"], [T2, "other"]].sort());
  });

  it("a media call is capability media, with the tool as its task", async () => {
    gateway(200, { text: "transcript", provider: "openai" });
    const r = await call(await connect(agentPrincipal), "media.extract", { base64: "AAAA", mime: "audio/ogg", tenantId: T1 });
    expect(r.isError).toBeFalsy();
    expect(reported[0]).toMatchObject({ capability: "media", task: "media.extract", surface: "agent", tenantId: T1, outcome: "ok" });
    expect(JSON.stringify(reported)).not.toContain("AAAA");
  });
});

describe("AIP-03b · toolCallUsageFor", () => {
  it("takes the tenant only from a string argument, the person only from a platform uuid, and agent from the principal", () => {
    expect(toolCallUsageFor("t", { tenantId: T1 }, agentPrincipal)).toEqual({ tool: "t", tenantId: T1, userId: U, agent: true });
    expect(toolCallUsageFor("t", { tenantId: 7 }, n8nPrincipal)).toEqual({ tool: "t", tenantId: null, userId: null, agent: false });
    expect(toolCallUsageFor("t", {}, { provider: "platform", externalId: "u1", agent: "" })).toEqual({ tool: "t", tenantId: null, userId: null, agent: false });
  });
});
