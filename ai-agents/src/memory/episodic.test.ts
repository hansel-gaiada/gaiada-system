// WS8 Step D — episodic memory D9 invariants: build-from-trace, tenant pre-filter (D9.1),
// feedback trust quarantine (D9.3), and erasure (D9.2).
import { describe, it, expect } from "vitest";
import { EpisodicStore, episodeFromTrace, type Episode } from "./episodic";
import type { AgentTrace } from "../evals/trace";

function trace(runId: string, agent: string, over: Partial<AgentTrace> = {}): AgentTrace {
  return {
    v: 1,
    runId,
    agent,
    envelope: { provider: "telegram", externalId: "tg:1" },
    goal: "g",
    status: "ok",
    outcome: "done",
    steps: [
      { kind: "model", detail: "{...}" },
      { kind: "tool", detail: "tasks.list ok" },
      { kind: "tool", detail: "tasks.update failed" },
    ],
    modelCalls: 1,
    toolCalls: 2,
    toolsCalled: ["tasks.list", "tasks.update"],
    startedAt: 1,
    endedAt: 2,
    ...over,
  };
}

describe("WS8 episodic memory (Step D, D9)", () => {
  it("episodeFromTrace maps fields and recovers failed tools from the steps", () => {
    const e = episodeFromTrace(trace("r1", "status-reporter"), "co-1", "echo");
    expect(e).toMatchObject({ runId: "r1", agent: "status-reporter", tenantId: "co-1", provider: "echo", provenance: "agent" });
    expect(e.toolsCalled).toEqual(["tasks.list", "tasks.update"]);
    expect(e.failedTools).toEqual(["tasks.update"]); // the " failed" step only
  });

  it("D9.1: query hard pre-filters by the authorized-tenant-set (cross-tenant episode never returned)", () => {
    const s = new EpisodicStore();
    s.record(episodeFromTrace(trace("r1", "a"), "co-1"));
    s.record(episodeFromTrace(trace("r2", "a"), "co-2"));
    expect(s.query(["co-1"]).map((e) => e.runId)).toEqual(["r1"]);
    expect(s.query(["co-1", "co-2"])).toHaveLength(2);
    expect(s.query([])).toHaveLength(0); // no tenant context ⇒ nothing
  });

  it("query filters by agent and status", () => {
    const s = new EpisodicStore();
    s.record(episodeFromTrace(trace("r1", "a", { status: "ok" }), "co-1"));
    s.record(episodeFromTrace(trace("r2", "b", { status: "protocol_error" }), "co-1"));
    expect(s.query(["co-1"], { agent: "b" }).map((e) => e.runId)).toEqual(["r2"]);
    expect(s.query(["co-1"], { status: "protocol_error" }).map((e) => e.runId)).toEqual(["r2"]);
  });

  it("D9.3: untrusted feedback is quarantined — never returned as trusted signal", () => {
    const s = new EpisodicStore();
    s.record(episodeFromTrace(trace("r1", "a"), "co-1"));
    s.addFeedback("r1", { rating: "down", provenance: "external", trust: "untrusted", at: 1 });
    s.addFeedback("r1", { rating: "up", provenance: "human", trust: "trusted", at: 2 });
    const e = s.query(["co-1"])[0];
    expect(e.feedback).toHaveLength(2); // both recorded (audit)
    expect(s.trustedFeedback(e).map((f) => f.rating)).toEqual(["up"]); // only the trusted one is signal
  });

  it("D9.2: eraseTenant hard-deletes a tenant's episodes (crypto-shred reach)", () => {
    const s = new EpisodicStore();
    s.record(episodeFromTrace(trace("r1", "a"), "co-1"));
    s.record(episodeFromTrace(trace("r2", "a"), "co-2"));
    expect(s.eraseTenant("co-1")).toBe(1);
    expect(s.query(["co-1", "co-2"]).map((e) => e.runId)).toEqual(["r2"]);
  });
});
