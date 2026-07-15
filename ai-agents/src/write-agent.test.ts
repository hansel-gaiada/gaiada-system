// WS8 Step B — the write-capable specialist path: D13 provider gate + D14 approval filing, proven
// deterministically with mock deps (no live Gateway/hub).
import { describe, it, expect } from "vitest";
import { runWriteAgent, isWriteCapable, readOnlyProjection } from "./write-agent";
import { taskTriager } from "./specialists";
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
    if (res.status === "suspended") expect(res.filed.approvalId).toBe("ap-1");
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
