// P4-J5 — behavioral tests for the two PM specialists wired into the WS8 supervisor/specialist
// framework (specialists.ts's `pm-reporter` / `pm-task-manager`). The shape/idempotency/impact
// invariants already have their own dedicated guards (agent-write-guard.test.ts,
// impact-reconciliation.test.ts); this file proves the two things the P4-J5 ticket calls out by name:
//  - an agent can actually READ PM work through the existing framework (pm-reporter, unattended)
//  - an agent can actually ACT on PM work when RBAC/eval allow it, and is contained (read-only) when
//    it doesn't — reusing runWriteAgent's D13 gate, not a new mechanism
//  - a chain-blocked status change (P4-I1's 409, naming the blocker) reaches the model as DATA, not a
//    crash — the same "render the reason, don't swallow it" requirement the bot skill (P4-J4) has, now
//    proven on the agent side
import { describe, it, expect } from "vitest";
import { runAgent, type AgentDeps } from "./agent";
import { runWriteAgent, isWriteCapable, readOnlyProjection } from "./write-agent";
import { pmReporter, pmTaskManager, specialists, writeSpecialists } from "./specialists";

const envelope = { provider: "telegram", externalId: "tg:1" };

function scripted(responses: string[], onTool?: (name: string, args: Record<string, unknown>) => string): AgentDeps {
  let i = 0;
  return {
    complete: async () => responses[Math.min(i++, responses.length - 1)],
    callTool: async (name, args) => (onTool ? onTool(name, args) : "[]"),
  };
}

describe("pm-reporter (read-only PM specialist)", () => {
  it("is registered in the read-only `specialists` map — reachable via the plain supervisor, no D13/D14 gating needed", () => {
    expect(specialists[pmReporter.name]).toBe(pmReporter);
    expect(isWriteCapable(pmReporter)).toBe(false);
  });

  it("declares exactly the four P4-J1 read tools, all real hub tools (not the retired tasks.list/tasks.get aliases)", () => {
    expect(pmReporter.tools).toEqual({
      "pm.listTasks": "read",
      "pm.getTask": "read",
      "pm.listProjects": "read",
      "pm.taskAssignmentHistory": "read",
    });
  });

  it("answers a PM question by calling its own tenant-wide facet tools, forwarding the caller's envelope unchanged", async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const deps = scripted(
      [`{"tool": "pm.listTasks", "args": {"tenantId": "co-1", "mine": true, "overdueOnly": true}}`, `{"final": "1 overdue task: Ship banner"}`],
      (name, args) => {
        toolCalls.push({ name, args });
        return JSON.stringify({ items: [{ id: "t1", title: "Ship banner", status: "backlog" }] });
      },
    );
    const run = await runAgent(pmReporter, "what's overdue for me", envelope, deps);
    expect(run.outcome).toContain("Ship banner");
    expect(toolCalls).toEqual([{ name: "pm.listTasks", args: { tenantId: "co-1", mine: true, overdueOnly: true } }]);
  });
});

