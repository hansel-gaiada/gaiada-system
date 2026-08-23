import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAgentRunEvents } from "./agentEvents-data";
import { PlatformError } from "./platform";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});

describe("getAgentRunEvents", () => {
  it("fetches the tenant-scoped route with a since= query and returns the events array", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = String(url);
        return new Response(
          JSON.stringify({
            events: [
              { eventId: "e1", runId: "run-1", goalId: "goal-1", seq: 1, ts: "2026-08-23T00:00:00Z", kind: "model", detail: "planned", durationMs: 10, parentRunId: null },
            ],
          }),
          { status: 200 },
        );
      }),
    );
    const events = await getAgentRunEvents("u1", "t1", "run-1", 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: "e1", seq: 1 });
    expect(capturedUrl).toContain("/api/t1/agents/runs/run-1/events?since=0");
  });

  it("passes a nonzero sinceSeq through as the cursor", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );
    await getAgentRunEvents("u1", "t1", "run-1", 42);
    expect(capturedUrl).toContain("since=42");
  });

  it("floors a negative sinceSeq at 0 rather than forwarding it", async () => {
    let capturedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        capturedUrl = String(url);
        return new Response(JSON.stringify({ events: [] }), { status: 200 });
      }),
    );
    await getAgentRunEvents("u1", "t1", "run-1", -5);
    expect(capturedUrl).toContain("since=0");
  });

  it("degrades to [] on 404 (route/runner unavailable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    expect(await getAgentRunEvents("u1", "t1", "run-1")).toEqual([]);
  });

  it("degrades to [] on 403 (not elevated / not the handoff owner)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })));
    expect(await getAgentRunEvents("u1", "t1", "run-1")).toEqual([]);
  });

  it("re-throws any other error (e.g. 500) instead of silently hiding it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })));
    await expect(getAgentRunEvents("u1", "t1", "run-1")).rejects.toBeInstanceOf(PlatformError);
  });

  it("treats a malformed (non-array) events field as empty rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ events: "not-an-array" }), { status: 200 })));
    expect(await getAgentRunEvents("u1", "t1", "run-1")).toEqual([]);
  });
});
