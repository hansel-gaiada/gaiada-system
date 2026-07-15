// WS8 Step D — the eval-gated trainer: signal-driven proposals, regression auto-reject (Gate 1),
// and the mandatory human gate (Gate 2). Proves there is NO proposed→approved path without both.
import { describe, it, expect } from "vitest";
import { analyze, evalGate, approve, DEFAULT_THRESHOLDS, type Proposal } from "./trainer";
import type { Episode } from "../memory/episodic";
import type { SuiteReport, EvalResult } from "../evals/harness";
import type { AgentTrace } from "../evals/trace";

function ep(agent: string, over: Partial<Episode> = {}): Episode {
  return {
    runId: `r-${Math.round(over.createdAt ?? 0)}`,
    agent,
    tenantId: "co-1",
    goal: "g",
    status: "ok",
    outcome: "done",
    toolsCalled: [],
    failedTools: [],
    modelCalls: 1,
    toolCalls: 0,
    provenance: "agent",
    feedback: [],
    createdAt: 0,
    ...over,
  };
}

// Minimal SuiteReport for the gate (only names + pass matter to diffBaseline).
function report(cases: Array<{ name: string; pass: boolean }>): SuiteReport {
  const results = cases.map<EvalResult>((c) => ({
    name: c.name,
    pass: c.pass,
    failures: c.pass ? [] : ["x"],
    status: "ok",
    trace: {} as AgentTrace,
  }));
  return { total: results.length, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results, traces: [] };
}

describe("WS8 trainer analyze (Step D)", () => {
  it("proposes a prompt fix when protocol errors dominate", () => {
    const eps = [ep("a", { status: "protocol_error" }), ep("a", { status: "protocol_error" }), ep("a", { status: "ok" })];
    const ps = analyze(eps);
    expect(ps.find((p) => p.kind === "prompt" && p.target === "a")).toBeTruthy();
  });

  it("proposes a tool-use fix when one tool keeps failing", () => {
    const eps = [ep("a", { failedTools: ["tasks.update"] }), ep("a", { failedTools: ["tasks.update"] }), ep("a", {})];
    const p = analyze(eps).find((x) => x.kind === "toolfix");
    expect(p?.id).toBe("a:toolfix:tasks.update");
  });

  it("only TRUSTED down-votes drive a fewshot proposal (D9.3)", () => {
    const withUntrusted = [
      ep("a", { feedback: [{ rating: "down", provenance: "external", trust: "untrusted", at: 1 }] }),
      ep("a", { feedback: [{ rating: "down", provenance: "external", trust: "untrusted", at: 1 }] }),
      ep("a", {}),
    ];
    expect(analyze(withUntrusted).find((p) => p.kind === "fewshot")).toBeFalsy(); // quarantined → no signal

    const withTrusted = [
      ep("a", { feedback: [{ rating: "down", provenance: "human", trust: "trusted", at: 1 }] }),
      ep("a", { feedback: [{ rating: "down", provenance: "human", trust: "trusted", at: 1 }] }),
      ep("a", {}),
    ];
    expect(analyze(withTrusted).find((p) => p.kind === "fewshot")).toBeTruthy();
  });

  it("does not propose from too little evidence", () => {
    expect(analyze([ep("a", { status: "protocol_error" })], DEFAULT_THRESHOLDS)).toEqual([]);
  });
});

describe("WS8 trainer gates (D13): beat the baseline AND human approval", () => {
  const proposal: Proposal = { id: "a:prompt", kind: "prompt", target: "a", rationale: "x", status: "proposed", change: {} };
  const baseline = report([{ name: "c1", pass: true }, { name: "c2", pass: true }]);

  it("Gate 1: a regression auto-rejects (a green scalar is not enough)", () => {
    const candidate = report([{ name: "c1", pass: true }, { name: "c2", pass: false }]); // c2 regressed
    const gated = evalGate(proposal, baseline, candidate);
    expect(gated.status).toBe("rejected");
    expect(gated.evalDelta?.regressed).toEqual(["c2"]);
  });

  it("Gate 1: no regression ⇒ eval_passed (eligible, NOT yet live)", () => {
    const candidate = report([{ name: "c1", pass: true }, { name: "c2", pass: true }]);
    expect(evalGate(proposal, baseline, candidate).status).toBe("eval_passed");
  });

  it("Gate 2: only an eval_passed proposal can be approved, and only with a human diff review", () => {
    const passed = evalGate(proposal, baseline, report([{ name: "c1", pass: true }, { name: "c2", pass: true }]));
    expect(() => approve(proposal, true)).toThrow(/must pass the eval gate/); // still "proposed"
    expect(() => approve(passed, false)).toThrow(/human review/); // no autonomous update
    expect(approve(passed, true).status).toBe("approved");
  });
});
