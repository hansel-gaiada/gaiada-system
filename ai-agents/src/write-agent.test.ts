// WS8 Step B — the write-capable specialist path: D13 provider gate + D14 approval filing, proven
// deterministically with mock deps (no live Gateway/hub).
import { describe, it, expect } from "vitest";
import { runWriteAgent, isWriteCapable, readOnlyProjection, fileApproval, toWireImpact, WIRE_IMPACTS } from "./write-agent";
import { taskTriager, taskFiler } from "./specialists";
import { ApprovalRequiredError } from "./agent";
import type { AgentDef, AgentDeps } from "./agent";

const envelope = { provider: "telegram", externalId: "tg:555" };

// Records tool calls; returns a fixture per tool ("approvals.request" returns an approval id).
function deps(model: string[], toolResults: Record<string, string> = {}): AgentDeps & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  let i = 0;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    complete: async () => model[Math.min(i++, model.length - 1)],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "approvals.request") return JSON.stringify({ id: "ap-1", status: "pending" });
      return toolResults[name] ?? "[]";
    },
  };
}

// A deps() whose Gateway REPORTS which provider served — the wire D13 now enforces against.
// The plain `deps()` above deliberately omits `lastProvider`, which is why every pre-existing test
// still exercises the declaration-only path unchanged.
function depsServedBy(served: string, model: string[], toolResults: Record<string, string> = {}) {
  const d = deps(model, toolResults);
  return Object.assign(d, { lastProvider: () => served });
}

const highWriteAgent: AgentDef = {
  name: "risky-agent",
  systemPrompt: "test",
  tools: { "tasks.list": "read", "tasks.update": "high_write" },
  maxSteps: 5,
  maxToolCalls: 3,
  evaledProviders: ["gemini"], // cleared on gemini
};

