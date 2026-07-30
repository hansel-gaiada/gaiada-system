import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { config } from "./config";
import {
  registerModuleTools,
  moduleToolsStatus,
  resetModuleToolsStatus,
  startModuleToolsBootstrap,
  stopModuleToolsBootstrap,
} from "./module-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:stale-approval-chaser" });

describe("module-tools aggregation (WS2 §6)", () => {
  beforeEach(() => {
    resetRegistry();
    resetModuleToolsStatus();
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

  // SM-45: a one-shot fetch at boot froze the hub at zero module tools forever whenever the
  // platform wasn't up yet, or restarted later. These pin the observable state that the retry
  // loop (server.ts startModuleToolsBootstrap) and /health / /admin/info depend on.
  it("tracks consecutive failures and the last error in moduleToolsStatus()", async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await registerModuleTools(bad);
    await registerModuleTools(bad);
    const s = moduleToolsStatus();
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastError).toContain("503");
    expect(s.registered).toBe(0);
    expect(s.lastSuccessAt).toBeNull();
  });

  it("resets consecutiveFailures and stamps lastSuccessAt once the platform recovers", async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await registerModuleTools(bad);
    expect(moduleToolsStatus().consecutiveFailures).toBe(1);

    const good = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { name: "agency.pendingApprovals", description: "Approvals waiting", minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/modules/agency/approvals/pending", inputSchema: { type: "object", properties: {} } },
      ],
    })) as unknown as typeof fetch;
    const n = await registerModuleTools(good);
    expect(n).toBe(1);
    const s = moduleToolsStatus();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.registered).toBe(1);
    expect(s.lastSuccessAt).not.toBeNull();
  });

  describe("startModuleToolsBootstrap (self-heal loop)", () => {
    afterEach(() => {
      stopModuleToolsBootstrap();
      vi.useRealTimers();
    });

    // The actual acceptance criterion for SM-45: the hub starts (this test never blocks on the
    // first attempt) even though the platform is down, retries in the background, and picks up
    // the tools once the platform comes up WITHOUT anything restarting the hub process.
    it("reproduces the boot-order race: starts with 0 tools, retries, then self-heals once the platform recovers", async () => {
      vi.useFakeTimers();
      let platformUp = false;
      const fetchImpl = vi.fn(async () => {
        if (!platformUp) throw new Error("fetch failed");
        return {
          ok: true,
          status: 200,
          json: async () => [
            { name: "search.listEngagements", description: "list engagements", minAssurance: "low", method: "GET", pathTemplate: "/api/:tenantId/modules/search/engagements", inputSchema: { type: "object", properties: {} } },
          ],
        };
      }) as unknown as typeof fetch;

      startModuleToolsBootstrap(fetchImpl);
      await vi.advanceTimersByTimeAsync(0); // let the first (immediate) attempt settle
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(moduleToolsStatus().registered).toBe(0);
      expect(moduleToolsStatus().consecutiveFailures).toBe(1);
      expect(getTool("search.listEngagements")).toBeUndefined();

      // Platform still down: advance through a couple of backoff retries — still no tools, but the
      // hub keeps trying (this is what a one-shot fetch could never do).
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(moduleToolsStatus().registered).toBe(0);

      // Platform comes up — no restart of the hub, just the next scheduled retry firing.
      platformUp = true;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(moduleToolsStatus().registered).toBe(1);
      expect(moduleToolsStatus().consecutiveFailures).toBe(0);
      expect(getTool("search.listEngagements")).toBeTruthy();
    });
  });
});
