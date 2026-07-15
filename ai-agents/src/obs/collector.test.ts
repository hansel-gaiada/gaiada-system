// WS9 — observability collector: per-agent metrics, provider attribution, quality alerts, and the
// D13 detective control (writes served by an un-evaled provider).
import { describe, it, expect } from "vitest";
import { ObservabilityCollector, DEFAULT_ALERT_POLICY } from "./collector";
import type { AgentTrace, TraceStatus } from "../evals/trace";

let clock = 0;
function trace(agent: string, status: TraceStatus, over: Partial<AgentTrace> = {}): AgentTrace {
  clock += 10;
  return {
    v: 1,
    runId: `r-${clock}`,
    agent,
    envelope: { provider: "telegram", externalId: "tg:1" },
    goal: "g",
    status,
    outcome: status === "ok" ? "done" : status,
    steps: [{ kind: "model", detail: "{...}" }, { kind: "tool", detail: "tasks.list ok" }],
    modelCalls: 1,
    toolCalls: 1,
    toolsCalled: ["tasks.list"],
    startedAt: clock,
    endedAt: clock + 5,
    ...over,
  };
}

describe("WS9 observability collector", () => {
  it("aggregates per-agent metrics: success rate, status/provider breakdown, tool failures", () => {
    const c = new ObservabilityCollector();
    c.record(trace("a", "ok"), "gemini");
    c.record(trace("a", "ok"), "ollama");
    c.record(trace("a", "protocol_error", { steps: [{ kind: "tool", detail: "tasks.list failed" }] }), "gemini");
    const m = c.agentMetrics("a");
    expect(m.runs).toBe(3);
    expect(m.ok).toBe(2);
    expect(m.successRate).toBeCloseTo(2 / 3);
    expect(m.byStatus).toMatchObject({ ok: 2, protocol_error: 1 });
    expect(m.byProvider).toMatchObject({ gemini: 2, ollama: 1 });
    expect(m.toolFailures).toMatchObject({ "tasks.list": 1 });
  });

  it("recent returns newest-first and filters by agent/status", () => {
    const c = new ObservabilityCollector();
    c.record(trace("a", "ok"));
    c.record(trace("b", "ok"));
    const latest = c.record(trace("a", "budget_exhausted"));
    expect(c.recent(1)[0].runId).toBe(latest.runId);
    expect(c.recent(10, { agent: "a" }).every((r) => r.agent === "a")).toBe(true);
    expect(c.recent(10, { status: "budget_exhausted" }).map((r) => r.runId)).toEqual([latest.runId]);
  });

  it("raises low_success and high_refusal alerts only above minRuns", () => {
    const c = new ObservabilityCollector();
    // 5 runs, 1 ok, 3 protocol_error, 1 tool_not_allowed → low success + high refusal.
    c.record(trace("bad", "ok"));
    c.record(trace("bad", "protocol_error"));
    c.record(trace("bad", "protocol_error"));
    c.record(trace("bad", "protocol_error"));
    c.record(trace("bad", "tool_not_allowed"));
    const alerts = c.alerts(DEFAULT_ALERT_POLICY);
    expect(alerts.find((a) => a.agent === "bad" && a.kind === "low_success")).toBeTruthy();
    expect(alerts.find((a) => a.agent === "bad" && a.kind === "high_refusal")).toBeTruthy();

    // A healthy agent with too few runs → no alert.
    const c2 = new ObservabilityCollector();
    c2.record(trace("thin", "protocol_error"));
    expect(c2.alerts()).toEqual([]);
  });

  it("D13 detective: flags a write executed on a provider not eval-cleared for the agent", () => {
    const c = new ObservabilityCollector();
    c.record(trace("task-triager", "ok", { toolsCalled: ["tasks.update"] }), "claude"); // wrote on claude
    c.record(trace("task-triager", "ok", { toolsCalled: ["tasks.update"] }), "gemini"); // cleared
    c.record(trace("task-triager", "ok", { toolsCalled: [] }), "claude"); // no write → fine
    const flagged = c.writesOnUnevaledProvider({ "task-triager": ["gemini"] });
    expect(flagged).toHaveLength(1);
    expect(flagged[0].provider).toBe("claude");
  });
});