describe("WS8 write-agent (Step B): D13 provider gate + D14 approval filing", () => {
  it("isWriteCapable / readOnlyProjection reflect the tool impacts", () => {
    expect(isWriteCapable(taskTriager)).toBe(true);
    expect(isWriteCapable({ ...taskTriager, tools: { "tasks.list": "read" } })).toBe(false);
    const ro = readOnlyProjection(highWriteAgent);
    expect(Object.keys(ro.tools)).toEqual(["tasks.list"]); // write tool stripped
  });

  it("on an EVALED provider, a low_write completes and executes", async () => {
    const agent = { ...taskTriager, evaledProviders: ["echo"] };
    const d = deps(
      [`{"tool": "tasks.list", "args": {}}`, `{"tool": "tasks.update", "args": {"taskId": "t1", "priority": "high"}}`, `{"final": "raised 1 overdue task"}`],
      { "tasks.list": JSON.stringify([{ id: "t1", title: "x", status: "todo" }]) },
    );
    const res = await runWriteAgent(agent, "triage", envelope, d, "co-1", "echo");
    expect(res.status).toBe("completed");
    expect(d.calls.map((c) => c.name)).toContain("tasks.update"); // the low_write ran
  });

  it("on an evaled provider, a high_write SUSPENDS and files an agent-origin approval (nothing executes)", async () => {
    const d = deps([`{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("suspended");
    // T2b: no `fileOnSuspend` opt passed ⇒ the filed (non-null) shape; optional chaining only
    // satisfies the type now that `"suspended"` has two shapes.
    if (res.status === "suspended") expect(res.filed?.approvalId).toBe("ap-1");
    // The high_write itself never executed — only approvals.request was called.
    const toolCalls = d.calls.map((c) => c.name);
    expect(toolCalls).toContain("approvals.request");
    expect(toolCalls).not.toContain("tasks.update");
    // The filed approval carries origin=agent, the agent name, the tool + its intended args.
    const filed = d.calls.find((c) => c.name === "approvals.request")!.args;
    expect(filed).toMatchObject({ origin: "agent", agentName: "risky-agent", toolName: "tasks.update", toolArgs: { taskId: "t1", status: "done" } });
  });

  it("D13: on an UN-EVALED provider a write-capable agent is forced read-only (writes unavailable)", async () => {
    // The model would try to write, but the write tool is stripped, so it is refused; here the model
    // stays within reads and finishes — proving writes simply aren't offered on an unproven provider.
    const d = deps([`{"tool": "tasks.list", "args": {}}`, `{"final": "read-only summary"}`], { "tasks.list": "[]" });
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "claude"); // claude not evaled
    expect(res.status).toBe("forced_read_only");
    if (res.status === "forced_read_only") expect(res.reason).toMatch(/not eval-cleared/);
    expect(d.calls.map((c) => c.name)).not.toContain("tasks.update");
  });
});

// T1 — the bug this closes: `fileApproval` used to forward `err.impact` ("high_write") straight to the
// hub's `approvals.request` tool, whose real JSON-schema enum (and the platform controller's `IMPACTS`
// set / migration 0014 CHECK constraint) only ever accepted `medium | high | unclassified`. The suite
// above never caught it because `deps().callTool` is a permissive mock that accepts ANY args — exactly
// the gap the ticket calls out. These tests assert the actual VALUE handed to `approvals.request`,
// against the real accepted set, not merely that `fileApproval` was called.
describe("T1 — the agent-side Impact label is translated to the wire vocabulary before filing", () => {
  // Restated from platform-nest/src/core/automation-approvals.controller.ts's `IMPACTS` set (see
  // write-agent.ts's header on why this is restated rather than imported: ai-agents and platform-nest
  // are separate standalone projects, not a monorepo). If that set ever changes, this literal and
  // `WIRE_IMPACTS` in write-agent.ts must change with it — this test is the tripwire for that drift.
  const REAL_PLATFORM_IMPACTS = new Set(["medium", "high", "unclassified"]);

  it("WIRE_IMPACTS matches the real platform controller's accepted set exactly", () => {
    expect(new Set(WIRE_IMPACTS)).toEqual(REAL_PLATFORM_IMPACTS);
  });

  it("THE BUG THIS CATCHES: a suspended high_write files a wire-legal impact, never the raw agent-side label", async () => {
    const d = deps([], {});
    const err = new ApprovalRequiredError("tasks.update", "high_write", { taskId: "t1" }, []);
    await fileApproval(d, envelope, "co-1", "risky-agent", err);
    const filedArgs = d.calls.find((c) => c.name === "approvals.request")!.args;
    // Without the fix this would be "high_write", which is NOT in REAL_PLATFORM_IMPACTS — the exact
    // 400 the real controller would have returned.
    expect(REAL_PLATFORM_IMPACTS.has(filedArgs.impact as string)).toBe(true);
    expect(filedArgs.impact).toBe("high");
  });

  it("toWireImpact maps every value onto the real accepted set, or throws — never silently passes an illegal value through", () => {
    expect(toWireImpact("high_write")).toBe("high");
    expect(WIRE_IMPACTS).toContain(toWireImpact("high_write"));
    expect(toWireImpact("unclassified")).toBe("unclassified");
    expect(WIRE_IMPACTS).toContain(toWireImpact("unclassified"));
    // Neither reaches the wire at all — no low-severity wire tier exists (a filed suspension is always
    // at least medium), so these fail loud at the boundary instead of fabricating a severity.
    expect(() => toWireImpact("low_write")).toThrow(/no wire representation/);
    expect(() => toWireImpact("read")).toThrow(/no wire representation/);
  });

  it("runWriteAgent's suspended path files the SAME wire-legal impact end to end (not just the pure function in isolation)", async () => {
    const d = deps([`{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("suspended");
    const filedArgs = d.calls.find((c) => c.name === "approvals.request")!.args;
    expect(REAL_PLATFORM_IMPACTS.has(filedArgs.impact as string)).toBe(true);
    if (res.status === "suspended") expect(REAL_PLATFORM_IMPACTS.has(res.filed?.impact ?? "")).toBe(true);
  });
});

// T2b — deferred filing (§7.2.5 DELTA, ASST-23 unblock design 2026-08-06). `fileOnSuspend:false` must
// suspend WITHOUT calling `approvals.request`, and every pre-existing (6-arg / omitted-opt / explicit
// `true`) call must stay byte-identical to today.
describe("T2b — runWriteAgent(opts.fileOnSuspend): deferred filing, invariant-preserving", () => {
  it("default (no 7th arg at all) still files immediately — byte-identical to the pre-T2b signature", async () => {
    const d = deps([`{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("suspended");
    if (res.status === "suspended") expect(res.filed).not.toBeNull();
    expect(d.calls.map((c) => c.name)).toContain("approvals.request");
  });

  it("opts:{} (present but empty) also files immediately — the default lives inside runWriteAgent, not at the call site", async () => {
    const d = deps([`{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini", {});
    expect(res.status).toBe("suspended");
    if (res.status === "suspended") expect(res.filed).not.toBeNull();
    expect(d.calls.map((c) => c.name)).toContain("approvals.request");
  });

  it("fileOnSuspend:true explicitly behaves identically to the default (files immediately)", async () => {
    const d = deps([`{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini", { fileOnSuspend: true });
    expect(res.status).toBe("suspended");
    if (res.status === "suspended") {
      expect(res.filed).not.toBeNull();
      expect(res.filed?.approvalId).toBe("ap-1");
    }
    expect(d.calls.map((c) => c.name)).toContain("approvals.request");
  });

  it("fileOnSuspend:false suspends WITHOUT filing — approvals.request is NEVER called, and no approval id exists", async () => {
    const d = deps([`{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini", { fileOnSuspend: false });
    expect(res.status).toBe("suspended");
    if (res.status === "suspended") {
      expect(res.filed).toBeNull();
      if (res.filed === null) {
        expect(res.intent).toEqual({ tool: "tasks.update", impact: "high", args: { taskId: "t1", status: "done" } });
      }
    }
    // The zero-filing assertion: the mock is armed to succeed (`approvals.request` would return an id
    // if called), yet it is never invoked — the intent capture path never reaches the hub at all.
    expect(d.calls).toHaveLength(0);
  });

  it("fileOnSuspend:false reuses toWireImpact — the intent's impact is the SAME mapping fileApproval would have sent, never the raw agent-side label", async () => {
    const d = deps([`{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini", { fileOnSuspend: false });
    expect(res.status).toBe("suspended");
    if (res.status === "suspended" && res.filed === null) {
      expect(res.intent.impact).toBe(toWireImpact("high_write"));
      expect(res.intent.impact).toBe("high");
      expect(res.intent.impact).not.toBe("high_write");
    }
  });

  it("fileOnSuspend:false still respects D13 — an un-evaled provider is forced read-only BEFORE the write gate is ever reached", async () => {
    const d = deps([`{"tool": "tasks.list", "args": {}}`, `{"final": "read-only summary"}`], { "tasks.list": "[]" });
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "claude", { fileOnSuspend: false }); // claude not evaled
    expect(res.status).toBe("forced_read_only");
    expect(d.calls.map((c) => c.name)).not.toContain("tasks.update");
    expect(d.calls.map((c) => c.name)).not.toContain("approvals.request");
  });

  it("fileOnSuspend has no effect on a `completed` (all-reads) run — the option is only consulted on the ApprovalRequiredError catch branch", async () => {
    const agent = { ...taskTriager, evaledProviders: ["echo"] };
    const d = deps(
      [`{"tool": "tasks.list", "args": {}}`, `{"final": "no overdue tasks"}`],
      { "tasks.list": "[]" },
    );
    const res = await runWriteAgent(agent, "triage", envelope, d, "co-1", "echo", { fileOnSuspend: false });
    expect(res.status).toBe("completed");
    expect(d.calls.map((c) => c.name)).not.toContain("approvals.request");
  });
});

// T2 (ASST-23) — the real `task-filer` def (not a synthetic fixture), end to end through
// `runWriteAgent`, on its actual enrolled provider ("openai" — see specialists.ts). Proves the T1 wire
// mapping and T2's def are wired together correctly for BOTH v1 write tools: a suspended `pm.createTask`
// / `pm.createDoc` files with the real tool name and the wire-legal `impact:"high"` (never the raw
// agent-side `"high_write"` label), and neither write tool is ever actually called.
describe("T2 — task-filer: runWriteAgent files pm.createTask/pm.createDoc as a wire-legal impact:'high' (scripted provider)", () => {
  it("pm.createTask suspends and files impact:'high' under origin='agent', agentName='task-filer'", async () => {
    const d = deps([`{"tool": "pm.createTask", "args": {"projectId": "p1", "title": "Fix login bug"}}`], {});
    const res = await runWriteAgent(taskFiler, "file a task", envelope, d, "co-1", "openai");
    expect(res.status).toBe("suspended");
    if (res.status === "suspended") expect(res.filed?.impact).toBe("high");
    const filed = d.calls.find((c) => c.name === "approvals.request")!.args;
    expect(filed).toMatchObject({
      origin: "agent",
      agentName: "task-filer",
      toolName: "pm.createTask",
      impact: "high",
      toolArgs: { projectId: "p1", title: "Fix login bug" },
    });
    expect(d.calls.map((c) => c.name)).not.toContain("pm.createTask");
  });

  it("pm.createDoc suspends and files impact:'high' likewise", async () => {
    const d = deps([`{"tool": "pm.createDoc", "args": {"projectId": "p1", "title": "Design spec"}}`], {});
    const res = await runWriteAgent(taskFiler, "file a doc", envelope, d, "co-1", "openai");
    expect(res.status).toBe("suspended");
    if (res.status === "suspended") expect(res.filed?.impact).toBe("high");
    const filed = d.calls.find((c) => c.name === "approvals.request")!.args;
    expect(filed).toMatchObject({ origin: "agent", agentName: "task-filer", toolName: "pm.createDoc", impact: "high" });
    expect(d.calls.map((c) => c.name)).not.toContain("pm.createDoc");
  });

  it("on the UN-enrolled provider, task-filer is forced read-only — neither write tool is even offered", async () => {
    const d = deps([`{"tool": "projects.list", "args": {}}`, `{"final": "no action taken"}`], { "projects.list": "[]" });
    const res = await runWriteAgent(taskFiler, "file a task", envelope, d, "co-1", "claude"); // not in evaledProviders
    expect(res.status).toBe("forced_read_only");
    expect(d.calls.map((c) => c.name)).not.toContain("pm.createTask");
    expect(d.calls.map((c) => c.name)).not.toContain("pm.createDoc");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D13 enforces against the provider that ACTUALLY SERVED, not the caller's declaration (2026-08-07)
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// THE LIVE MISCONFIGURATION THESE PIN. On gda-aicenter the runner declared
// `AGENT_SERVING_PROVIDER=openai` (a compose default) and `task-filer` is enrolled for `openai`, so the
// gate passed — while `openai` could not serve there AT ALL (no OPENAI_BASE_URL/API_KEY ⇒
// Available()=false, absent from LLM_CHAIN, and site topology strips gemini/claude anyway). The
// effective chain was `[hermes, central-forward, echo]`, so **Hermes** authored every agent write while
// this gate believed an eval-cleared provider had. D13's promise is "only an eval-cleared provider may
// author a write"; a control satisfiable by an env var alone is not that promise.
describe("D13 enforces the SERVED provider, not the declared one", () => {
  it("the live bug: declared an enrolled provider, Gateway served an un-enrolled one -> forced read-only", async () => {
    const d = depsServedBy("hermes", [`{"tool": "projects.list", "args": {}}`, `{"final": "no action"}`], { "projects.list": "[]" });
    const res = await runWriteAgent(taskFiler, "file a task", envelope, d, "co-1", "openai");
    expect(res.status).toBe("forced_read_only");
    if (res.status === "forced_read_only") {
      expect(res.reason).toContain('provider "hermes" is not eval-cleared');
      // The operator must be able to see WHICH WAY ROUND the configuration is lying.
      expect(res.reason).toContain('declared "openai"');
      expect(res.reason).toContain('served "hermes"');
    }
    expect(d.calls.map((c) => c.name)).not.toContain("pm.createTask");
    expect(d.calls.map((c) => c.name)).not.toContain("pm.createDoc");
  });

  // The other direction matters just as much: this is "use the truth", not merely "be stricter".
  // A pessimistic declaration must not disable writes that the actually-serving provider IS cleared for.
  it("the converse: declared un-enrolled, Gateway served an ENROLLED provider -> writes stay enabled", async () => {
    const d = depsServedBy("gemini", [`{"tool": "tasks.update", "args": {"id": "t1"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "update it", envelope, d, "co-1", "claude");
    // Reached the D14 gate (suspended) rather than being contained by D13 — i.e. the write tool WAS offered.
    expect(res.status).toBe("suspended");
  });

  it("cold start (79051ff) is preserved: nothing has served yet, so the declaration still seeds the gate", async () => {
    // No `lastProvider` at all — the pre-existing deps() — declaring an enrolled provider must still work.
    const d = deps([`{"tool": "tasks.update", "args": {"id": "t1"}}`], {});
    const res = await runWriteAgent(highWriteAgent, "update it", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("suspended");
    // ...and declaring an un-enrolled one must still contain it.
    const d2 = deps([`{"final": "nothing"}`], {});
    const res2 = await runWriteAgent(highWriteAgent, "update it", envelope, d2, "co-1", "claude");
    expect(res2.status).toBe("forced_read_only");
  });

  it("when declaration and reality agree, the reason carries no mismatch note", async () => {
    const d = depsServedBy("claude", [`{"final": "nothing"}`], {});
    const res = await runWriteAgent(highWriteAgent, "update it", envelope, d, "co-1", "claude");
    expect(res.status).toBe("forced_read_only");
    if (res.status === "forced_read_only") expect(res.reason).not.toContain("declared");
  });
});
