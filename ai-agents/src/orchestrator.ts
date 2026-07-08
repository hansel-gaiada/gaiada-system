// Orchestrator (WS8 §2.2): supervisor/worker with a shared blackboard. The planner
// decomposes a goal and routes subtasks to specialists; D14's brigade bounds are
// enforced HERE, not trusted to the model:
//  - per-goal budget (model calls + tool calls) across the WHOLE tree (two-tier: the
//    Gateway's daily cap is the coarse tier, this is the per-goal tier)
//  - fan-out cap (max specialist runs per goal) and depth cap (v1: supervisor→specialist)
//  - blackboard cycle detection: the same (specialist, task) is never run twice —
//    the planner is told instead of looping
//  - a specialist's approval suspension (high_write) suspends the WHOLE goal (typed);
//    other specialist failures land on the blackboard as data for the planner
// Durable/resumable execution (Temporal) is the target state; v1 is in-process and
// every abnormal end is a typed error carrying the blackboard — never a placeholder.
import {
  runAgent,
  ApprovalRequiredError,
  type AgentDef,
  type AgentDeps,
  type Envelope,
} from "./agent";

export interface OrchestratorDef {
  name: string;
  systemPrompt: string;
  specialists: Record<string, AgentDef>;
  maxPlannerSteps: number;
  maxSubRuns: number; // fan-out cap
  goalBudget: { modelCalls: number; toolCalls: number };
}

export interface BlackboardEntry {
  specialist: string;
  task: string;
  status: "ok" | "failed";
  summary: string;
}

export interface OrchestratorRun {
  outcome: string;
  blackboard: BlackboardEntry[];
}

export class UnknownSpecialistError extends Error {
  constructor(name: string, public blackboard: BlackboardEntry[]) {
    super(`planner assigned an unknown specialist: ${name}`);
  }
}

export class GoalBudgetExhaustedError extends Error {
  constructor(which: string, public blackboard: BlackboardEntry[]) {
    super(`per-goal ${which} budget exhausted — goal suspended for human resume, nothing committed`);
  }
}

export class PlannerProtocolError extends Error {
  constructor(public blackboard: BlackboardEntry[]) {
    super("planner failed to produce a valid action twice — goal aborted");
  }
}

interface PlannerAction {
  assign?: { specialist?: string; task?: string };
  final?: string;
}

function parsePlannerAction(raw: string): PlannerAction | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as PlannerAction;
    if (typeof parsed.final === "string") return parsed;
    if (parsed.assign && typeof parsed.assign.specialist === "string" && typeof parsed.assign.task === "string")
      return parsed;
    return null;
  } catch {
    return null;
  }
}

function plannerPrompt(def: OrchestratorDef, goal: string, blackboard: BlackboardEntry[], notes: string[]): string {
  const directory = Object.values(def.specialists)
    .map((s) => `- ${s.name}: ${s.systemPrompt.split(".")[0]}. tools: ${Object.keys(s.tools).join(", ")}`)
    .join("\n");
  const board = blackboard
    .map((e) => `[${e.status}] ${e.specialist} ← "${e.task}": ${e.summary.slice(0, 400)}`)
    .join("\n");
  return `${def.systemPrompt}

You coordinate specialist agents. Reply with EXACTLY ONE JSON object and nothing else:
  {"assign": {"specialist": "<name>", "task": "<subtask>"}}   to delegate, or
  {"final": "<the aggregated answer to the goal>"}            when the goal is met.

SPECIALISTS:
${directory}

GOAL: ${goal}

BLACKBOARD (results so far):
${board || "(empty)"}
${notes.length ? `\nNOTES:\n${notes.join("\n")}` : ""}`;
}

/** Wrap deps so every model/tool call anywhere in the tree draws from the goal budget. */
function budgetedDeps(deps: AgentDeps, budget: { modelCalls: number; toolCalls: number }, blackboard: BlackboardEntry[]): AgentDeps {
  let modelCalls = 0;
  let toolCalls = 0;
  return {
    complete: async (prompt) => {
      if (++modelCalls > budget.modelCalls) throw new GoalBudgetExhaustedError("modelCalls", blackboard);
      return deps.complete(prompt);
    },
    callTool: async (name, args, envelope) => {
      if (++toolCalls > budget.toolCalls) throw new GoalBudgetExhaustedError("toolCalls", blackboard);
      return deps.callTool(name, args, envelope);
    },
  };
}

export async function runOrchestrator(
  def: OrchestratorDef,
  goal: string,
  envelope: Envelope,
  rawDeps: AgentDeps,
): Promise<OrchestratorRun> {
  const blackboard: BlackboardEntry[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const deps = budgetedDeps(rawDeps, def.goalBudget, blackboard);
  let plannerSteps = 0;
  let subRuns = 0;
  let protocolRetries = 0;

  for (;;) {
    if (plannerSteps >= def.maxPlannerSteps) throw new GoalBudgetExhaustedError("plannerSteps", blackboard);
    plannerSteps++;
    const raw = await deps.complete(plannerPrompt(def, goal, blackboard, notes));

    const action = parsePlannerAction(raw);
    if (!action) {
      if (protocolRetries++ >= 1) throw new PlannerProtocolError(blackboard);
      notes.push("SYSTEM: your last reply was not a valid JSON action. Reply with one JSON object only.");
      continue;
    }
    protocolRetries = 0;

    if (action.final !== undefined) return { outcome: action.final, blackboard };

    const { specialist: name, task } = action.assign!;
    const specialist = def.specialists[name!];
    if (!specialist) throw new UnknownSpecialistError(name!, blackboard);

    const key = `${name}::${task}`;
    if (seen.has(key)) {
      // Cycle guard: don't re-run identical work; tell the planner instead.
      notes.push(`SYSTEM: "${task}" was already assigned to ${name} — use the blackboard result or finish.`);
      continue;
    }
    if (subRuns >= def.maxSubRuns) throw new GoalBudgetExhaustedError("subRuns", blackboard);
    seen.add(key);
    subRuns++;

    try {
      const run = await runAgent(specialist, task!, envelope, deps);
      blackboard.push({ specialist: name!, task: task!, status: "ok", summary: run.outcome });
    } catch (err) {
      // Approval suspension is a HUMAN decision — it suspends the whole goal (D14).
      if (err instanceof ApprovalRequiredError || err instanceof GoalBudgetExhaustedError) throw err;
      // Everything else is data: the planner decides how to proceed with a failed subtask.
      blackboard.push({ specialist: name!, task: task!, status: "failed", summary: (err as Error).message });
    }
  }
}
