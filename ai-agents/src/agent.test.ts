// D14 action safety, proven at the runner level: allow-list, impact taxonomy,
// approval suspension, typed budget exhaustion (never a committed placeholder).
import { describe, it, expect } from "vitest";
import {
  runAgent,
  ToolNotAllowedError,
  ApprovalRequiredError,
  BudgetExhaustedError,
  ModelProtocolError,
  MAX_OFF_LIST_ATTEMPTS,
  type AgentDef,
  type AgentDeps,
} from "./agent";
import { statusReporter, taskFiler } from "./specialists";

const envelope = { provider: "telegram", externalId: "tg:555" };

function scripted(responses: string[], onTool?: (name: string, args: Record<string, unknown>) => string): AgentDeps {
  let i = 0;
  return {
    complete: async () => responses[Math.min(i++, responses.length - 1)],
    callTool: async (name, args) => (onTool ? onTool(name, args) : "[]"),
  };
}

const def: AgentDef = {
  name: "test-agent",
  systemPrompt: "You are a test agent.",
  tools: { "projects.list": "read", "tasks.create": "high_write" },
  maxSteps: 5,
  maxToolCalls: 3,
};

describe("agent runner (WS8 step 1 + D14)", () => {
  it("gathers via allowed read tools and finishes with a grounded answer", async () => {
    const toolCalls: string[] = [];
    const deps = scripted(
      [
        `{"tool": "projects.list", "args": {"tenantId": "t1"}}`,
        `{"final": "1 active project: Rebrand"}`,
      ],
      (name) => {
        toolCalls.push(name);
        return JSON.stringify([{ name: "Rebrand", status: "active" }]);
      },
    );
    const run = await runAgent(def, "status?", envelope, deps);
    expect(run.outcome).toContain("Rebrand");
    expect(toolCalls).toEqual(["projects.list"]);
  });

  it("refuses tools outside the allow-list (typed, run stops) once recovery is exhausted", async () => {
    const deps = scripted([`{"tool": "users.delete", "args": {}}`]);
    await expect(runAgent(def, "x", envelope, deps)).rejects.toThrow(ToolNotAllowedError);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 2026-08-07 — LIVE BUG: the assistant's `task-filer` had its model call `pm.listTasks` (invented by
  // analogy from `pm.createTask`; it exists on neither this agent's allow-list nor the hub registry) and
  // the turn died outright ("tool not on the agent's allow-list", no partial answer). See agent.ts's own
  // 2026-08-07 header for the fix: a bounded, recoverable nudge instead of an immediate fatal refusal.
  //
  // This test uses a hallucinated name that has never been real anywhere (`pm.fetchTasks`) so it keeps
  // proving the GENERAL off-list-recovery mechanism independent of any specific historical guess. See
  // "the exact live incident" below for what happens to the ACTUAL `pm.listTasks` guess today.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════

  it("an off-list tool guess is a RECOVERABLE nudge: the hallucinated tool is never called, and the model finishes on retry with a valid name", async () => {
    const pmLikeDef: AgentDef = {
      name: "pm-like-agent",
      systemPrompt: "test",
      tools: { "tasks.list": "read", "pm.createTask": "high_write" },
      maxSteps: 6,
      maxToolCalls: 4,
    };
    const toolCalls: string[] = [];
    const deps = scripted(
      [
        `{"tool": "pm.fetchTasks", "args": {}}`, // hallucinated, NOT in the alias map — refused, must NEVER be dispatched
        `{"tool": "tasks.list", "args": {}}`, // retries with a real, allow-listed name
        `{"final": "1 open task: Fix bug."}`,
      ],
      (name) => {
        toolCalls.push(name);
        return JSON.stringify([{ id: "t1", title: "Fix bug" }]);
      },
    );
    const run = await runAgent(pmLikeDef, "list my open tasks", envelope, deps);
    expect(run.outcome).toContain("1 open task");
    // The hallucinated name was NEVER invoked — only the real retry reached deps.callTool.
    expect(toolCalls).toEqual(["tasks.list"]);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // 2026-08-07 (follow-up ticket, then RETRACTED 2026-08-08 by P4-J5) — a short-lived alias map entry
  // used to resolve this EXACT guess on the first attempt, before `pm.listTasks` reached the off-list
  // check at all. That entry is now retired: `mcp-hub/src/pm-tools.ts` (P4-J1) made `pm.listTasks` a
  // REAL, DIFFERENT canonical tool (tenant-wide, facet-rich — not `tasks.list`'s project-scoped shape),
  // so silently rewriting a correct call to it into a call to a DIFFERENT tool became a correctness bug,
  // not a convenience — see `tool-aliases.ts`'s retirement note. Today the exact same guess against
  // `task-filer` (which still does not, and should not, carry `pm.listTasks` on its own allow-list — see
  // that AgentDef's own 2026-08-08 correction) falls through to the SAME general off-list-recovery
  // mechanism the test above proves, costing one recoverable nudge instead of resolving silently.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  it("the exact live incident (task-filer's model calling pm.listTasks) now costs one recoverable nudge, not a silent same-turn resolution — the alias that used to shortcut it is retired", async () => {
    const toolCalls: string[] = [];
    const deps = scripted(
      [
        `{"tool": "pm.listTasks", "args": {}}`, // the exact guess from the live incident — now a REAL, DIFFERENT tool elsewhere, still not on task-filer's allow-list
        `{"tool": "tasks.list", "args": {}}`, // recovers with the real allow-listed name after the nudge
        `{"final": "1 open task: Fix bug."}`,
      ],
      (name) => {
        toolCalls.push(name);
        return JSON.stringify([{ id: "t1", title: "Fix bug" }]);
      },
    );
    const run = await runAgent(taskFiler, "list my open tasks", envelope, deps);
    expect(run.outcome).toBe("1 open task: Fix bug.");
    // The guess was NEVER dispatched — only the recovered, real tool name reached deps.callTool.
    expect(toolCalls).toEqual(["tasks.list"]);
  });

  it("caps off-list recovery at MAX_OFF_LIST_ATTEMPTS, then refuses outright exactly as before — the tool is NEVER dispatched on any attempt", async () => {
    let modelCalls = 0;
    const deps: AgentDeps = {
      complete: async () => {
        modelCalls++;
        return `{"tool": "users.delete", "args": {}}`;
      },
      callTool: async () => {
        throw new Error("must never be called — the off-list tool is refused, not executed, on every attempt");
      },
    };
    const err = await runAgent(def, "x", envelope, deps).catch((e) => e);
    expect(err).toBeInstanceOf(ToolNotAllowedError);
    // MAX_OFF_LIST_ATTEMPTS recoverable retries + one terminal attempt = the total model calls consumed.
    expect(modelCalls).toBe(MAX_OFF_LIST_ATTEMPTS + 1);
  });

  it("the recoverable nudge is shared runAgent behaviour — it covers every specialist (e.g. status-reporter, approvals-chaser), not just task-filer", async () => {
    const toolCalls: string[] = [];
    const deps = scripted(
      [
        `{"tool": "projects.getSingle", "args": {}}`, // hallucinated — not a real status-reporter tool
        `{"tool": "projects.list", "args": {}}`,
        `{"final": "ok"}`,
      ],
      (name) => {
        toolCalls.push(name);
        return "[]";
      },
    );
    const run = await runAgent(statusReporter, "status?", envelope, deps);
    expect(run.outcome).toBe("ok");
    expect(toolCalls).toEqual(["projects.list"]);
  });

  it("high-impact writes suspend for human approval — nothing executes", async () => {
    let executed = false;
    const deps = scripted([`{"tool": "tasks.create", "args": {"title": "t"}}`], () => {
      executed = true;
      return "created";
    });
    await expect(runAgent(def, "x", envelope, deps)).rejects.toThrow(ApprovalRequiredError);
    expect(executed).toBe(false);
  });

  it("budget exhaustion raises a TYPED error carrying the transcript — no placeholder outcome", async () => {
    const deps = scripted([`{"tool": "projects.list", "args": {}}`]); // loops forever
    const err = await runAgent(def, "x", envelope, deps).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExhaustedError);
    expect((err as BudgetExhaustedError).steps.length).toBeGreaterThan(0);
  });

  it("tool failures are surfaced to the model, not swallowed as facts", async () => {
    const deps: AgentDeps = {
      complete: (() => {
        let i = 0;
        return async (prompt: string) => {
          if (i++ === 0) return `{"tool": "projects.list", "args": {}}`;
          expect(prompt).toContain("FAILED: denied");
          return `{"final": "I could not access project data."}`;
        };
      })(),
      callTool: async () => {
        throw new Error("denied");
      },
    };
    const run = await runAgent(def, "x", envelope, deps);
    expect(run.outcome).toContain("could not access");
  });

  it("malformed model output gets one nudge, then a typed protocol error", async () => {
    const deps = scripted(["sure! here's what I think...", "still not json"]);
    await expect(runAgent(def, "x", envelope, deps)).rejects.toThrow(ModelProtocolError);
  });
});
