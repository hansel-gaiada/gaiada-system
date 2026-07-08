import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { config } from "./config";
import { buildHubServer } from "./hub";
import { mintPrincipal, type Principal } from "./principal";
import { registerCoreTools } from "./tools";
import { resetRegistry } from "./registry";
import { visibleTools, authorize } from "./policy";

async function connect(principal: Principal): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildHubServer(principal).connect(serverT);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const lowUser = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });
const anon = mintPrincipal({});

describe("mcp-hub (WS2 skeleton)", () => {
  beforeEach(() => {
    resetRegistry();
    registerCoreTools();
    config.auditFile = "data/test-audit/tools.jsonl";
    rmSync("data/test-audit", { recursive: true, force: true });
  });
  afterAll(() => rmSync("data/test-audit", { recursive: true, force: true }));

  it("mints principals from the envelope — clients can never assert assurance or roles", () => {
    expect(lowUser.assurance).toBe("low");
    expect(anon.assurance).toBe("anonymous");
    expect("role" in lowUser).toBe(false);
  });

  it("tool visibility is filtered per principal (verified-only tools are not advertised)", async () => {
    const names = (p: Principal) => visibleTools(p).map((t) => t.name);
    expect(names(lowUser)).toContain("whoami");
    expect(names(lowUser)).not.toContain("rollup.metrics");
    expect(names(anon)).toContain("ping");

    const client = await connect(lowUser);
    const listed = (await client.listTools()).tools.map((t) => t.name);
    expect(listed).not.toContain("rollup.metrics");
  });

  it("deny-by-default: unknown tools and insufficient assurance are refused and audited", async () => {
    expect(authorize(lowUser, "does.not.exist").allow).toBe(false);

    const client = await connect(lowUser);
    const res = await client.callTool({ name: "rollup.metrics", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("verified");
    expect(JSON.stringify(res.content)).not.toContain("rollup placeholder"); // data never leaks

    const audit = readFileSync(config.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const deny = audit.find((a) => a.tool === "rollup.metrics");
    expect(deny.decision).toBe("deny");
    expect(deny.principal.externalId).toBe("628110@c.us");
  });

  it("AI-backed tools route through the Gateway with its token; anonymous callers can't spend budget", async () => {
    const names = (p: Principal) => visibleTools(p).map((t) => t.name);
    expect(names(lowUser)).toContain("llm.summarize");
    expect(names(anon)).not.toContain("llm.summarize"); // identified callers only

    config.gatewayUrl = "http://gateway.test";
    config.gatewayToken = "gw-token";
    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      expect(url).toBe("http://gateway.test/complete");
      expect(init?.headers?.Authorization).toBe("Bearer gw-token");
      expect(JSON.parse(init?.body ?? "{}").prompt).toContain("standup notes");
      return { ok: true, json: async () => ({ text: "SUMMARY" }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect(lowUser);
    const res = await client.callTool({ name: "llm.summarize", arguments: { text: "standup notes ..." } });
    vi.unstubAllGlobals();
    expect((res.content as Array<{ text: string }>)[0].text).toBe("SUMMARY");
    expect(res.isError ?? false).toBe(false);
  });

  it("a Gateway failure surfaces as a tool error and is audited ok:false — never a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const client = await connect(lowUser);
    const res = await client.callTool({ name: "llm.summarize", arguments: { text: "x" } });
    vi.unstubAllGlobals();
    expect(res.isError).toBe(true);
    const audit = readFileSync(config.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.find((a) => a.tool === "llm.summarize")).toMatchObject({ decision: "allow", ok: false });
  });

  it("platform tools forward the OBO envelope; the PLATFORM decides, the hub just fronts (Task 4.9)", async () => {
    const { registerPlatformTools } = await import("./platform-tools");
    registerPlatformTools();
    config.platformUrl = "http://platform.test";
    config.platformToken = "plat-token";

    const fetchMock = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe("http://platform.test/api/tenant-1/projects");
      expect(init?.headers?.Authorization).toBe("Bearer plat-token");
      expect(init?.headers?.["x-obo-provider"]).toBe("whatsapp");
      expect(init?.headers?.["x-obo-external-id"]).toBe("628110@c.us");
      return { ok: true, status: 200, json: async () => [{ id: "p1", name: "Rebrand" }] };
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect(lowUser);
    const res = await client.callTool({ name: "projects.list", arguments: { tenantId: "tenant-1" } });
    vi.unstubAllGlobals();
    expect((res.content as Array<{ text: string }>)[0].text).toContain("Rebrand");
  });

  it("a platform denial surfaces as a clean tool error (never data)", async () => {
    const { registerPlatformTools } = await import("./platform-tools");
    registerPlatformTools();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: "not authorized: low-assurance session" }) })),
    );
    const client = await connect(lowUser);
    const res = await client.callTool({ name: "projects.list", arguments: { tenantId: "t" } });
    vi.unstubAllGlobals();
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("not authorized");
  });

  it("allowed calls run on behalf of the END USER and are audited as allow", async () => {
    const client = await connect(lowUser);
    const res = await client.callTool({ name: "whoami", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual({ provider: "whatsapp", externalId: "628110@c.us", assurance: "low" });

    const audit = readFileSync(config.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.find((a) => a.tool === "whoami")).toMatchObject({ decision: "allow", ok: true });
  });
});
