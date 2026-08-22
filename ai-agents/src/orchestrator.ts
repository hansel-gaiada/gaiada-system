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
import { randomUUID } from "node:crypto";
import {
  runAgent,
  ApprovalRequiredError,
  type AgentDef,
  type AgentDeps,
  type AgentStep,
  type Envelope,
  type EmitStep,
} from "./agent";
import { isWriteCapable, runWriteAgent } from "./write-agent";

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

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S0 (agent event spine, 2026-08-22) — delegation as a real edge, not blackboard prose.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Today a specialist the supervisor spawns leaves ONLY a `BlackboardEntry` (status + a truncated
// summary string) — no run id, no timing, no persisted `agent_runs` row at all. The floor plan's
// conclusion (`docs/superpowers/plans/2026-08-22-agent-floor-plan.md` §2): "delegation exists only as
// prose in the blackboard jsonb" — that is what blocks an animated delegation graph.
//
// `DelegationTracking` is an OPTIONAL hook bag (every field optional; the whole object may be omitted)
// that lets a caller — `runner/service.ts`'s `processGoal`, the only production caller that has DB
// access — observe each specialist run as a first-class thing with its OWN id, timing and step
// transcript, tagged with the SUPERVISOR's run id as `parentRunId`. `orchestrator.ts` itself gains no DB
// dependency: it only calls hooks the caller supplies, exactly as it already threads `AgentDeps` without
// owning a Gateway/hub connection.
export interface SpecialistRunRecord {
  runId: string;
  parentRunId: string;
  specialist: string;
  task: string;
  /** Coarse: "ok" mirrors a `BlackboardEntry` of status "ok"; "failed" collapses every abnormal end
   *  caught here (`ToolNotAllowedError`, `ModelProtocolError`, a specialist's own `BudgetExhaustedError`,
   *  or any other thrown error) — the SAME set the existing catch block already turns into blackboard
   *  data. The caller maps this onto its own richer status vocabulary if it has one (see
   *  `runner/service.ts`, which maps "failed" to the `unknown_error` `TraceStatus` — the orchestrator
   *  does not know, and must not guess, a finer classification than the blackboard already captures). */
  status: "ok" | "failed";
  outcome: string;
  steps: AgentStep[];
  startedAt: number;
  endedAt: number;
}

export interface DelegationTracking {
  /** Mint a run id for a specialist about to be spawned. Defaults to `crypto.randomUUID()` when
   *  omitted — a caller only needs to supply this if it wants control over the id shape (no production
   *  caller does; tests may, to assert a specific value). */
  newRunId?: () => string;
  /** Build an `EmitStep` scoped to ONE specialist's run id, so its steps stream on their own sequence,
   *  distinct from the supervisor's own planner-step stream (`opts.emit` below). Omitted ⇒ the
   *  specialist runs with no observer, exactly as before this ticket. */
  emitFor?: (runId: string) => EmitStep;
  /** Called once per specialist run that reaches an end THIS function can observe: success, or the
   *  existing "everything else is data" catch (a caught failure recorded on the blackboard). NOT called
   *  on the three whole-goal-aborting rethrows (`GoalSuspendedError`, `ApprovalRequiredError`,
   *  `GoalBudgetExhaustedError`) — those carry the goal's blackboard, not a clean single-specialist step
   *  transcript, and inventing one here would be exactly the kind of guess this ticket's honesty rule
   *  forbids. The in-flight EVENTS for that specialist still exist (via `emitFor`'s stream) even when no
   *  final `agent_runs` row is persisted for it — see the S0 deploy notes for this scope boundary. */
  onSpecialistRun?: (rec: SpecialistRunRecord) => void | Promise<void>;
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

/** A write-capable sub-agent hit a high_write: the whole goal suspends (D14), now WITH a durable
 *  approval on file (via runWriteAgent → the shared approvals inbox). Nothing was committed. */
export class GoalSuspendedError extends Error {
  constructor(public specialist: string, public approvalId: string | null, public blackboard: BlackboardEntry[]) {
    super(`goal suspended: ${specialist} requires human approval (filed ${approvalId ?? "?"}) — nothing committed`);
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
    lastProvider: deps.lastProvider, // forward so write-routing can attribute the served provider
    // D14-10: forward the approval resolver too. This object REPLACES the caller's deps for the whole
    // subtree, so an unforwarded optional field is not "unused" — it is silently DROPPED, and the
    // runner would fall back to throw-and-file for every sub-run. That exact class of omission (a
    // value present upstream but not listed in the passthrough) has shipped four silently-disabled
    // features in this estate; the resolver is deliberately not budgeted, because it performs no model
    // call and any tool effect it triggers is the platform's, already counted on the approval row.
    resolveApproval: deps.resolveApproval,
    // D14-12: same hazard, same fix — forward the registry-impact reader so every sub-run's write gate
    // sees the reconciled (stricter-of-two) impact, not just the top-level run. It is synchronous and
    // free (no model/tool call), so it is not budgeted either.
    getRegistryImpact: deps.getRegistryImpact,
  };
}

export async function runOrchestrator(
  def: OrchestratorDef,
  goal: string,
  envelope: Envelope,
  rawDeps: AgentDeps,
  opts: {
    tenantId?: string;
    servingProvider?: string;
    /** S0 — this run's own id, used only to tag `delegate` events and as `parentRunId` on every
     *  specialist it spawns. Defaults to `crypto.randomUUID()`; no production caller needs to supply
     *  one unless it wants to correlate this value with something recorded elsewhere BEFORE calling in
     *  (e.g. `runner/service.ts` mints it first so the same id also names the supervisor's own
     *  observation record). */
    runId?: string;
    /** S0 — optional in-flight observer for the SUPERVISOR's own planner-step events. See agent.ts's
     *  `EmitStep` doc. */
    emit?: EmitStep;
    /** S0 — optional delegation-tracking hooks. See `DelegationTracking`'s doc above. */
    delegation?: DelegationTracking;
  } = {},
): Promise<OrchestratorRun> {
  const runId = opts.runId ?? randomUUID();
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
    const plannerStart = Date.now();
    const raw = await deps.complete(plannerPrompt(def, goal, blackboard, notes));
    await opts.emit?.({ kind: "model", detail: raw.slice(0, 200), durationMs: Date.now() - plannerStart });

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

    const childRunId = opts.delegation?.newRunId?.() ?? randomUUID();
    const childEmit = opts.delegation?.emitFor?.(childRunId);
    await opts.emit?.({ kind: "delegate", detail: `assign ${name}: ${task} -> run ${childRunId}` });
    const subStartedAt = Date.now();

    try {
      if (isWriteCapable(specialist)) {
        // Route write-capable specialists through the D13 provider gate + D14 approval filing.
        const provider = opts.servingProvider ?? deps.lastProvider?.() ?? "echo";
        const res = await runWriteAgent(specialist, task!, envelope, deps, opts.tenantId ?? "", provider, { emit: childEmit });
        if (res.status === "suspended") {
          // D14: a high_write suspends the WHOLE goal — now with a durable approval on file.
          // T2b note: the orchestrator never passes `fileOnSuspend:false` (out of this ticket's
          // scope — see the ASST-23 unblock design §7.2.5/T2b), so `res.filed` is always non-null in
          // practice here; the ternary only satisfies the type now that `WriteAgentResult`'s
          // `"suspended"` status has two shapes (write-agent.ts).
          throw new GoalSuspendedError(name!, res.filed ? res.filed.approvalId : null, blackboard);
        }
        const note = res.status === "forced_read_only" ? ` [read-only: ${res.reason}]` : "";
        blackboard.push({ specialist: name!, task: task!, status: "ok", summary: res.run.outcome + note });
        await opts.delegation?.onSpecialistRun?.({
          runId: childRunId, parentRunId: runId, specialist: name!, task: task!,
          status: "ok", outcome: res.run.outcome + note, steps: res.run.steps,
          startedAt: subStartedAt, endedAt: Date.now(),
        });
      } else {
        const run = await runAgent(specialist, task!, envelope, deps, childEmit);
        blackboard.push({ specialist: name!, task: task!, status: "ok", summary: run.outcome });
        await opts.delegation?.onSpecialistRun?.({
          runId: childRunId, parentRunId: runId, specialist: name!, task: task!,
          status: "ok", outcome: run.outcome, steps: run.steps,
          startedAt: subStartedAt, endedAt: Date.now(),
        });
      }
    } catch (err) {
      // A suspension/budget exhaustion is a HUMAN decision — it suspends the whole goal (D14).
      if (err instanceof GoalSuspendedError || err instanceof ApprovalRequiredError || err instanceof GoalBudgetExhaustedError) throw err;
      // Everything else is data: the planner decides how to proceed with a failed subtask.
      const message = (err as Error).message;
      blackboard.push({ specialist: name!, task: task!, status: "failed", summary: message });
      const steps = (err as { steps?: AgentStep[] })?.steps ?? [];
      await opts.delegation?.onSpecialistRun?.({
        runId: childRunId, parentRunId: runId, specialist: name!, task: task!,
        status: "failed", outcome: message, steps,
        startedAt: subStartedAt, endedAt: Date.now(),
      });
    }
  }
}
