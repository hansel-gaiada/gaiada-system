import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listFailuresResult } from "./automationFailures";
import { getDemoResponse } from "./demoFixtures";

// DW-7i-1 (BFF §52.12): the honest reader behind the Failing workflows tile and page. Pinned: it reads its route with the window, a 403
// is forbidden and anything else is unavailable, `not_configured` and `unavailable` are states that carry no figures, and a 200 in the
// wrong shape (the demo layer's `[]`, a drifted backend) is unavailable, never "no failures": that is a claim only a real `on` may make.
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
const urlOf = (f: ReturnType<typeof vi.fn>) => String((f.mock.calls[0] as unknown[])[0]);
const WRONG = "The failing-workflows read returned an unexpected answer.";

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});
afterEach(() => { vi.unstubAllGlobals(); });

const run = (over: Record<string, unknown> = {}) => ({
  executionId: "9021", workflowId: "wf1", workflowName: "Invoice chaser", startedAt: "2026-10-16T08:00:00Z", stoppedAt: "2026-10-16T08:00:04Z", mode: "trigger", ...over,
});
const ON = { asOf: "2026-10-16T09:00:00Z", window: "24h", state: "on", failed: [run()], count: 1, capped: false, editorUrl: "https://n8n.example.test" };

describe("listFailuresResult", () => {
  it("reads its own route with the window (24h by default) and returns the answer", async () => {
    const f = answer(200, ON);
    vi.stubGlobal("fetch", f);
    expect(await listFailuresResult("u1", "co-a")).toEqual({ kind: "ok", data: ON });
    expect(urlOf(f)).toBe("http://p.test/api/co-a/automation/failures?window=24h");
    const g = answer(200, { ...ON, window: "7d" });
    vi.stubGlobal("fetch", g);
    await listFailuresResult("u1", "co-a", "7d");
    expect(urlOf(g)).toBe("http://p.test/api/co-a/automation/failures?window=7d");
  });

  it("a real zero is ok (n8n answered); a count above the list, and capped, are kept", async () => {
    vi.stubGlobal("fetch", answer(200, { ...ON, failed: [], count: 0 }));
    expect(await listFailuresResult("u1", "co-a")).toMatchObject({ kind: "ok", data: { state: "on", failed: [], count: 0, capped: false } });
    vi.stubGlobal("fetch", answer(200, { ...ON, count: 250, capped: true, reason: "at least" }));
    expect(await listFailuresResult("u1", "co-a")).toMatchObject({ kind: "ok", data: { count: 250, capped: true, reason: "at least" } });
  });

  it("a missing capped flag is not capped, and a run without stoppedAt or mode keeps them as null", async () => {
    const { capped, ...noCap } = ON;
    void capped;
    vi.stubGlobal("fetch", answer(200, { ...noCap, failed: [run({ stoppedAt: undefined, mode: undefined })] }));
    expect(await listFailuresResult("u1", "co-a")).toMatchObject({ kind: "ok", data: { capped: false, failed: [{ stoppedAt: null, mode: null }] } });
  });

  it("carries not_configured and unavailable as states with their reason and NO figures", async () => {
    vi.stubGlobal("fetch", answer(200, { asOf: "a", window: "24h", state: "not_configured", reason: "no key", failed: [], count: 0 }));
    expect(await listFailuresResult("u1", "co-a")).toEqual({ kind: "ok", data: { asOf: "a", window: "24h", state: "not_configured", reason: "no key" } });
    vi.stubGlobal("fetch", answer(200, { asOf: "a", window: "24h", state: "unavailable", reason: "n8n did not answer", failed: [], count: 0, editorUrl: "https://n8n.example.test" }));
    expect(await listFailuresResult("u1", "co-a")).toEqual({
      kind: "ok", data: { asOf: "a", window: "24h", state: "unavailable", reason: "n8n did not answer", editorUrl: "https://n8n.example.test" },
    });
  });

  it("a wrong-shaped 200 is unavailable, never an empty list", async () => {
    for (const body of [
      [], {}, null, "ok",
      { asOf: "a", window: "24h" },
      { ...ON, state: "maybe" }, { ...ON, window: "1y" }, { ...ON, window: undefined }, { ...ON, failed: "none" }, { ...ON, failed: undefined },
      { ...ON, count: "1" }, { ...ON, count: -1 }, { ...ON, count: 0 }, // a count below what it lists
      { ...ON, failed: [run({ workflowName: undefined })] }, { ...ON, failed: [run({ startedAt: 5 })] }, { ...ON, failed: [null] },
      { asOf: "a", window: "24h", state: "unavailable" }, { asOf: "a", window: "24h", state: "not_configured", reason: "" },
    ]) {
      vi.stubGlobal("fetch", answer(200, body));
      expect(await listFailuresResult("u1", "co-a"), JSON.stringify(body)).toEqual({ kind: "unavailable", reason: WRONG });
    }
  });
});

describe("listFailuresResult refusals", () => {
  it("is forbidden on 403 (not in the audience) and on 404 (this company does not run the shared automation)", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "forbidden", reason: "not_in_audience" }));
    expect(await listFailuresResult("u1", "co-a")).toEqual({ kind: "forbidden" });
    // A 404 hides the tile too, so IT staff of a company without automation never see an "Unavailable" tile meant for others.
    vi.stubGlobal("fetch", answer(404, { error: "not found" }));
    expect(await listFailuresResult("u1", "co-a")).toEqual({ kind: "forbidden" });
  });

  it("is unavailable, in the server's words, on 400 and 5xx", async () => {
    for (const status of [400, 500, 503]) {
      vi.stubGlobal("fetch", answer(status, { error: `failed ${status}` }));
      expect(await listFailuresResult("u1", "co-a")).toEqual({ kind: "unavailable", reason: `failed ${status}` });
    }
  });

  it("is unavailable when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    expect(await listFailuresResult("u1", "co-a")).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });
});

describe("the demo layer (DW-7i-1 block of demoFixtures)", () => {
  beforeEach(() => { process.env.DEMO_MODE = "1"; });
  afterEach(() => { delete process.env.DEMO_MODE; });

  it("answers the route in the shape the reader checks: two recent failed runs in 24h, more in 7d", async () => {
    const day = await listFailuresResult("demo-hansel", "co-demo", "24h");
    const week = await listFailuresResult("demo-hansel", "co-demo", "7d");
    if (day.kind !== "ok" || day.data.state !== "on" || week.kind !== "ok" || week.data.state !== "on") throw new Error("not on");
    expect(day.data.count).toBe(2);
    expect(week.data.count).toBe(3);
    expect(day.data.failed.map((r) => r.workflowName)).toEqual(["Invoice chaser", "WhatsApp lead intake"]);
    expect(day.data.editorUrl).toBeTruthy();
  });

  it("answers GET only, so the dispatcher's catch-all never turns it into []", () => {
    expect(getDemoResponse("GET", "/api/co-demo/automation/failures?window=24h", "demo-hansel").status).toBe(200);
    expect(Array.isArray(getDemoResponse("GET", "/api/co-demo/automation/failures", "demo-hansel").json)).toBe(false);
  });
});
