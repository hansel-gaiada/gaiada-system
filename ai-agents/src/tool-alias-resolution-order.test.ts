// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE SECURITY CONDITION FROM THE 2026-08-07 TOOL-ALIAS-MAP TICKET, PINNED AS A REGRESSION TEST
// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Alias resolution (`tool-aliases.ts`'s `resolveToolAlias`) MUST run before every authorization
// decision in `runAgent` sees the tool name — the allow-list lookup (`def.tools[tool]`) AND the D14-12
// registry-impact reconciliation (`effectiveImpact` / `deps.getRegistryImpact`). Resolving AFTER either
// would be a bypass: an alias could carry a call past a check made against a different name (an
// allow-list that only lists the canonical name, or a registry impact lookup keyed by the canonical
// name while the raw alias carries no opinion at all).
//
// Both tests below are constructed so that if a future edit moves `resolveToolAlias` to AFTER the gate
// it targets, the test goes RED — not because of some meta-assertion about code order, but because the
// actual authorization OUTCOME changes: a call that must be denied/suspended instead runs, or a call
// that must succeed instead dies in the off-list refusal loop. That is deliberate: a test that inspects
// source order would pass while the interpreter still executes in the vulnerable order after a refactor
// (e.g. an intermediate helper reordering things); a test that inspects the OUTCOME cannot be fooled
// that way.
import { describe, it, expect } from "vitest";
import { runAgent, ApprovalRequiredError, type AgentDef, type AgentDeps } from "./agent";

const envelope = { provider: "telegram", externalId: "tg:1" };

describe("tool-alias resolution order — SECURITY (must run before authorization, never after)", () => {
  it("resolves BEFORE the allow-list gate: the model names the alias, only the canonical name is allow-listed, and the canonical tool actually runs — the raw guess never reaches deps.callTool nor the off-list refusal loop", async () => {
    const def: AgentDef = {
      name: "alias-order-allowlist",
      systemPrompt: "test",
      tools: { "tasks.list": "read" }, // ONLY the canonical name is declared — NOT the alias
      maxSteps: 4,
      maxToolCalls: 4,
    };
    const calls: string[] = [];
    let modelTurn = 0;
    const deps: AgentDeps = {
      complete: async () =>
        modelTurn++ === 0 ? `{"tool": "pm.listTasks", "args": {}}` : `{"final": "1 open task"}`,
      callTool: async (name) => {
        calls.push(name);
        return JSON.stringify([{ id: "t1" }]);
      },
    };
    const run = await runAgent(def, "list my open tasks", envelope, deps);
    expect(run.outcome).toBe("1 open task");
    // If resolution ever moved to AFTER this allow-list lookup, `def.tools["pm.listTasks"]` would be
    // undefined, the off-list branch would fire, and `calls` would stay empty (the second scripted
    // model turn — "final" — would still fire, but having done NO real work: exactly the silent-bypass
    // shape this test exists to catch in the other direction).
    expect(calls).toEqual(["tasks.list"]);
  });

  it("resolves BEFORE the D14-12 impact-reconciliation gate: a registry opinion keyed ONLY by the canonical name still escalates the call to high_write and suspends it, even though the model named the alias — the raw alias name carries NO registry opinion of its own, on purpose", async () => {
    const def: AgentDef = {
      name: "alias-order-impact-gate",
      systemPrompt: "test",
      tools: { "tasks.list": "read" }, // declared READ — only the registry opinion escalates this
      maxSteps: 4,
      maxToolCalls: 4,
    };
    const calls: string[] = [];
    const deps: AgentDeps = {
      complete: async () => `{"tool": "pm.listTasks", "args": {}}`, // the ALIAS — never the canonical name
      callTool: async (name) => {
        calls.push(name);
        return "must never run";
      },
      // Keyed ONLY by the canonical name. A resolve-after-authorization bug means runAgent still holds
      // the raw "pm.listTasks" at this call site, this returns undefined, effectiveImpact stays "read",
      // and the escalation below never fires — the exact bypass this test exists to catch.
      getRegistryImpact: (name) => (name === "tasks.list" ? { write: true, impact: "high" } : undefined),
    };
    const err = await runAgent(def, "list my open tasks", envelope, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalRequiredError);
    expect((err as ApprovalRequiredError).tool).toBe("tasks.list"); // the CANONICAL name, never the alias
    expect(calls).toHaveLength(0); // the escalated write-shaped call never ran unattended
  });
});
