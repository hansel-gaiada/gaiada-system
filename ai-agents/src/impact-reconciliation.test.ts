// D14-12 — reconcile an AgentDef's hand-maintained impact label against the hub registry's own
// classification for the same tool (stricter wins, in both directions).
//
// WHAT THESE TESTS PIN, and why each matters:
//  * `effectiveImpact()` is the whole mechanism — a pure, exported function, tested directly against
//    the four DONE-WHEN scenarios from the ticket before ever touching `runAgent`.
//  * The "no-regression anchor": today's three real specialists (status-reporter, approvals-chaser,
//    task-triager), reconciled against their REAL hub registry entries (hardcoded here from
//    `mcp-hub/src/platform-tools.ts` / `platform-write-tools.ts` / `platform-nest/src/modules/agency/
//    index.ts`, verified at ticket time), must come out byte-identical to their declared labels. If
//    this ever fails, either specialists.ts changed a tool's declared impact, or the hub registry
//    changed a tool's classification underneath it — either way it means "diagnose the drift", not
//    "the test is wrong".
//  * An end-to-end `runAgent` test proves the reconciled impact actually reaches the write gate (not
//    just the pure function in isolation) — a `low_write` tool promoted to `high_write` by the
//    registry throws `ApprovalRequiredError` exactly like a declared `high_write` would.
//  * The forwarding test guards the same class of hazard D14-10 already found twice: an object that
//    REPLACES `AgentDeps` for a subtree (orchestrator's `budgetedDeps`) silently drops any optional
//    field it forgets to list.
import { describe, it, expect } from "vitest";
import {
  runAgent,
  ApprovalRequiredError,
  effectiveImpact,
  type AgentDef,
  type AgentDeps,
  type Envelope,
  type RegistryToolImpact,
} from "./agent";
import { runOrchestrator, GoalSuspendedError, type OrchestratorDef } from "./orchestrator";
import { statusReporter, approvalsChaser, taskTriager, specialists, writeSpecialists } from "./specialists";

const envelope: Envelope = { provider: "telegram", externalId: "tg:1" };

describe("D14-12 — effectiveImpact() (pure mapping)", () => {
  it("AgentDef low_write + registry impact:'high' ⇒ high_write (the promotion case)", () => {
    expect(effectiveImpact("low_write", { write: true, impact: "high" })).toBe("high_write");
  });

  it("registry impact:'low' + AgentDef high_write ⇒ stays high_write (AgentDef stricter, unchanged)", () => {
    expect(effectiveImpact("high_write", { write: true, impact: "low" })).toBe("high_write");
  });

  it("unregistered tool (registry info undefined) ⇒ the AgentDef label is used, for every level", () => {
    expect(effectiveImpact("read", undefined)).toBe("read");
    expect(effectiveImpact("low_write", undefined)).toBe("low_write");
    expect(effectiveImpact("high_write", undefined)).toBe("high_write");
  });

  it("registry impact:undefined (unclassified write) ⇒ at least as strict as the AgentDef label, never weaker", () => {
    const unclassified: RegistryToolImpact = { write: true, impact: undefined };
    // Never weaker, for every declared level:
    expect(effectiveImpact("read", unclassified)).toBe("high_write");
    expect(effectiveImpact("low_write", unclassified)).toBe("high_write");
    expect(effectiveImpact("high_write", unclassified)).toBe("high_write");
  });

  it("registry impact:'medium' behaves exactly like 'high' (the hub gate does not distinguish them either)", () => {
    expect(effectiveImpact("low_write", { write: true, impact: "medium" })).toBe("high_write");
  });

  it("registry write:false ⇒ the AgentDef label is used (registry explicitly has no write opinion)", () => {
    expect(effectiveImpact("high_write", { write: false })).toBe("high_write");
    expect(effectiveImpact("low_write", { write: false })).toBe("low_write");
  });

  it("registry impact:'low' + AgentDef low_write ⇒ unchanged (agreement, not drift)", () => {
    expect(effectiveImpact("low_write", { write: true, impact: "low" })).toBe("low_write");
  });
});

