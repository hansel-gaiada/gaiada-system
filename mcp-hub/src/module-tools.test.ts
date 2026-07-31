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

  // TR-28 (platform-nest reports module) — these defs need real HTTP query-string filters
  // (grain/scopeRef/periodKind/start/end, kind/from/to, metricKey/grain/from/to) on a GET route
  // that has NO :param slot for them (the routes are fixed: /reports/document, /reports/periods,
  // /reports/metrics). Every OTHER GET module tool registered anywhere in the codebase needs
  // nothing beyond a literal path segment (:tenantId or similar) — this is the first one that
  // doesn't, and it is what exposed the fact that callPlatform() has NO query-string path at all
  // for GET (see this file's `substitutes path params and sends the remaining args as the body for
  // writes` test above: unused GET args are simply absent from the asserted URL). TR-28 worked
  // around it, WITHOUT changing this file, by embedding the filters as a `?key=:key` query string
  // directly inside pathTemplate — fillPath()'s regex substitution has no path/query distinction,
  // so it honors that literally. These tests prove the mechanism actually produces the correct,
  // fully-encoded request through the REAL registerModuleTools()/callPlatform() code path (not a
  // reimplementation), for both a plain filtered GET and a periodKind='custom' range — the two
  // shapes platform-nest's own reports-mcp-tools.db.test.ts relies on this file behaving like.
  describe("GET tools whose filters live in the query string (TR-28 pathTemplate technique)", () => {
    it("fills EVERY :token in the template — including ones after '?' — and drops nothing", async () => {
      const defsFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            name: "reports.getDocument",
            description: "fetch a report document",
            minAssurance: "low",
            method: "GET",
            pathTemplate: "/api/:tenantId/reports/document?grain=:grain&scopeRef=:scopeRef&periodKind=:periodKind&start=:start&end=:end",
            inputSchema: {
              type: "object",
              properties: {
                tenantId: { type: "string" }, grain: { type: "string" }, scopeRef: { type: "string" },
                periodKind: { type: "string" }, start: { type: "string" }, end: { type: "string" },
              },
              required: ["tenantId", "grain", "scopeRef", "periodKind", "start", "end"],
            },
          },
        ],
      })) as unknown as typeof fetch;

      const n = await registerModuleTools(defsFetch);
      expect(n).toBe(1);
      const tool = getTool("reports.getDocument")!;

      const callFetch = vi.fn(async (url: string) => {
        // Every filter arrived as a real query param — none silently dropped — and dates/ids are
        // correctly percent-encoded by the SAME fillPath() the tenantId path segment uses.
        expect(url).toBe(
          "http://platform.test/api/tenant-9/reports/document?grain=person&scopeRef=user-1&periodKind=custom&start=2026-01-01&end=2026-01-31",
        );
        return { ok: true, status: 200, json: async () => ({ header: { periodKind: "custom" } }) };
      });
      vi.stubGlobal("fetch", callFetch);
      const out = await tool.handler(
        { tenantId: "tenant-9", grain: "person", scopeRef: "user-1", periodKind: "custom", start: "2026-01-01", end: "2026-01-31" },
        principal,
      );
      vi.unstubAllGlobals();
      expect(out).toContain("custom");
    });

    it("throws rather than silently omitting a filter when the tool omits a token the pathTemplate declares", async () => {
      const defsFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [
          {
            name: "reports.listPeriods",
            description: "list periods",
            minAssurance: "low",
            method: "GET",
            pathTemplate: "/api/:tenantId/reports/periods?kind=:kind&from=:from&to=:to",
            inputSchema: { type: "object", properties: {}, required: ["tenantId", "kind", "from", "to"] },
          },
        ],
      })) as unknown as typeof fetch;
      await registerModuleTools(defsFetch);
      const tool = getTool("reports.listPeriods")!;

      // No fetch stub needed — a missing token must fail BEFORE any network call, never send a
      // request with a literal "undefined" or an empty query value that the platform might
      // misinterpret as "no filter" when the caller actually meant to filter.
      await expect(tool.handler({ tenantId: "tenant-9", kind: "day", from: "2026-01-01" }, principal)).rejects.toThrow(
        /missing path parameter: to/,
      );
    });
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
      });

      // Cast at the call site, not the declaration — casting the binding itself erased the
      // vi.Mock type and made `fetchImpl.mock` below a type error.
      startModuleToolsBootstrap(fetchImpl as unknown as typeof fetch);
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
