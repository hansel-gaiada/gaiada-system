import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerWorkActivityTools } from "./work-activity-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:wd-digests" });

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("WD-26 work_activity hub tools", () => {
  beforeEach(() => {
    resetRegistry();
    registerWorkActivityTools();
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers workActivity.feed / workActivity.staleTasks / workActivity.relink", () => {
    for (const n of ["workActivity.feed", "workActivity.staleTasks", "workActivity.relink"]) {
      expect(getTool(n)).toBeDefined();
    }
  });

  it("only workActivity.relink is a write (and it is LOW impact — no medium+ write anywhere, DEF-3)", () => {
    expect(getTool("workActivity.feed")!.write).toBeUndefined();
    expect(getTool("workActivity.staleTasks")!.write).toBeUndefined();
    expect(getTool("workActivity.relink")!.write).toBe(true);
    expect(getTool("workActivity.relink")!.impact).toBe("low");
  });

  it("workActivity.feed GETs /work-activity, forwards filters + the OBO envelope", async () => {
    const spy = mockFetch(200, [{ id: "wa-1" }]);
    vi.stubGlobal("fetch", spy);
    const out = await getTool("workActivity.feed")!.handler(
      { tenantId: "co-1", projectId: "proj-1", since: "2026-07-01T00:00:00.000Z", limit: 50 },
      principal,
    );
    expect(JSON.parse(out)).toEqual([{ id: "wa-1" }]);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/work-activity?");
    expect(url).toContain("projectId=proj-1");
    expect(url).toContain("limit=50");
    expect((init.headers as Record<string, string>)["x-obo-external-id"]).toBe("wf:wd-digests");
  });

  it("workActivity.feed with no filters hits the bare collection route", async () => {
    const spy = mockFetch(200, []);
    vi.stubGlobal("fetch", spy);
    await getTool("workActivity.feed")!.handler({ tenantId: "co-1" }, principal);
    const [url] = (spy as any).mock.calls[0];
    expect(url).toMatch(/\/api\/co-1\/work-activity$/);
  });

  it("workActivity.staleTasks GETs the stale-tasks route with days forwarded", async () => {
    const spy = mockFetch(200, [{ taskId: "t-1", daysStale: 12 }]);
    vi.stubGlobal("fetch", spy);
    const out = await getTool("workActivity.staleTasks")!.handler({ tenantId: "co-1", days: 5 }, principal);
    expect(JSON.parse(out)).toEqual([{ taskId: "t-1", daysStale: 12 }]);
    const [url] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/work-activity/stale-tasks?days=5");
  });

  it("workActivity.relink POSTs to /work-activity/relink with the limit forwarded", async () => {
    const spy = mockFetch(200, { scanned: 3, relinked: 2, linksAdded: 2 });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("workActivity.relink")!.handler({ tenantId: "co-1", limit: 50 }, principal);
    expect(JSON.parse(out)).toEqual({ scanned: 3, relinked: 2, linksAdded: 2 });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/work-activity/relink?limit=50");
    expect(init.method).toBe("POST");
  });

  it("a platform denial surfaces as a clean tool error (never data)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: "not authorized: work_activity" }) })) as unknown as typeof fetch);
    await expect(getTool("workActivity.relink")!.handler({ tenantId: "co-1" }, principal)).rejects.toThrow(/not authorized/);
  });
});