describe("D14-12 — no-regression anchor: today's three specialists, reconciled against their REAL hub entries", () => {
  // Hardcoded from the hub registry at ticket time — do NOT import mcp-hub from ai-agents (separate
  // standalone projects, per CLAUDE.md); re-verify against the source files named above if this ever
  // needs updating.
  const realRegistry: Record<string, RegistryToolImpact | undefined> = {
    "projects.list": undefined, // mcp-hub/src/platform-tools.ts — no `write` field at all (a read tool)
    "tasks.list": undefined, // same file — no `write` field
    "agency.pendingApprovals": undefined, // platform-nest/src/modules/agency/index.ts — no `write` field
    "tasks.update": { write: true, impact: "low" }, // mcp-hub/src/platform-write-tools.ts:236-240
  };

  const getRegistryImpact = (name: string): RegistryToolImpact | undefined => realRegistry[name];

  it.each([
    ["status-reporter", statusReporter],
    ["approvals-chaser", approvalsChaser],
    ["task-triager", taskTriager],
  ])("%s: every declared tool's effective impact equals its declared impact (identical before/after)", (_name, def: AgentDef) => {
    for (const [tool, declared] of Object.entries(def.tools)) {
      expect(effectiveImpact(declared, getRegistryImpact(tool)), `${def.name}.${tool}`).toBe(declared);
    }
  });

  it("falsifiability anchor: the real registry entry for tasks.update is impact:'low' — reconciliation must NOT promote it to high", () => {
    // This is the ticket's explicit stop-and-say-so check. If mcp-hub ever reclassifies tasks.update,
    // this fails LOUDLY here instead of silently suspending every task-triager write.
    expect(realRegistry["tasks.update"]).toEqual({ write: true, impact: "low" });
    expect(effectiveImpact("low_write", realRegistry["tasks.update"])).toBe("low_write");
  });

  it("collects every AgentDef reachable from specialists.ts (both read-only and write-capable maps)", () => {
    const all = { ...specialists, ...writeSpecialists };
    expect(Object.keys(all).sort()).toEqual(["approvals-chaser", "status-reporter", "task-triager"]);
  });
});

describe("D14-12 — end to end through runAgent: the reconciled impact actually reaches the write gate", () => {
  const declaredLowAgent: AgentDef = {
    name: "reconcile-promote",
    systemPrompt: "test",
    tools: { "risky.write": "low_write" },
    maxSteps: 4,
    maxToolCalls: 4,
  };

  function scriptedDeps(model: string[], getRegistryImpact?: AgentDeps["getRegistryImpact"]): AgentDeps & { calls: string[] } {
    const calls: string[] = [];
    let i = 0;
    return {
      calls,
      complete: async () => model[Math.min(i++, model.length - 1)],
      callTool: async (name) => {
        calls.push(name);
        return "ok";
      },
      getRegistryImpact,
    };
  }

  it("AgentDef low_write + registry impact:'high' ⇒ suspends exactly like a declared high_write (ApprovalRequiredError, tool never called)", async () => {
    const d = scriptedDeps(
      [`{"tool":"risky.write","args":{"x":1}}`],
      (name) => (name === "risky.write" ? { write: true, impact: "high" } : undefined),
    );
    const err = await runAgent(declaredLowAgent, "do it", envelope, d).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect((err as ApprovalRequiredError).impact).toBe("high_write");
    expect(d.calls).toHaveLength(0); // the write NEVER ran unattended
  });

  it("without getRegistryImpact wired at all, the SAME AgentDef's low_write proceeds exactly as before (no regression when the dep is absent)", async () => {
    const d = scriptedDeps([`{"tool":"risky.write","args":{"x":1}}`, `{"final":"done"}`]);
    expect(d.getRegistryImpact).toBeUndefined();
    const run = await runAgent(declaredLowAgent, "do it", envelope, d);
    expect(run.outcome).toBe("done");
    expect(d.calls).toEqual(["risky.write"]); // ran directly — low_write, unattended, as designed
  });

  it("registry impact:'low' + AgentDef high_write ⇒ stays suspended (registry cannot loosen a stricter AgentDef label)", async () => {
    const declaredHighAgent: AgentDef = {
      name: "reconcile-keep-strict",
      systemPrompt: "test",
      tools: { "risky.write": "high_write" },
      maxSteps: 4,
      maxToolCalls: 4,
      evaledProviders: ["echo"],
    };
    const d = scriptedDeps(
      [`{"tool":"risky.write","args":{"x":1}}`],
      (name) => (name === "risky.write" ? { write: true, impact: "low" } : undefined),
    );
    const err = await runAgent(declaredHighAgent, "do it", envelope, d).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect((err as ApprovalRequiredError).impact).toBe("high_write");
    expect(d.calls).toHaveLength(0);
  });

  it("unregistered tool (getRegistryImpact returns undefined for it) ⇒ the AgentDef's own low_write label wins, tool runs directly", async () => {
    const d = scriptedDeps(
      [`{"tool":"risky.write","args":{"x":1}}`, `{"final":"done"}`],
      () => undefined, // wired, but has no opinion on this tool
    );
    const run = await runAgent(declaredLowAgent, "do it", envelope, d);
    expect(run.outcome).toBe("done");
    expect(d.calls).toEqual(["risky.write"]);
  });
});

