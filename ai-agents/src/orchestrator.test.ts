// WS8 §2.2 + D14 brigade bounds, proven at the orchestrator level.
import { describe, it, expect } from "vitest";
import { runOrchestrator, UnknownSpecialistError, GoalBudgetExhaustedError, GoalSuspendedError, type OrchestratorDef, type SpecialistRunRecord } from "./orchestrator";
import { ApprovalRequiredError, type AgentDef, type AgentDeps, type StepEvent } from "./agent";

const envelope = { provider: "telegram", externalId: "tg:555" };

const def: OrchestratorDef = {
  name: "supervisor",
  systemPrompt: "You are the Gaiada work supervisor.",
  specialists: {
    "status-reporter": {
      name: "status-reporter",
      systemPrompt: "Project status reporter.",
      tools: { "projects.list": "read" },
      maxSteps: 4,
      maxToolCalls: 3,
    },
    "approvals-chaser": {
      name: "approvals-chaser",
      systemPrompt: "Approvals chaser.",
      tools: { "agency.pendingApprovals": "read" },
      maxSteps: 3,
      maxToolCalls: 2,
    },
  },
  maxPlannerSteps: 8,
  maxSubRuns: 4,
  goalBudget: { modelCalls: 20, toolCalls: 10 },
};

/** Routes model calls by prompt content: planner prompts vs each specialist's prompts. */
function routedDeps(): AgentDeps & { toolCalls: string[] } {
  const toolCalls: string[] = [];
  let plannerTurn = 0;
  return {
    toolCalls,
    complete: async (prompt) => {
      if (prompt.includes("You coordinate specialist agents")) {
        plannerTurn++;
        if (plannerTurn === 1) return `{"assign": {"specialist": "status-reporter", "task": "project status"}}`;
        if (plannerTurn === 2) return `{"assign": {"specialist": "approvals-chaser", "task": "pending approvals"}}`;
        return `{"final": "Projects: 1 active. Approvals: none pending."}`;
      }
      if (prompt.includes("status reporter")) {
        return prompt.includes("TOOL projects.list")
          ? `{"final": "1 active project: Rebrand"}`
          : `{"tool": "projects.list", "args": {"tenantId": "t1"}}`;
      }
      return prompt.includes("TOOL agency.pendingApprovals")
        ? `{"final": "no pending approvals"}`
        : `{"tool": "agency.pendingApprovals", "args": {"tenantId": "t1"}}`;
    },
    callTool: async (name) => {
      toolCalls.push(name);
      return "[]";
    },
  };
}

