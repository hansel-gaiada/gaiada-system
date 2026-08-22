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
  type StepEvent,
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // S0 (agent event spine, 2026-08-22) — `emit` fires IN FLIGHT, one call per `steps[]` boundary, in
  // order. This is the "write an event at each step boundary instead of accumulating" contract: a caller
  // watching only `emit` (never touching the returned `AgentRun`) must be able to reconstruct the same
  // step sequence `steps[]` carries.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  describe("S0: EmitStep — in-flight, per-boundary, ordered", () => {
    it("emits one 'model' event per model call and one 'tool' event per tool call, in the SAME order steps[] records them, before the run resolves", async () => {
      const events: StepEvent[] = [];
      const deps = scripted(
        [`{"tool": "projects.list", "args": {}}`, `{"final": "1 active project: Rebrand"}`],
        () => JSON.stringify([{ name: "Rebrand" }]),
      );
      const run = await runAgent(def, "status?", envelope, deps, (e) => {
        events.push(e);
      });
      // The events line up 1:1 with steps[] in kind and (for the tool step) detail — proving `emit` is
      // not a summary computed after the fact, but literally paired with each push at the boundary.
      expect(events.map((e) => e.kind)).toEqual(["model", "tool", "model"]);
      expect(events[1].detail).toBe("projects.list ok");
      expect(run.steps.map((s) => s.kind)).toEqual(["model", "tool", "model"]);
    });

    it("emit is awaited BEFORE the run proceeds — proven by a slow, order-recording emitter never observing steps out of sequence", async () => {
      const seen: number[] = [];
      let n = 0;
      const slowEmit = async (): Promise<void> => {
        const mine = ++n;
        await new Promise((r) => setTimeout(r, mine === 1 ? 15 : 0)); // first call is slow
        seen.push(mine);
      };
      const deps = scripted(
        [`{"tool": "projects.list", "args": {}}`, `{"final": "ok"}`],
        () => "[]",
      );
      await runAgent(def, "x", envelope, deps, slowEmit);
      // If `emit` were fire-and-forget (not awaited), the slow FIRST call could resolve after later
      // ones, and `seen` would come back out of order despite being pushed in call order. Awaiting each
      // call is what keeps this deterministic.
      expect(seen).toEqual([1, 2, 3]);
    });

    it("emits an 'approval_wait' event before suspending on a high_write with no resolver wired — the honest 'why did this stop' fact, not a bare timeout", async () => {
      const events: StepEvent[] = [];
      const deps = scripted([`{"tool": "tasks.create", "args": {"title": "t"}}`]);
      await expect(runAgent(def, "x", envelope, deps, (e) => { events.push(e); })).rejects.toThrow(ApprovalRequiredError);
      expect(events.at(-1)).toMatchObject({ kind: "approval_wait" });
      expect(events.at(-1)!.detail).toContain("tasks.create");
    });

    it("emits an 'error' event immediately before a terminal typed throw (budget exhaustion)", async () => {
      const events: StepEvent[] = [];
      const deps = scripted([`{"tool": "projects.list", "args": {}}`]); // loops forever
      await expect(runAgent(def, "x", envelope, deps, (e) => { events.push(e); })).rejects.toThrow(BudgetExhaustedError);
      expect(events.at(-1)!.kind).toBe("error");
    });

    it("runAgent does NOT swallow a throwing emitter — the fail-soft guard belongs to the CALLER (runner/service.ts's makeEmitter), not this framework function", async () => {
      // `runAgent` deliberately does not wrap `emit?.()` in its own try/catch: doing so here would hide
      // a broken observer from the one place (`makeEmitter`) that is supposed to log and swallow it.
      // This test pins that boundary so a future edit doesn't quietly move the guard into the wrong
      // layer — see this file's `EmitStep` doc ("never throws by contract" is a promise `makeEmitter`
      // keeps, not one `runAgent` enforces).
      await expect(
        runAgent(def, "x", envelope, scripted([`{"final": "done"}`]), () => {
          throw new Error("emitter boom");
        }),
      ).rejects.toThrow("emitter boom");
      // A well-behaved (non-throwing) emitter on an otherwise-identical run is unaffected.
      const run = await runAgent(def, "x2", envelope, scripted([`{"final": "done"}`]), () => {});
      expect(run.outcome).toBe("done");
    });

    it("omitting emit entirely is byte-identical to every pre-S0 call site", async () => {
      const deps = scripted([`{"final": "ok"}`]);
      const run = await runAgent(def, "x", envelope, deps);
      expect(run).toEqual({ outcome: "ok", steps: [{ kind: "model", detail: '{"final": "ok"}' }] });
    });
  });
});
