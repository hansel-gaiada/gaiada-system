import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config } from "./config";
import { buildHubServer } from "./hub";
import { mintPrincipal, type Principal } from "./principal";
import { registerCoreTools } from "./tools";
import { resetRegistry } from "./registry";
import { resolveResourcePath } from "./resources";
import { getPrompt } from "./prompts";

async function connect(principal: Principal): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildHubServer(principal).connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const lowUser = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });
const anon = mintPrincipal({});

describe("MCP Resources + Prompts primitives (WS2 §6)", () => {
  beforeEach(() => {
    resetRegistry();
    registerCoreTools();
    config.auditFile = "data/test-audit/primitives.jsonl";
  });

  it("resource templates are advertised to identified callers, hidden from anonymous", async () => {
    const low = await connect(lowUser);
    const tmpls = (await low.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(tmpls).toContain("gaiada://{tenantId}/project/{projectId}");
    await low.close();

    const a = await connect(anon);
    expect((await a.listResourceTemplates()).resourceTemplates).toHaveLength(0);
    await a.close();
  });

  it("resolveResourcePath maps gaiada:// URIs to platform paths; rejects unknown kinds", () => {
    expect(resolveResourcePath("gaiada://t1/projects")).toBe("/api/t1/projects");
    expect(resolveResourcePath("gaiada://t1/project/p9")).toBe("/api/t1/projects/p9");
    expect(resolveResourcePath("gaiada://t1/client/c2")).toBe("/api/t1/clients/c2");
    expect(resolveResourcePath("gaiada://t1/task/tk3")).toBe("/api/t1/tasks/tk3");
    expect(resolveResourcePath("gaiada://t1/activity")).toBe("/api/t1/activity");
    expect(() => resolveResourcePath("gaiada://t1/secrets")).toThrow();
    expect(() => resolveResourcePath("http://evil/x")).toThrow();
  });

  it("reading a resource fronts the platform with the OBO envelope; anonymous is denied", async () => {
    config.platformUrl = "http://platform.test";
    config.platformToken = "plat-token";
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe("http://platform.test/api/tenant-1/projects/p1");
      expect(init?.headers?.["x-obo-external-id"]).toBe("628110@c.us");
      return { ok: true, status: 200, json: async () => ({ id: "p1", name: "Rebrand" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const low = await connect(lowUser);
    const res = await low.readResource({ uri: "gaiada://tenant-1/project/p1" });
    vi.unstubAllGlobals();
    expect((res.contents[0] as { text: string }).text).toContain("Rebrand");
    await low.close();

    const a = await connect(anon);
    await expect(a.readResource({ uri: "gaiada://tenant-1/project/p1" })).rejects.toThrow();
    await a.close();
  });

  it("prompts are advertised to identified callers and render with arguments", async () => {
    const low = await connect(lowUser);
    const names = (await low.listPrompts()).prompts.map((p) => p.name);
    expect(names).toContain("summarize-project-status");

    const got = await low.getPrompt({ name: "summarize-project-status", arguments: { projectName: "Rebrand", details: "shipped X" } });
    expect(JSON.stringify(got.messages)).toContain("Rebrand");
    await low.close();

    const a = await connect(anon);
    expect((await a.listPrompts()).prompts).toHaveLength(0);
    await a.close();
  });

  it("a prompt missing a required argument is rejected", async () => {
    const low = await connect(lowUser);
    await expect(low.getPrompt({ name: "summarize-project-status", arguments: { projectName: "X" } })).rejects.toThrow(/details/);
    await low.close();
    expect(getPrompt("nope")).toBeUndefined();
  });
});
