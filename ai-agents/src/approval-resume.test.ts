// D14-10 (agent side) — the runner consults a decided approval BEFORE throwing, so re-running a
// suspended goal from the top makes forward progress instead of filing a second approval.
//
// WHAT THESE TESTS PIN, and why each matters:
//  * With NO resolver, the `high_write` gate is byte-for-byte the pre-ticket behaviour. This is the
//    specified fallback, and the whole estate currently takes it (nothing wires the resolver yet), so
//    a regression here would be a live behaviour change disguised as a new feature.
//  * `match: "executed"` NEVER calls the tool from the runner. The platform executed it under the
//    single-use claim; a runner-side call would be a second execution with no claim behind it — the
//    exact double-execution hazard this ticket exists to prevent.
//  * `match: "rejected"` continues the run WITHOUT filing. Re-filing a call a human already refused is
//    the duplicate-approval generator wearing a different hat.
//  * `executing` / `failed` / `not_executable` throw a class that `write-agent.ts` deliberately does
//    NOT catch, so they cannot be laundered into a fresh filing either.
import { describe, it, expect } from "vitest";
import {
  runAgent,
  ApprovalRequiredError,
  ApprovalNotResumableError,
  type AgentDef,
  type AgentDeps,
  type ApprovalResolution,
} from "./agent";
import { runWriteAgent } from "./write-agent";
import { runOrchestrator, GoalSuspendedError, type OrchestratorDef } from "./orchestrator";

const envelope = { provider: "telegram", externalId: "tg:555" };

const writeArgs = { taskId: "t1", status: "done" };

const highWriteAgent: AgentDef = {
  name: "risky-agent",
  systemPrompt: "test",
  tools: { "tasks.list": "read", "tasks.update": "high_write" },
  maxSteps: 6,
  maxToolCalls: 4,
  evaledProviders: ["gemini"],
};

interface Harness extends AgentDeps {
  /** Every hub tool call the runner made, in order — the double-execution detector. */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Every resolveApproval consultation, so the BINDING (agent + tool + args) can be asserted. */
  consults: Array<{ agentName: string; toolName: string; toolArgs: Record<string, unknown> }>;
}

/**
 * Scripted deps. `resolutions` is consumed one per consultation (the last value repeats), so a run
 * that consults twice can be handed two different answers. Omit it entirely to get the no-resolver
 * fallback.
 */
function harness(model: string[], resolutions?: ApprovalResolution[]): Harness {
  let i = 0;
  const calls: Harness["calls"] = [];
  const consults: Harness["consults"] = [];
  const deps: Harness = {
    calls,
    consults,
    complete: async () => model[Math.min(i++, model.length - 1)],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === "approvals.request") return JSON.stringify({ id: "ap-new", status: "pending" });
      return "[]";
    },
  };
  if (resolutions) {
    deps.resolveApproval = async (input) => {
      consults.push(input);
      return resolutions[Math.min(consults.length - 1, resolutions.length - 1)];
    };
  }
  return deps;
}

const wantsWrite = `{"tool": "tasks.update", "args": {"taskId": "t1", "status": "done"}}`;

describe("D14-10 — approval-aware re-run (no resolver ⇒ unchanged behaviour)", () => {
  it("with NO resolveApproval, a high_write throws ApprovalRequiredError exactly as before", async () => {
    const d = harness([wantsWrite]); // no resolutions ⇒ no resolver on deps
    expect(d.resolveApproval).toBeUndefined();
    const err = await runAgent(highWriteAgent, "triage", envelope, d).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect((err as ApprovalRequiredError).args).toEqual(writeArgs);
    expect(d.calls).toHaveLength(0); // the write never executed
  });

  it("with NO resolveApproval, runWriteAgent still files exactly one approval (the pre-ticket path)", async () => {
    const d = harness([wantsWrite]);
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("suspended");
    expect(d.calls.map((c) => c.name)).toEqual(["approvals.request"]);
    expect(d.calls.map((c) => c.name)).not.toContain("tasks.update");
  });
});

