import { describe, it, expect, beforeEach, vi } from "vitest";
import { config } from "./config";
import { registerModuleTools } from "./module-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:stale-approval-chaser" });

describe("module-tools aggregation (WS2 §6)", () => {
  beforeEach(() => {
    resetRegistry();
    config.platformUrl = "http://platform.test";
    config.platformToken = "plat-token";
  });

  it("registers callable module tools from /mcp/tool-defs and fronts the platform generically", async () => {
    const defsFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { name: "agency.pendingApprovals", description: "Approvals waiting", minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/modules/agency/approvals/pending", inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] } },
        { name: "agency.info", description: "informational only", minAssurance: "low", inputSchema: { type: "object", properties: {} } },
      ],
    })) as unknown as typeof fetch;

    const n = await registerModuleTools(defsFetch);
    expect(n).toBe(1); // the informational-only def (no pathTemplate) is skipped
    const tool = getTool("agency.pendingApprovals")!;
    expect(tool).toBeTruthy();
    expect(getTool("agency.info")).toBeUndefined();

    const callFetch = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      expect(url).toBe("http://platform.test/api/tenant-9/modules/agency/approvals/pending");
      expect(init?.headers?.["x-obo-external-id"]).toBe("wf:stale-approval-chaser");
      return { ok: true, status: 200, json: async () => [{ id: "a1" }] };
    });
    vi.stubGlobal("fetch", callFetch);
    const out = await tool.handler({ tenantId: "tenant-9" }, principal);
    vi.unstubAllGlobals();
    expect(out).toContain("a1");
  });

  it("substitutes path params and sends the remaining args as the body for writes", async () => {
    const defsFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { name: "agency.createBrief", description: "create a brief", minAssurance: "low", write: true, impact: "low", method: "POST", pathTemplate: "/api/:tenantId/modules/agency/campaigns/:campaignId/briefs", inputSchema: { type: "object", properties: {} } },
      ],
    })) as unknown as typeof fetch;
    await registerModuleTools(defsFetch);
    const tool = getTool("agency.createBrief")!;
    expect(tool.write).toBe(true);
    expect(tool.impact).toBe("low");

    const callFetch = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      expect(url).toBe("http://platform.test/api/t1/modules/agency/campaigns/c1/briefs");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body ?? "{}")).toEqual({ title: "Q3 launch" }); // path params stripped
      return { ok: true, status: 201, json: async () => ({ id: "b1" }) };
    });
    vi.stubGlobal("fetch", callFetch);
    const out = await tool.handler({ tenantId: "t1", campaignId: "c1", title: "Q3 launch" }, principal);
    vi.unstubAllGlobals();
    expect(out).toContain("b1");
  });

  it("fails soft to zero tools when the platform is unreachable", async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await registerModuleTools(bad)).toBe(0);
  });
});
