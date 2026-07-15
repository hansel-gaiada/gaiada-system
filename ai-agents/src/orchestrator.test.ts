// WS8 §2.2 + D14 brigade bounds, proven at the orchestrator level.
import { describe, it, expect } from "vitest";
import { runOrchestrator, UnknownSpecialistError, GoalBudgetExhaustedError, GoalSuspendedError, type OrchestratorDef } from "./orchestrator";
import { ApprovalRequiredError, type AgentDef, type AgentDeps } from "./agent";

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