describe("D14-10 — the runner consults before throwing", () => {
  it("consults with the EXACT binding the platform matches on: agentName + toolName + toolArgs", async () => {
    const d = harness([wantsWrite], [{ match: "none" }]);
    await runAgent(highWriteAgent, "triage", envelope, d).catch(() => {});
    expect(d.consults).toEqual([
      { agentName: "risky-agent", toolName: "tasks.update", toolArgs: writeArgs },
    ]);
    // `agentName` MUST be the def name: it is what `write-agent.ts` files as `workflowId`, and the
    // platform matches `workflow_id = agentName`. A mismatch here would silently never match.
    expect(d.consults[0].agentName).toBe(highWriteAgent.name);
  });

  it("`none` ⇒ today's behaviour EXACTLY: throw, then file one approval (D14 unchanged)", async () => {
    const d = harness([wantsWrite], [{ match: "none" }]);
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("suspended");
    // T2b: this call passes no `fileOnSuspend` opt, so `res.filed` is the non-null (filed) shape —
    // optional chaining only satisfies the type now that `"suspended"` has two shapes.
    if (res.status === "suspended") expect(res.filed?.approvalId).toBe("ap-new");
    expect(d.calls.map((c) => c.name)).toEqual(["approvals.request"]);
    expect(d.consults).toHaveLength(1);
  });

  // ── (1) forward progress ─────────────────────────────────────────────────────────────────────────

  it("(1) `executed` ⇒ the goal COMPLETES, the result reaches the transcript, and the tool is NEVER called by the runner", async () => {
    const d = harness(
      [wantsWrite, `{"final": "raised and closed t1"}`],
      [{ match: "executed", approvalId: "ap-1", consumed: false, result: "task t1 marked done", truncated: false }],
    );
    const run = await runAgent(highWriteAgent, "triage", envelope, d);
    expect(run.outcome).toBe("raised and closed t1");
    // THE assertion: the runner made zero tool calls. The platform executed the write.
    expect(d.calls).toHaveLength(0);
    expect(run.approvals).toEqual([{ tool: "tasks.update", approvalId: "ap-1", outcome: "executed" }]);
    // Step vocabulary is the SAME `<tool> ok` a directly-executed tool produces, because
    // runner/service.ts's traceFromRun parses that suffix to build `toolsCalled`.
    expect(run.steps.filter((s) => s.kind === "tool")).toEqual([{ kind: "tool", detail: "tasks.update ok" }]);
  });

  it("(1b) the model SEES the result — a resumed write feeds the next turn like any tool result", async () => {
    let secondPrompt = "";
    const d: AgentDeps = {
      complete: (() => {
        let n = 0;
        return async (prompt: string) => {
          if (n++ === 0) return wantsWrite;
          secondPrompt = prompt;
          return `{"final": "done"}`;
        };
      })(),
      callTool: async () => {
        throw new Error("the runner must not call any tool on the resumed path");
      },
      resolveApproval: async () => ({
        match: "executed",
        approvalId: "ap-1",
        consumed: false,
        result: "task t1 marked done",
        truncated: false,
      }),
    };
    const run = await runAgent(highWriteAgent, "triage", envelope, d);
    expect(run.outcome).toBe("done");
    expect(secondPrompt).toContain("task t1 marked done");
    expect(secondPrompt).toContain("executed under human approval ap-1");
  });

  it("`resumed` surfaces on WriteAgentResult so a caller can tell a human-approved write happened", async () => {
    const d = harness(
      [wantsWrite, `{"final": "ok"}`],
      [{ match: "executed", approvalId: "ap-1", consumed: false, result: "done", truncated: false }],
    );
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("completed");
    if (res.status === "completed") {
      expect(res.resumed).toEqual([{ tool: "tasks.update", approvalId: "ap-1", outcome: "executed" }]);
      expect(res.run.outcome).toBe("ok");
    }
    expect(d.calls).toHaveLength(0); // and nothing was filed either
  });

  // ── (2) the consumed path ────────────────────────────────────────────────────────────────────────

  it("(2) `consumed: true` ⇒ the stored result is reused, recorded as `consumed`, and the tool is not re-called", async () => {
    const d = harness(
      [wantsWrite, `{"final": "already done"}`],
      [{ match: "executed", approvalId: "ap-1", consumed: true, result: "task t1 marked done", truncated: false }],
    );
    const run = await runAgent(highWriteAgent, "triage", envelope, d);
    expect(run.outcome).toBe("already done");
    expect(d.calls).toHaveLength(0);
    expect(run.approvals).toEqual([{ tool: "tasks.update", approvalId: "ap-1", outcome: "consumed" }]);
    expect(d.consults).toHaveLength(1);
    // (the transcript wording — "the tool was NOT called again" — is asserted in 2b below, where the
    // prompt handed to the next model turn is captured)
  });

  it("(2b) the consumed transcript line states the tool was NOT called again", async () => {
    let secondPrompt = "";
    const d: AgentDeps = {
      complete: (() => {
        let n = 0;
        return async (prompt: string) => {
          if (n++ === 0) return wantsWrite;
          secondPrompt = prompt;
          return `{"final": "done"}`;
        };
      })(),
      callTool: async () => "[]",
      resolveApproval: async () => ({
        match: "executed",
        approvalId: "ap-1",
        consumed: true,
        result: "task t1 marked done",
        truncated: true,
      }),
    };
    await runAgent(highWriteAgent, "triage", envelope, d);
    expect(secondPrompt).toContain("the tool was NOT called again");
    expect(secondPrompt).toContain("[result truncated]");
  });

  // ── (5) rejected ─────────────────────────────────────────────────────────────────────────────────

  it("(5) `rejected` ⇒ a typed refusal in the transcript, the run continues, and NOTHING is re-filed", async () => {
    let secondPrompt = "";
    const calls: string[] = [];
    const d: AgentDeps = {
      complete: (() => {
        let n = 0;
        return async (prompt: string) => {
          if (n++ === 0) return wantsWrite;
          secondPrompt = prompt;
          return `{"final": "a human declined that change; nothing was modified"}`;
        };
      })(),
      callTool: async (name) => {
        calls.push(name);
        return "[]";
      },
      resolveApproval: async () => ({ match: "rejected", approvalId: "ap-r", reason: "not this sprint" }),
    };
    const res = await runWriteAgent(highWriteAgent, "triage", envelope, d, "co-1", "gemini");
    expect(res.status).toBe("completed");
    if (res.status === "completed") {
      expect(res.resumed).toEqual([{ tool: "tasks.update", approvalId: "ap-r", outcome: "rejected" }]);
    }
    // No second approval for a call a human already refused, and the write itself never ran.
    expect(calls).not.toContain("approvals.request");
    expect(calls).not.toContain("tasks.update");
    expect(secondPrompt).toContain("REFUSED");
    expect(secondPrompt).toContain("a human REJECTED this exact call (approval ap-r)");
    expect(secondPrompt).toContain("Do NOT request it again");
    // The row's `reason` is the SUSPENSION reason it was filed with, not the human's grounds for
    // refusing — telling the model "requires human approval" is WHY it was refused would be actively
    // misleading, so it is deliberately not in the refusal sentence.
    expect(secondPrompt).not.toContain("not this sprint");
  });

  it("(5b) a model that keeps retrying a rejected call still never files — it exhausts its budget instead", async () => {
    const d = harness([wantsWrite], [{ match: "rejected", approvalId: "ap-r", reason: "no" }]);
    // The model loops on the same refused call. The run must terminate (typed budget error) without
    // ever filing or executing anything.
    await expect(runAgent(highWriteAgent, "triage", envelope, d)).rejects.toThrow(/budget exhausted/);
    expect(d.calls).toHaveLength(0);
    expect(d.consults.length).toBeGreaterThan(1); // it did re-consult, which is cheap and side-effect-free
  });

  // ── approved-but-stuck: loud, typed, and never re-filed ──────────────────────────────────────────

  it.each([
    ["executing", { match: "executing", approvalId: "ap-x" } as ApprovalResolution, "executing"],
    ["failed", { match: "failed", approvalId: "ap-x", error: "hub_denied: denied by policy" } as ApprovalResolution, "failed"],
    [
      "not_executable",
      { match: "not_executable", approvalId: "ap-x", reason: "no_executable_registry_entry" } as ApprovalResolution,
      "not_executable",
    ],
  ])("`%s` ⇒ ApprovalNotResumableError, propagated through runWriteAgent WITHOUT filing", async (_label, resolution, state) => {
    const d = harness([wantsWrite], [resolution]);
    const err = await runAgent(highWriteAgent, "triage", envelope, d).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalNotResumableError);
    expect((err as ApprovalNotResumableError).state).toBe(state);
    expect((err as ApprovalNotResumableError).approvalId).toBe("ap-x");
    expect(d.calls).toHaveLength(0);

    // It must NOT be caught by runWriteAgent's ApprovalRequiredError branch — there is already a row
    // for this call and a human, not the agent, unsticks it (D14-07 retry).
    const d2 = harness([wantsWrite], [resolution]);
    await expect(runWriteAgent(highWriteAgent, "triage", envelope, d2, "co-1", "gemini")).rejects.toBeInstanceOf(
      ApprovalNotResumableError,
    );
    expect(d2.calls.map((c) => c.name)).not.toContain("approvals.request");
  });

  it("a `failed` resolution carries the platform's typed reason into the error message", async () => {
    const d = harness([wantsWrite], [{ match: "failed", approvalId: "ap-x", error: "precondition_failed: run_blocked" }]);
    const err = (await runAgent(highWriteAgent, "triage", envelope, d).catch((e) => e)) as ApprovalNotResumableError;
    expect(err.message).toContain("precondition_failed: run_blocked");
    expect(err.message).toContain("nothing re-filed");
  });

  // ── the resolver must reach the runner through every wrapper ─────────────────────────────────────

  it("the resolver survives the orchestrator's budget wrapper (an unforwarded optional dep is silently DROPPED)", async () => {
    // budgetedDeps() REPLACES the caller's deps for the whole subtree. If it stops forwarding
    // resolveApproval, every sub-run silently reverts to throw-and-file — and no other test would fail.
    const writer: AgentDef = {
      name: "writer",
      systemPrompt: "Writes tasks.",
      tools: { "tasks.update": "high_write" },
      maxSteps: 3,
      maxToolCalls: 2,
      evaledProviders: ["gemini"],
    };
    const def: OrchestratorDef = {
      name: "supervisor",
      systemPrompt: "You are the Gaiada work supervisor.",
      specialists: { writer },
      maxPlannerSteps: 6,
      maxSubRuns: 3,
      goalBudget: { modelCalls: 20, toolCalls: 10 },
    };
    let plannerTurn = 0;
    const calls: string[] = [];
    let consulted = 0;
    const deps: AgentDeps = {
      complete: async (prompt) => {
        if (prompt.includes("You coordinate specialist agents")) {
          plannerTurn++;
          return plannerTurn === 1
            ? `{"assign": {"specialist": "writer", "task": "close t1"}}`
            : `{"final": "t1 closed under the existing approval"}`;
        }
        return prompt.includes("TOOL tasks.update") ? `{"final": "closed t1"}` : wantsWrite;
      },
      callTool: async (name) => {
        calls.push(name);
        return name === "approvals.request" ? JSON.stringify({ id: "ap-new" }) : "ok";
      },
      lastProvider: () => "gemini",
      resolveApproval: async () => {
        consulted++;
        return { match: "executed", approvalId: "ap-1", consumed: true, result: "task t1 marked done", truncated: false };
      },
    };
    const run = await runOrchestrator(def, "close t1", envelope, deps, { tenantId: "co-1", servingProvider: "gemini" });
    expect(consulted).toBe(1); // the resolver was reached THROUGH budgetedDeps
    expect(run.outcome).toContain("t1 closed");
    expect(calls).not.toContain("tasks.update"); // the runner never executed it
    expect(calls).not.toContain("approvals.request"); // and nothing was re-filed
  });

  it("without a resolution the orchestrator still suspends the whole goal (GoalSuspendedError, unchanged)", async () => {
    const writer: AgentDef = {
      name: "writer",
      systemPrompt: "Writes tasks.",
      tools: { "tasks.update": "high_write" },
      maxSteps: 3,
      maxToolCalls: 2,
      evaledProviders: ["gemini"],
    };
    const def: OrchestratorDef = {
      name: "supervisor",
      systemPrompt: "You are the Gaiada work supervisor.",
      specialists: { writer },
      maxPlannerSteps: 6,
      maxSubRuns: 3,
      goalBudget: { modelCalls: 20, toolCalls: 10 },
    };
    const calls: string[] = [];
    const deps: AgentDeps = {
      complete: async (prompt) =>
        prompt.includes("You coordinate specialist agents") ? `{"assign": {"specialist": "writer", "task": "close t1"}}` : wantsWrite,
      callTool: async (name) => {
        calls.push(name);
        return name === "approvals.request" ? JSON.stringify({ id: "ap-new" }) : "ok";
      },
      lastProvider: () => "gemini",
      resolveApproval: async () => ({ match: "none" }),
    };
    await expect(
      runOrchestrator(def, "close t1", envelope, deps, { tenantId: "co-1", servingProvider: "gemini" }),
    ).rejects.toThrow(GoalSuspendedError);
    expect(calls).toEqual(["approvals.request"]);
  });
});
