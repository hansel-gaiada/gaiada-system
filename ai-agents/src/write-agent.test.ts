// WS8 Step B — the write-capable specialist path: D13 provider gate + D14 approval filing, proven
// deterministically with mock deps (no live Gateway/hub).
import { describe, it, expect } from "vitest";
import { runWriteAgent, isWriteCapable, readOnlyProjection, fileApproval, toWireImpact, WIRE_IMPACTS } from "./write-agent";
import { taskTriager } from "./specialists";
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
