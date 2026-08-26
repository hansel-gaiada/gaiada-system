// The `agents.*` namespace — the control plane's contract, pinned.
//
// These tests guard properties whose loss is SILENT: a router that quietly executes, an invoke that
// forwards the wrong identity, a dispatch that pretends to have happened. Each is the kind of defect
// that leaves the system returning 200s while doing the wrong thing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerAgentsTools } from "./agents-tools";
import { getTool, resetRegistry, allTools } from "./registry";
import { mintPrincipal } from "./principal";
import { config } from "./config";

const human = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });

function mockFetch(status: number, body: string) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

let savedFetch: typeof fetch;
let savedRunner: string;

beforeEach(() => {
  resetRegistry();
  registerAgentsTools();
  savedFetch = globalThis.fetch;
  savedRunner = config.agentRunnerUrl;
  config.agentRunnerUrl = "http://runner.test";
  config.agentRunnerToken = "runner-token";
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  config.agentRunnerUrl = savedRunner;
});

describe("the router's tool view is SMALL — that is the whole point", () => {
  it("registers exactly four tools", () => {
    expect(allTools().map((t) => t.name).sort()).toEqual(["agents.invoke", "agents.list", "agents.runs", "agents.status"]);
  });

  // Hermes today holds ~70 tools as one flat list under one identity. The architecture's central
  // claim is that cutting that view to a handful converts it from an agent into a control plane. If
  // this count ever creeps, the demotion is being quietly undone.
  it("does not acquire a business tool by accident", () => {
    for (const t of allTools()) expect(t.name.startsWith("agents.")).toBe(true);
  });
});

describe("the router ROUTES, it does not EXECUTE", () => {
  // Only invoke writes, and only because it files a goal row. If a second tool here ever gains
  // `write: true`, the split-brain the design exists to prevent has started.
  it("only agents.invoke writes, and its impact is the FLOOR not the gate", () => {
    const writers = allTools().filter((t) => t.write);
    expect(writers.map((t) => t.name)).toEqual(["agents.invoke"]);
    expect(getTool("agents.invoke")!.impact).toBe("low");
  });

  it("agents.list and agents.status are pure reads", () => {
    expect(getTool("agents.list")!.write).toBeUndefined();
    expect(getTool("agents.status")!.write).toBeUndefined();
  });
});

describe("agents.invoke forwards the CALLER's envelope, never a service identity", () => {
  it("sends the human's provider/externalId to the runner", async () => {
    const f = mockFetch(202, '{"id":"g1","status":"queued"}');
    globalThis.fetch = f;
    await getTool("agents.invoke")!.handler({ tenantId: "11111111-1111-1111-1111-111111111111", goal: "do a thing" }, human);

    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const body = JSON.parse(String(init.body));
    // "An agent can never act with more authority than the human it serves" — the envelope is the
    // mechanism that keeps that true, so it must be the caller's, verbatim.
    expect(body.envelope).toEqual({ provider: "whatsapp", externalId: "628110@c.us" });
  });

  it("defaults the seat rather than inventing one", async () => {
    const f = mockFetch(202, '{"id":"g1","status":"queued"}');
    globalThis.fetch = f;
    await getTool("agents.invoke")!.handler({ tenantId: "11111111-1111-1111-1111-111111111111", goal: "x" }, human);
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(JSON.parse(String(init.body)).agent).toBeUndefined(); // runner applies its own default
  });
});

describe("failures are HONEST — the silent-success failure mode is the one that matters", () => {
  it("refuses when no runner is configured, rather than pretending to dispatch", async () => {
    config.agentRunnerUrl = "";
    await expect(
      getTool("agents.invoke")!.handler({ tenantId: "11111111-1111-1111-1111-111111111111", goal: "x" }, human),
    ).rejects.toThrow(/agent runner not configured/);
  });

  it("surfaces the runner's own error body, not a bare status code", async () => {
    // A bare 429 makes an agent retry forever; "goal queue full" tells it to stop.
    globalThis.fetch = mockFetch(429, '{"error":"goal queue full"}');
    await expect(
      getTool("agents.invoke")!.handler({ tenantId: "11111111-1111-1111-1111-111111111111", goal: "x" }, human),
    ).rejects.toThrow(/goal queue full/);
  });
});

describe("agents.cancel does NOT exist, deliberately", () => {
  // The runner exposes no cancel endpoint. A tool that silently fails to cancel is worse than no
  // tool: an operator who believes a runaway goal was stopped will not go and stop it. Containment
  // is the per-goal budget, the cycle/fan-out guards, and `enabled=false` on the seat's registry row.
  it("is absent, and this absence is a decision rather than an oversight", () => {
    expect(getTool("agents.cancel")).toBeUndefined();
  });
});