describe("D14-12 — the registry-impact reader survives the orchestrator's budget wrapper", () => {
  it("a sub-run's low_write promoted to high_write by the registry still suspends the WHOLE goal (budgetedDeps forwards getRegistryImpact)", async () => {
    const writer: AgentDef = {
      name: "writer",
      systemPrompt: "Writes things.",
      tools: { "risky.write": "low_write" }, // declared LOW — only the registry makes this dangerous
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
        prompt.includes("You coordinate specialist agents")
          ? `{"assign": {"specialist": "writer", "task": "do it"}}`
          : `{"tool":"risky.write","args":{"x":1}}`,
      callTool: async (name) => {
        calls.push(name);
        return name === "approvals.request" ? JSON.stringify({ id: "ap-new" }) : "ok";
      },
      lastProvider: () => "gemini",
      getRegistryImpact: (name) => (name === "risky.write" ? { write: true, impact: "high" } : undefined),
    };
    await expect(
      runOrchestrator(def, "do it", envelope, deps, { tenantId: "co-1", servingProvider: "gemini" }),
    ).rejects.toThrow(GoalSuspendedError);
    // Proof the registry opinion was actually consulted THROUGH budgetedDeps: the write never ran, and
    // an approval WAS filed (which only happens on the high_write path).
    expect(calls).toEqual(["approvals.request"]);
    expect(calls).not.toContain("risky.write");
  });

  it("if budgetedDeps ever stops forwarding getRegistryImpact, this test fails: the same low_write sub-run runs the tool unattended instead of suspending", async () => {
    // This test is deliberately the mirror image of the one above with the registry opinion OMITTED,
    // to pin the baseline it's regressed against: no registry opinion ⇒ the declared low_write runs.
    const writer: AgentDef = {
      name: "writer",
      systemPrompt: "Writes things.",
      tools: { "risky.write": "low_write" },
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
    let turn = 0;
    const deps: AgentDeps = {
      complete: async (prompt) => {
        if (prompt.includes("You coordinate specialist agents")) {
          turn++;
          return turn === 1
            ? `{"assign": {"specialist": "writer", "task": "do it"}}`
            : `{"final": "done"}`;
        }
        return prompt.includes("TOOL risky.write") ? `{"final": "wrote it"}` : `{"tool":"risky.write","args":{"x":1}}`;
      },
      callTool: async (name) => {
        calls.push(name);
        return "ok";
      },
      lastProvider: () => "gemini",
      // no getRegistryImpact — the un-reconciled baseline
    };
    const run = await runOrchestrator(def, "do it", envelope, deps, { tenantId: "co-1", servingProvider: "gemini" });
    expect(run.outcome).toContain("done");
    expect(calls).toEqual(["risky.write"]);
  });
});
