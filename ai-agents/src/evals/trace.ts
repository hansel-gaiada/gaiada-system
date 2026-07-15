// WS8 Step A — run tracing (spec §6, D13). Every agent run is captured as a stable, versioned
// trace: run_start → one event per model/tool step → run_end (with a typed status). This is
// (a) the eval harness's observation surface and (b) the episodic-memory + WS9 feed. It's emitted
// as JSONL so a live run can append to a file today and WS9 can consume the same schema later.
//
// Tracing wraps the PROVEN runner non-invasively: it runs runAgent and, on any typed abnormal end,
// reads the error's `.steps` (the runner already carries the transcript on every typed error) —
// nothing in agent.ts changes.
import {
  runAgent,
  ToolNotAllowedError,
  ApprovalRequiredError,
  BudgetExhaustedError,
  ModelProtocolError,
  type AgentDef,
  type AgentDeps,
  type AgentStep,
  type Envelope,
} from "../agent";

export type TraceStatus =
  | "ok"
  | "tool_not_allowed"
  | "approval_required"
  | "budget_exhausted"
  | "protocol_error"
  | "unknown_error";

export interface AgentTrace {
  v: 1;
  runId: string;
  agent: string;
  envelope: Envelope;
  goal: string;
  status: TraceStatus;
  outcome: string | null; // the final answer on "ok"; the error message otherwise
  steps: AgentStep[];
  modelCalls: number;
  toolCalls: number;
  toolsCalled: string[]; // names of tools the runner actually EXECUTED (post-gate)
  startedAt: number;
  endedAt: number;
}

/** Map a thrown value to a typed status + the transcript the error carries. */
export function classifyError(err: unknown): { status: TraceStatus; steps: AgentStep[] } {
  if (err instanceof ToolNotAllowedError) return { status: "tool_not_allowed", steps: err.steps };
  if (err instanceof ApprovalRequiredError) return { status: "approval_required", steps: err.steps };
  if (err instanceof BudgetExhaustedError) return { status: "budget_exhausted", steps: err.steps };
  if (err instanceof ModelProtocolError) return { status: "protocol_error", steps: err.steps };
  return { status: "unknown_error", steps: [] };
}

/**
 * Run an agent and return its trace — the reusable observation entry point for evals AND live runs.
 * `clock` is injectable so evals are deterministic (defaults to Date.now for live runs).
 */
export async function traceRun(
  runId: string,
  def: AgentDef,
  goal: string,
  envelope: Envelope,
  deps: AgentDeps,
  clock: () => number = Date.now,
): Promise<AgentTrace> {
  const startedAt = clock();
  const base = {
    v: 1 as const,
    runId,
    agent: def.name,
    envelope,
    goal,
    startedAt,
  };
  try {
    const run = await runAgent(def, goal, envelope, deps);
    return {
      ...base,
      status: "ok",
      outcome: run.outcome,
      steps: run.steps,
      modelCalls: run.steps.filter((s) => s.kind === "model").length,
      toolCalls: run.steps.filter((s) => s.kind === "tool").length,
      toolsCalled: executedTools(run.steps),
      endedAt: clock(),
    };
  } catch (err) {
    const { status, steps } = classifyError(err);
    return {
      ...base,
      status,
      outcome: (err as Error).message,
      steps,
      modelCalls: steps.filter((s) => s.kind === "model").length,
      toolCalls: steps.filter((s) => s.kind === "tool").length,
      toolsCalled: executedTools(steps),
      endedAt: clock(),
    };
  }
}

/** Tool steps read as "<name> ok" | "<name> failed"; recover the executed tool names. */
function executedTools(steps: AgentStep[]): string[] {
  return steps.filter((s) => s.kind === "tool").map((s) => s.detail.replace(/ (ok|failed)$/, ""));
}

/** Flatten a trace to JSONL lines (run_start, one per step, run_end) — the stable WS9-facing schema. */
export function traceLines(t: AgentTrace): string[] {
  const lines = [
    JSON.stringify({ v: t.v, runId: t.runId, agent: t.agent, kind: "run_start", goal: t.goal, envelope: t.envelope, ts: t.startedAt }),
    ...t.steps.map((s, i) =>
      JSON.stringify({ v: t.v, runId: t.runId, agent: t.agent, kind: s.kind, seq: i, detail: s.detail }),
    ),
    JSON.stringify({
      v: t.v, runId: t.runId, agent: t.agent, kind: "run_end",
      status: t.status, outcome: t.outcome, modelCalls: t.modelCalls, toolCalls: t.toolCalls,
      toolsCalled: t.toolsCalled, ts: t.endedAt,
    }),
  ];
  return lines;
}