describe("orchestrator (WS8 step 2)", () => {
  it("plans, routes to both specialists, aggregates from the blackboard", async () => {
    const deps = routedDeps();
    const run = await runOrchestrator(def, "Morning briefing for tenant t1", envelope, deps);
    expect(run.outcome).toContain("Projects");
    expect(run.blackboard.map((e) => e.specialist)).toEqual(["status-reporter", "approvals-chaser"]);
    expect(run.blackboard.every((e) => e.status === "ok")).toBe(true);
    expect(deps.toolCalls).toEqual(["projects.list", "agency.pendingApprovals"]);
  });

  it("an unknown specialist is a typed error", async () => {
    const deps: AgentDeps = {
      complete: async () => `{"assign": {"specialist": "hacker-bot", "task": "x"}}`,
      callTool: async () => "[]",
    };
    await expect(runOrchestrator(def, "g", envelope, deps)).rejects.toThrow(UnknownSpecialistError);
  });

  it("cycle guard: identical (specialist, task) is never run twice", async () => {
    let subRuns = 0;
    let plannerTurn = 0;
    const deps: AgentDeps = {
      complete: async (prompt) => {
        if (prompt.includes("You coordinate specialist agents")) {
          plannerTurn++;
          if (plannerTurn <= 3) return `{"assign": {"specialist": "status-reporter", "task": "same task"}}`;
          expect(prompt).toContain("already assigned"); // the guard told the planner
          return `{"final": "done"}`;
        }
        subRuns++;
        return `{"final": "specialist result"}`;
      },
      callTool: async () => "[]",
    };
    const run = await runOrchestrator(def, "g", envelope, deps);
    expect(run.outcome).toBe("done");
    expect(subRuns).toBe(1); // ran once despite three identical assignments
  });

  it("the per-goal budget bounds the WHOLE tree (typed suspension, no final)", async () => {
    const tight: OrchestratorDef = { ...def, goalBudget: { modelCalls: 3, toolCalls: 1 } };
    const deps = routedDeps();
    const err = await runOrchestrator(tight, "g", envelope, deps).catch((e) => e);
    expect(err).toBeInstanceOf(GoalBudgetExhaustedError);
  });

  it("fan-out cap: more sub-runs than maxSubRuns is a typed suspension", async () => {
    let plannerTurn = 0;
    const capped: OrchestratorDef = { ...def, maxSubRuns: 1, maxPlannerSteps: 10 };
    const deps: AgentDeps = {
      complete: async (prompt) => {
        if (prompt.includes("You coordinate specialist agents")) {
          plannerTurn++;
          return `{"assign": {"specialist": "status-reporter", "task": "task ${plannerTurn}"}}`;
        }
        return `{"final": "r"}`;
      },
      callTool: async () => "[]",
    };
    await expect(runOrchestrator(capped, "g", envelope, deps)).rejects.toThrow(GoalBudgetExhaustedError);
  });

  it("a specialist failure lands on the blackboard as data; the planner finishes with partial results", async () => {
    let plannerTurn = 0;
    const deps: AgentDeps = {
      complete: async (prompt) => {
        if (prompt.includes("You coordinate specialist agents")) {
          plannerTurn++;
          if (plannerTurn === 1) return `{"assign": {"specialist": "status-reporter", "task": "status"}}`;
          expect(prompt).toContain("[failed]");
          return `{"final": "Could not fetch project data; try again later."}`;
        }
        return `{"tool": "projects.list", "args": {}}`; // loops → specialist budget exhausts
      },
      callTool: async () => {
        throw new Error("denied");
      },
    };
    const run = await runOrchestrator(def, "g", envelope, deps);
    expect(run.blackboard[0].status).toBe("failed");
    expect(run.outcome).toContain("Could not fetch");
  });

  // A write-capable specialist (evaled on the serving provider). Its high_write routes through the
  // D13/D14 gate in the orchestrator (runWriteAgent), not the plain runner.
  const writer: AgentDef = {
    name: "writer",
    systemPrompt: "Writes tasks.",
    tools: { "tasks.create": "high_write" },
    maxSteps: 3,
    maxToolCalls: 2,
    evaledProviders: ["gemini"],
  };
  const withWriter: OrchestratorDef = { ...def, specialists: { ...def.specialists, writer } };

  it("a high_write suspends the WHOLE goal AND files a durable approval (D14 + write-routing)", async () => {
    const calls: string[] = [];
    const deps: AgentDeps = {
      complete: async (prompt) =>
        prompt.includes("You coordinate specialist agents")
          ? `{"assign": {"specialist": "writer", "task": "create a task"}}`
          : `{"tool": "tasks.create", "args": {"title": "x"}}`,
      callTool: async (name) => {
        calls.push(name);
        return name === "approvals.request" ? JSON.stringify({ id: "ap-1" }) : "created";
      },
      lastProvider: () => "gemini",
    };
    // Served by gemini (evaled) → the high_write is attempted → gate suspends → approval filed.
    await expect(
      runOrchestrator(withWriter, "g", envelope, deps, { tenantId: "co-1", servingProvider: "gemini" }),
    ).rejects.toThrow(GoalSuspendedError);
    expect(calls).toContain("approvals.request"); // durable record created
    expect(calls).not.toContain("tasks.create"); // the write itself never executed
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // S0 (agent event spine, 2026-08-22) — DelegationTracking: a real edge, not blackboard prose.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  describe("S0: DelegationTracking — delegate events + per-specialist run records", () => {
    it("emits a 'delegate' event on opts.emit for each assignment, and onSpecialistRun fires once per specialist with parentRunId = the supervisor's own runId", async () => {
      const deps = routedDeps();
      const supervisorEvents: StepEvent[] = [];
      const records: SpecialistRunRecord[] = [];
      const SUP_RUN_ID = "sup-fixed-id";
      const run = await runOrchestrator(def, "Morning briefing for tenant t1", envelope, deps, {
        runId: SUP_RUN_ID,
        emit: (e) => { supervisorEvents.push(e); },
        delegation: {
          newRunId: (() => { let n = 0; return () => `child-${++n}`; })(),
          emitFor: () => () => {}, // per-specialist events proven separately below
          onSpecialistRun: (rec) => { records.push(rec); },
        },
      });
      expect(run.blackboard.map((e) => e.specialist)).toEqual(["status-reporter", "approvals-chaser"]);

      // Two delegate events on the SUPERVISOR's own stream, one per assignment, each naming the child run.
      const delegateEvents = supervisorEvents.filter((e) => e.kind === "delegate");
      expect(delegateEvents).toHaveLength(2);
      expect(delegateEvents[0].detail).toContain("status-reporter");
      expect(delegateEvents[0].detail).toContain("child-1");
      expect(delegateEvents[1].detail).toContain("approvals-chaser");
      expect(delegateEvents[1].detail).toContain("child-2");

      // Two specialist-run records, each carrying the FIXED supervisor runId as parentRunId — the real
      // delegation edge the floor-plan's parent_run_id column exists to carry.
      expect(records).toHaveLength(2);
      expect(records.every((r) => r.parentRunId === SUP_RUN_ID)).toBe(true);
      expect(records.map((r) => r.runId)).toEqual(["child-1", "child-2"]);
      expect(records.map((r) => r.status)).toEqual(["ok", "ok"]);
      expect(records[0].steps.length).toBeGreaterThan(0); // a real step transcript, not a summary string
    });

    it("each specialist's emitFor(childRunId) stream is ISOLATED from the supervisor's own and from siblings", async () => {
      const deps = routedDeps();
      const perChild = new Map<string, StepEvent[]>();
      await runOrchestrator(def, "Morning briefing for tenant t1", envelope, deps, {
        delegation: {
          emitFor: (runId) => {
            const bucket: StepEvent[] = [];
            perChild.set(runId, bucket);
            return (e) => { bucket.push(e); };
          },
        },
      });
      expect(perChild.size).toBe(2); // one bucket per specialist run, never merged
      for (const [, events] of perChild) {
        expect(events.some((e) => e.kind === "model")).toBe(true); // the specialist's OWN model steps landed here
      }
    });

    it("a caught specialist failure ('everything else is data') still calls onSpecialistRun, status 'failed', carrying the error's steps", async () => {
      let plannerTurn = 0;
      const deps: AgentDeps = {
        complete: async (prompt) => {
          if (prompt.includes("You coordinate specialist agents")) {
            plannerTurn++;
            if (plannerTurn === 1) return `{"assign": {"specialist": "status-reporter", "task": "status"}}`;
            return `{"final": "done despite the failure"}`;
          }
          return `{"tool": "projects.list", "args": {}}`; // loops → specialist's OWN budget exhausts
        },
        callTool: async () => { throw new Error("denied"); },
      };
      const records: SpecialistRunRecord[] = [];
      const run = await runOrchestrator(def, "g", envelope, deps, { delegation: { onSpecialistRun: (rec) => { records.push(rec); } } });
      expect(run.blackboard[0].status).toBe("failed");
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe("failed");
      expect(records[0].steps.length).toBeGreaterThan(0); // the specialist's own transcript up to the throw
    });

    it("onSpecialistRun is NOT called for the whole-goal-aborting rethrows (GoalSuspendedError) — no clean single-specialist record exists there", async () => {
      const calls: string[] = [];
      const deps: AgentDeps = {
        complete: async (prompt) =>
          prompt.includes("You coordinate specialist agents")
            ? `{"assign": {"specialist": "writer", "task": "create a task"}}`
            : `{"tool": "tasks.create", "args": {"title": "x"}}`,
        callTool: async (name) => { calls.push(name); return name === "approvals.request" ? JSON.stringify({ id: "ap-1" }) : "created"; },
        lastProvider: () => "gemini",
      };
      const records: SpecialistRunRecord[] = [];
      const withWriterDef: OrchestratorDef = {
        ...def,
        specialists: { ...def.specialists, writer: { name: "writer", systemPrompt: "w", tools: { "tasks.create": "high_write" }, maxSteps: 3, maxToolCalls: 2, evaledProviders: ["gemini"] } },
      };
      await expect(
        runOrchestrator(withWriterDef, "g", envelope, deps, {
          tenantId: "co-1", servingProvider: "gemini",
          delegation: { onSpecialistRun: (rec) => { records.push(rec); } },
        }),
      ).rejects.toThrow(GoalSuspendedError);
      expect(records).toHaveLength(0); // documented scope boundary — see DelegationTracking's own doc
    });

    it("omitting opts.emit/opts.delegation entirely is byte-identical to every pre-S0 call — no crash, same blackboard/outcome", async () => {
      const deps = routedDeps();
      const run = await runOrchestrator(def, "Morning briefing for tenant t1", envelope, deps);
      expect(run.outcome).toContain("Projects");
      expect(run.blackboard.map((e) => e.specialist)).toEqual(["status-reporter", "approvals-chaser"]);
    });
  });

  it("D13: on an un-evaled provider the write specialist runs read-only; the goal still completes", async () => {
    let plannerTurn = 0;
    const calls: string[] = [];
    const deps: AgentDeps = {
      complete: async (prompt) => {
        if (prompt.includes("You coordinate specialist agents")) {
          plannerTurn++;
          return plannerTurn === 1 ? `{"assign": {"specialist": "writer", "task": "triage"}}` : `{"final": "done (read-only)"}`;
        }
        return `{"final": "nothing to change"}`; // stays within reads
      },
      callTool: async (name) => {
        calls.push(name);
        return "[]";
      },
      lastProvider: () => "claude", // NOT in writer.evaledProviders
    };
    const run = await runOrchestrator(withWriter, "g", envelope, deps, { tenantId: "co-1" });
    expect(run.outcome).toContain("done");
    expect(run.blackboard[0].summary).toMatch(/read-only/);
    expect(calls).not.toContain("tasks.create");
  });
});