describe("pm-task-manager (write-capable PM specialist)", () => {
  it("is registered in `writeSpecialists` (standalone, D13/D14-gated), NOT in the plain read-only `specialists` map", () => {
    expect(writeSpecialists[pmTaskManager.name]).toBe(pmTaskManager);
    expect(specialists[pmTaskManager.name]).toBeUndefined();
    expect(isWriteCapable(pmTaskManager)).toBe(true);
  });

  it("declares only the THREE writes with a proven re-run idempotency case — pm.comment is deliberately absent (see agent-write-guard.test.ts / specialists.ts headers)", () => {
    expect(pmTaskManager.tools).toEqual({
      "pm.listTasks": "read",
      "pm.getTask": "read",
      "pm.listProjects": "read",
      "pm.taskAssignmentHistory": "read",
      "pm.setStatus": "low_write",
      "pm.passBall": "low_write",
      "pm.setDueDate": "low_write",
    });
    expect(pmTaskManager.tools["pm.comment"]).toBeUndefined();
  });

  it("ships with evaledProviders EMPTY — the safe default; an un-evaled provider is forced read-only via runWriteAgent's D13 gate, same mechanism as task-triager/task-filer, no new machinery", async () => {
    expect(pmTaskManager.evaledProviders ?? []).toEqual([]);
    const toolCalls: string[] = [];
    const deps: AgentDeps = {
      complete: async () => `{"final": "no writes attempted — read-only"}`,
      callTool: async (name) => {
        toolCalls.push(name);
        return "should never be reached for a write";
      },
      lastProvider: () => "some-un-evaled-provider",
    };
    const res = await runWriteAgent(pmTaskManager, "move t1 to doing", envelope, deps, "co-1", "some-un-evaled-provider");
    expect(res.status).toBe("forced_read_only");
    if (res.status === "forced_read_only") {
      expect(res.reason).toContain("not eval-cleared");
    }
    // readOnlyProjection strips every non-"read" tool — proving the runtime containment matches the
    // declared allow-list, not just the label.
    expect(Object.values(readOnlyProjection(pmTaskManager).tools)).toEqual(["read", "read", "read", "read"]);
  });

  it("low_write tools run DIRECTLY once a provider is enrolled — no suspension, matching decision 16 (agents write unattended for a low-impact tool)", async () => {
    const toolCalls: string[] = [];
    const evaledDef = { ...pmTaskManager, evaledProviders: ["test-provider"] };
    const deps: AgentDeps = {
      complete: async (prompt) =>
        prompt.includes("TOOL pm.setStatus") ? `{"final": "moved to doing"}` : `{"tool": "pm.setStatus", "args": {"tenantId": "co-1", "taskId": "t1", "status": "doing"}}`,
      callTool: async (name, args) => {
        toolCalls.push(name);
        expect(args).toEqual({ tenantId: "co-1", taskId: "t1", status: "doing" });
        return JSON.stringify({ id: "t1", status: "doing" });
      },
      lastProvider: () => "test-provider",
    };
    const res = await runWriteAgent(evaledDef, "move t1 to doing", envelope, deps, "co-1", "test-provider");
    expect(res.status).toBe("completed");
    expect(toolCalls).toEqual(["pm.setStatus"]); // ran directly, no approvals.request filed anywhere
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // THE ACCEPTANCE CRITERION THIS TICKET NAMES: a chain-blocked status change surfaces its blocker's
  // name to the agent, not a generic failure — mirroring the bot skill's (P4-J4) denial rendering, on
  // the agent side. `deps.callTool` throwing is exactly what `ai-agents/src/deps.ts`'s real `callTool`
  // does on a non-2xx (the platform's P4-I1 409 has an `{error}` body naming the blocker verbatim,
  // and mcp-hub's tool handler forwards it via `throw new Error(text)` — see pm-tools.ts's own header).
  // `agent.ts`'s low_write path (`runAgent`'s final `try`/`catch` around `deps.callTool`) turns that
  // throw into a transcript line the model reads on ITS NEXT turn, never a crashed run.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  it("a chain-blocked pm.setStatus 409 lands in the transcript as data — the agent reports the named blocker instead of the run dying or retrying blindly", async () => {
    const toolCalls: string[] = [];
    const evaledDef = { ...pmTaskManager, evaledProviders: ["test-provider"] };
    const deps: AgentDeps = {
      complete: async (prompt) => {
        if (prompt.includes("FAILED")) {
          // The model sees the failure text on its NEXT turn and reports it, rather than retrying
          // the identical move (which would fail identically forever).
          expect(prompt).toContain('blocked by 1 open dependency (Design mockup)');
          return `{"final": "Can't move t1 to doing — blocked by Design mockup."}`;
        }
        return `{"tool": "pm.setStatus", "args": {"tenantId": "co-1", "taskId": "t1", "status": "doing"}}`;
      },
      callTool: async (name) => {
        toolCalls.push(name);
        throw new Error('cannot move to "doing": blocked by 1 open dependency (Design mockup)');
      },
      lastProvider: () => "test-provider",
    };
    const res = await runWriteAgent(evaledDef, "move t1 to doing", envelope, deps, "co-1", "test-provider");
    expect(res.status).toBe("completed");
    if (res.status === "completed") {
      expect(res.run.outcome).toContain("Design mockup");
      // The run did NOT crash and did NOT silently swallow the failure into a vague message.
      expect(res.run.outcome.toLowerCase()).not.toContain("something went wrong");
    }
    // The tool WAS called exactly once — this proves the failure is real (came back from a genuine
    // attempt), not a refusal that never reached deps.callTool at all.
    expect(toolCalls).toEqual(["pm.setStatus"]);
  });
});
