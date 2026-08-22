// Agent-runner service (B1, design §3.2). A Fastify service that puts a durable goal/run store + a
// bounded queue AROUND the EXISTING, proven runners — runOrchestrator / runWriteAgent / traceRun. It
// NEVER reimplements the D13 (provider gate) or D14 (approval filing) safety logic: it wraps those
// runners and maps their TYPED outcomes/errors to a goal status the ERP can surface honestly. The
// process holds no provider keys and no platform-DB access (models via Gateway, actions via hub OBO) —
// exactly like the CLI. Mirrors knowledge/service.ts conventions: telemetry first, fastifyLoggerOption,
// safeEqual bearer auth fail-closed on empty token, a buildRunnerApp(deps) factory for tests.
import "../telemetry"; // WS9: start OTel first so it patches http/pg. No-op unless OTEL_ENABLED.
import { fastifyLoggerOption } from "../telemetry";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  runAgent,
  ApprovalRequiredError,
  BudgetExhaustedError,
  ModelProtocolError,
  ToolNotAllowedError,
  type AgentDef,
  type AgentDeps,
  type AgentRun,
  type Envelope,
  type EmitStep,
} from "../agent";
import {
  runOrchestrator,
  UnknownSpecialistError,
  GoalBudgetExhaustedError,
  GoalSuspendedError,
  PlannerProtocolError,
  type OrchestratorDef,
  type SpecialistRunRecord,
} from "../orchestrator";
import { runWriteAgent, type WriteAgentResult, type SuspendedIntent } from "../write-agent";
import { traceRun, type AgentTrace, type TraceStatus } from "../evals/trace";
import { specialists, writeSpecialists, supervisor } from "../specialists";
import { ObservabilityCollector } from "../obs/collector";
import { episodeFromTrace, type Episode } from "../memory/episodic";
import { liveDeps, tenantContext, envelopeContext, startRegistryImpactBootstrap } from "../deps";
import { PgGoalStore, type GoalStore, type FinishGoalPatch, type BudgetCaps, type RunInput } from "./store";
import { GoalQueue } from "./queue";
import { publishRunEvent, subscribeTenant } from "./events-bus";

export const runnerConfig = {
  port: Number(process.env.RUNNER_PORT ?? 3006),
  host: process.env.HOST ?? "0.0.0.0",
  token: process.env.AGENT_RUNNER_TOKEN ?? "",
  databaseUrl: process.env.AGENTS_DATABASE_URL ?? "",
  migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL ?? "",
  maxConcurrent: Number(process.env.AGENT_MAX_CONCURRENT_GOALS ?? 1),
  maxQueue: Number(process.env.AGENT_MAX_QUEUE ?? 10),
  // Optional override of the provider the D13 write gate sees; else deps.lastProvider() drives it.
  servingProvider: process.env.AGENT_SERVING_PROVIDER || undefined,
  // T2b (§7.2.4.1/§7.2.5) — how long a `fileOnSuspend:false` intent survives in the in-memory TTL map
  // before it can no longer be handed back on `GET /goals/:id`. Purely a raw-args retention bound:
  // correctness never depends on it (a confirm-time filer re-checks server-side preconditions, same as
  // every other approval). Default ~15 min per the design's own number.
  intentTtlMs: Number(process.env.AGENT_INTENT_TTL_MS ?? 15 * 60 * 1000),
};

// S0 (agent event spine) — SSE tuning, the SAME numbers `portal-stream.controller.ts` uses (the proven
// pattern this ticket is told to copy): a 25s heartbeat resets a proxy's read-timeout clock (nginx's
// default `proxy_read_timeout` is 60s), and a 30-minute hard cap forces a periodic reconnect rather than
// an indefinitely-open connection.
const EVENTS_HEARTBEAT_MS = 25_000;
const EVENTS_MAX_CONNECTION_MS = 30 * 60 * 1000;
const EVENTS_RETRY_MS = 5_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A minimal episodic sink both EpisodicStore (in-memory) and PgEpisodicStore satisfy. `query` is
 *  OPTIONAL (not every future test double needs to answer reads) — `GET /episodes` (ASST-21) treats
 *  its absence the same as "no episodic store configured" (404), never as "empty history". */
export interface EpisodicSink {
  record(ep: Episode): void | Promise<void>;
  query?(tenantSet: string[], filter?: { agent?: string; status?: string; runIds?: string[] }): Episode[] | Promise<Episode[]>;
}

/** The agent registry the runner routes against; injectable so tests can add scripted specialists. */
export interface AgentRegistry {
  supervisor: OrchestratorDef;
  specialists: Record<string, AgentDef>;
  writeSpecialists: Record<string, AgentDef>;
}

export const defaultRegistry: AgentRegistry = { supervisor, specialists, writeSpecialists };

export interface RunnerDeps {
  store: GoalStore;
  agentDeps: AgentDeps;
  collector?: ObservabilityCollector;
  episodic?: EpisodicSink;
  registry?: AgentRegistry;
  config?: Partial<typeof runnerConfig>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function budgetForAgent(agent: string, reg: AgentRegistry): BudgetCaps {
  if (agent === reg.supervisor.name || agent === "supervisor") return { ...reg.supervisor.goalBudget };
  const def = reg.writeSpecialists[agent] ?? reg.specialists[agent];
  return def ? { modelCalls: def.maxSteps, toolCalls: def.maxToolCalls } : { modelCalls: 0, toolCalls: 0 };
}

// ---- typed-outcome → goal-status mapping (design §3.2) -----------------------------------------

function mapTrace(t: AgentTrace): FinishGoalPatch {
  if (t.status === "ok") return { status: "ok", outcome: t.outcome };
  if (t.status === "approval_required") return { status: "suspended", outcome: t.outcome, errorKind: t.status };
  if (t.status === "budget_exhausted") return { status: "budget_exhausted", outcome: t.outcome, errorKind: t.status };
  // tool_not_allowed | protocol_error | unknown_error
  return { status: "failed", outcome: t.outcome, errorKind: t.status };
}

function mapWriteResult(res: WriteAgentResult): FinishGoalPatch {
  if (res.status === "completed") return { status: "ok", outcome: res.run.outcome };
  if (res.status === "forced_read_only") {
    // D13 kept honest: writes were DISABLED on an un-evaled provider. Status is `ok` (the read-only run
    // succeeded) but error_kind surfaces the downgrade — never silently widened to a write success.
    return { status: "ok", outcome: `${res.run.outcome}\n[note: ${res.reason}]`, errorKind: "forced_read_only" };
  }
  // res.status === "suspended" from here — TWO shapes since T2b (write-agent.ts's WriteAgentResult doc).
  // Handle BOTH explicitly; do not fall through assuming `filed` is always present.
  if (res.filed === null) {
    // T2b (`fileOnSuspend:false`): suspended WITHOUT filing. No approvalId — nothing was filed. The
    // outcome text deliberately carries no raw args: this patch is what `store.finishGoal` persists to
    // the agents DB, which must never hold raw args (see `SuspendedIntent`'s doc) — `processGoal` parks
    // the real intent (incl. args) in the in-memory TTL map, never in this patch.
    return {
      status: "suspended",
      outcome: `suspended awaiting confirmation for ${res.intent.tool} (${res.intent.impact}) — not yet filed`,
      errorKind: "approval_required",
    };
  }
  // suspended, filed (the default path): a durable approval is already filed (WS4 inbox) via
  // runWriteAgent → hub approvals.request.
  return {
    status: "suspended",
    outcome: `suspended for approval — filed ${res.filed.approvalId ?? "(id unknown)"} for ${res.filed.tool} (${res.filed.impact})`,
    errorKind: "approval_required",
    approvalId: res.filed.approvalId ?? undefined,
  };
}

function mapError(err: unknown): FinishGoalPatch {
  const msg = (err as Error)?.message ?? "unknown error";
  const kind = (err as Error)?.constructor?.name ?? "Error";
  const bb = (err as { blackboard?: FinishGoalPatch["blackboard"] })?.blackboard ?? null;
  if (err instanceof GoalBudgetExhaustedError || err instanceof BudgetExhaustedError)
    return { status: "budget_exhausted", outcome: msg, errorKind: kind, blackboard: bb };
  if (err instanceof GoalSuspendedError)
    return { status: "suspended", outcome: msg, errorKind: kind, approvalId: err.approvalId ?? undefined, blackboard: err.blackboard };
  if (err instanceof ApprovalRequiredError)
    return { status: "suspended", outcome: msg, errorKind: kind };
  if (err instanceof UnknownSpecialistError || err instanceof PlannerProtocolError || err instanceof ModelProtocolError || err instanceof ToolNotAllowedError)
    return { status: "failed", outcome: msg, errorKind: kind, blackboard: bb };
  return { status: "failed", outcome: msg, errorKind: "unknown_error", blackboard: bb };
}

/** Synthesize a Step-A trace from a completed AgentRun so write/supervisor runs feed episodic + obs the
 *  same way traceRun-backed specialist runs do (design §3.1 "wire the existing episodic/obs"). */
function traceFromRun(
  runId: string,
  def: AgentDef,
  goal: string,
  envelope: Envelope,
  status: TraceStatus,
  run: AgentRun,
  startedAt: number,
  endedAt: number,
): AgentTrace {
  const toolsCalled = run.steps.filter((s) => s.kind === "tool").map((s) => s.detail.replace(/ (ok|failed)$/, ""));
  return {
    v: 1,
    runId,
    agent: def.name,
    envelope,
    goal,
    status,
    outcome: run.outcome,
    steps: run.steps,
    modelCalls: run.steps.filter((s) => s.kind === "model").length,
    toolCalls: run.steps.filter((s) => s.kind === "tool").length,
    toolsCalled,
    startedAt,
    endedAt,
  };
}

function runInputFromTrace(t: AgentTrace, goalId: string, tenantId: string, provider: string | null): RunInput {
  return {
    runId: t.runId,
    goalId,
    tenantId,
    agent: t.agent,
    status: t.status,
    outcome: t.outcome,
    steps: t.steps,
    modelCalls: t.modelCalls,
    toolCalls: t.toolCalls,
    toolsCalled: t.toolsCalled,
    provider,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S0 (agent event spine, 2026-08-22) — the ONE place `AgentStep`'s in-flight sibling gets persisted.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// `agent.ts` / `orchestrator.ts` / `write-agent.ts` only ever CALL an `EmitStep` — none of them touch
// Postgres (this file's own header: "no direct DB access ... here" is a property of the whole service,
// not just the framework files). This closure is where that boundary is crossed: it owns the per-run
// monotonic `seq` counter the DB's `(run_id, seq)` uniqueness constraint enforces, persists each event,
// and republishes the EXACT persisted row to the in-process SSE bus (`events-bus.ts`) so a live
// subscriber sees the SAME value a `GET /runs/:id/events?since=` poller would.
//
// FAIL-SOFT BY DESIGN: a persistence failure here is caught and logged, never thrown — an agent run must
// never fail, slow, or change behaviour because its OBSERVABILITY write hiccuped. This mirrors every
// other "never blocks a run" boundary in this codebase (D14-12's registry-impact cache, D13's mismatch
// warning): the thing being observed is more important than the observation.
function makeEmitter(
  store: GoalStore,
  ids: { runId: string; goalId: string; tenantId: string; parentRunId?: string | null },
): EmitStep {
  let seq = 0;
  return async (evt) => {
    seq++;
    try {
      const row = await store.insertEvent({
        runId: ids.runId,
        goalId: ids.goalId,
        tenantId: ids.tenantId,
        seq,
        kind: evt.kind,
        detail: evt.detail,
        durationMs: evt.durationMs ?? null,
        parentRunId: ids.parentRunId ?? null,
      });
      publishRunEvent(ids.tenantId, row);
    } catch (err) {
      console.warn(
        `[agent-runner] failed to persist run event (run ${ids.runId} seq ${seq}, kind ${evt.kind}): ` +
          `${(err as Error).message} — the step itself is unaffected, only its event-stream record is lost`,
      );
    }
  };
}

/** S0 — map `orchestrator.ts`'s coarse `SpecialistRunRecord.status` onto the `agent_runs.status`
 *  (`TraceStatus`) vocabulary. The orchestrator only ever knows "ok" or "everything else is data"
 *  (`failed`) — see `SpecialistRunRecord`'s own doc for why it does not attempt a finer classification —
 *  so `"failed"` maps to `unknown_error`, the same catch-all `traceRun`'s `classifyError` uses for a
 *  thrown value it does not recognize. This is a genuine "we know it failed, not exactly how" case, not
 *  a guess dressed up as one of the more specific TraceStatus values. */
function specialistRunStatus(status: SpecialistRunRecord["status"]): TraceStatus {
  return status === "ok" ? "ok" : "unknown_error";
}

export function buildRunnerApp(deps: RunnerDeps): FastifyInstance {
  const cfg = { ...runnerConfig, ...deps.config };
  const store = deps.store;
  const agentDeps = deps.agentDeps;
  const collector = deps.collector ?? new ObservabilityCollector();
  const episodic = deps.episodic;
  const reg = deps.registry ?? defaultRegistry;

  // T2b — two in-memory, per-process maps. NEITHER is agents-DB state (no migration in this ticket);
  // both are exactly as durable as the goal lifecycle they serve, and that is deliberate: a runner
  // restart already kills in-flight/queued goals (`sweepInterrupted` on boot), so losing either map on
  // restart is not a new failure mode — see write-agent.ts's `SuspendedIntent` doc.
  //
  // `goalOptionsById` — the per-goal `fileOnSuspend` request from POST /goals, read once by
  // `processGoal` and then discarded. Only NON-default (`false`) entries are ever stored: every goal
  // that omits the flag (or sends `true`) needs no entry at all, because `processGoal` falls back to
  // `true` when the map has nothing — so a goal that never requested deferred filing costs zero memory
  // here, and the fallback keeps every default-path goal byte-identical even if this map is empty.
  const goalOptionsById = new Map<string, { fileOnSuspend: false }>();
  // `suspendedIntentsById` — populated ONLY when a goal suspends with `filed: null` (T2b's deferred
  // path). `GET /goals/:id` merges an unexpired entry in as `suspendedIntent`; an expired entry is
  // lazily evicted on that same read (no background sweep — see the design's §7.2.3 "lazy reap" idiom,
  // applied here to the analogous in-memory case).
  const suspendedIntentsById = new Map<string, { intent: SuspendedIntent; expiresAt: number }>();
  // S0 (agent event spine) — `activeRunsByGoal`: which run ids are CURRENTLY executing for a goal.
  // EPHEMERAL, per-process, never persisted — same shape as `suspendedIntentsById` above, for the same
  // reason: a runner restart already kills every in-flight run (`sweepInterrupted` on boot), so this map
  // is exactly as durable as the thing it describes.
  //
  // WHY THIS EXISTS: a top-level run's `agent_runs` row (and a supervisor-spawned specialist's) is only
  // inserted once that run ENDS — that was true before this ticket and stays true (additive-only: no
  // existing insert timing changes). So `GET /goals/:id`'s `runs[]` is empty for the ENTIRE duration of a
  // goal's first run, and a client has no way to learn a run's id — the one thing it needs to poll
  // `GET /runs/:id/events` or open the SSE stream — until that run is already over, which defeats the
  // whole purpose of an in-flight endpoint. This map is what `GET /goals/:id` merges in as
  // `activeRunIds`, closing that gap without changing when any row is written.
  const activeRunsByGoal = new Map<string, Set<string>>();
  function trackRunStart(goalId: string, runId: string): void {
    let set = activeRunsByGoal.get(goalId);
    if (!set) {
      set = new Set();
      activeRunsByGoal.set(goalId, set);
    }
    set.add(runId);
  }
  function trackRunEnd(goalId: string, runId: string): void {
    const set = activeRunsByGoal.get(goalId);
    if (!set) return;
    set.delete(runId);
    if (set.size === 0) activeRunsByGoal.delete(goalId);
  }

  const app = Fastify({ logger: fastifyLoggerOption() as never });

  function authorized(req: FastifyRequest): boolean {
    if (!cfg.token) return false; // fail-closed: no token configured ⇒ nothing is callable
    const h = req.headers.authorization ?? "";
    const raw = Array.isArray(h) ? h[0] : h;
    const token = raw?.startsWith("Bearer ") ? raw.slice(7) : "";
    return safeEqual(token, cfg.token);
  }

  async function recordObservation(trace: AgentTrace, tenantId: string, provider: string | null): Promise<void> {
    collector.record(trace, provider ?? undefined);
    if (episodic) await episodic.record(episodeFromTrace(trace, tenantId, provider ?? undefined));
  }

  // The worker: claim → run the PROVEN runner → map its typed outcome → persist. Never re-implements a gate.
  async function processGoal(goalId: string): Promise<void> {
    const g = await store.claimForRun(goalId);
    if (!g) return; // cancelled between enqueue and claim, or already gone — do nothing (no auto re-run)
    const envelope: Envelope = { provider: g.envelopeProvider, externalId: g.envelopeExternalId };
    const startedAt = Date.now();
    // Count actual model/tool calls across the whole run (all paths) for the goal row.
    let modelCalls = 0;
    let toolCalls = 0;
    const counted: AgentDeps = {
      complete: (p) => {
        modelCalls++;
        return agentDeps.complete(p);
      },
      callTool: (n, a, e) => {
        toolCalls++;
        return agentDeps.callTool(n, a, e);
      },
      lastProvider: agentDeps.lastProvider,
      // D14-10: forwarded, not counted. This wrapper replaces the deps for the whole goal, so omitting
      // the optional resolver would silently drop it and every re-run would go back to throw-and-file.
      resolveApproval: agentDeps.resolveApproval,
      // D14-12: same hazard — this wrapper replaces the deps for the whole goal, so omitting the
      // registry-impact reader would silently drop D14-12's reconciliation for every goal run through
      // the service (only direct runAgent()/runWriteAgent() callers that pass agentDeps straight
      // through would keep it).
      getRegistryImpact: agentDeps.getRegistryImpact,
    };
    const provider = cfg.servingProvider ?? agentDeps.lastProvider?.() ?? null;

    let patch: FinishGoalPatch;
    try {
      // D14-14: `envelopeContext` nests INSIDE `tenantContext` — same goal, same lifetime, same
      // per-goal-not-module-level reasoning (see deps.ts's header on `envelopeContext`). This is what
      // lets `liveDeps.resolveApproval` recover the ORIGINAL requester's OBO envelope without agent.ts
      // having to pass it explicitly (D14-10's contract deliberately omits it — see agent.ts's doc).
      patch = await tenantContext.run(g.tenantId, () => envelopeContext.run(envelope, async (): Promise<FinishGoalPatch> => {
        if (g.agent === reg.supervisor.name || g.agent === "supervisor") {
          // S0 — minted BEFORE the run (was: after it finished, purely for the observation record) so
          // the SAME id can tag every in-flight planner/delegate event this goal's supervisor level
          // emits. No behaviour change: it is still exactly one id, used exactly once, for the same
          // purpose it always was — just visible to `runOrchestrator` from the start instead of only to
          // `recordObservation` at the end.
          const runId = randomUUID();
          const emit = makeEmitter(store, { runId, goalId: g.id, tenantId: g.tenantId });
          trackRunStart(g.id, runId);
          let run: Awaited<ReturnType<typeof runOrchestrator>>;
          try {
            run = await runOrchestrator(reg.supervisor, g.goal, envelope, counted, {
              tenantId: g.tenantId,
              servingProvider: provider ?? undefined,
              runId,
              emit,
              delegation: {
                emitFor: (childRunId) => {
                  trackRunStart(g.id, childRunId);
                  return makeEmitter(store, { runId: childRunId, goalId: g.id, tenantId: g.tenantId, parentRunId: runId });
                },
                onSpecialistRun: async (rec) => {
                  // S0 — turns a supervisor-spawned specialist into a REAL `agent_runs` row with a
                  // `parent_run_id` edge, where before this ticket it left only blackboard prose (see
                  // orchestrator.ts's `DelegationTracking` doc). Additive: the supervisor's own goal-level
                  // result below (`status: "ok", blackboard, ...`) is unchanged byte-for-byte by this.
                  trackRunEnd(g.id, rec.runId);
                  const toolsCalled = rec.steps.filter((s) => s.kind === "tool").map((s) => s.detail.replace(/ (ok|failed)$/, ""));
                  await store.insertRun({
                    runId: rec.runId,
                    goalId: g.id,
                    tenantId: g.tenantId,
                    agent: rec.specialist,
                    status: specialistRunStatus(rec.status),
                    outcome: rec.outcome,
                    steps: rec.steps,
                    modelCalls: rec.steps.filter((s) => s.kind === "model").length,
                    toolCalls: rec.steps.filter((s) => s.kind === "tool").length,
                    toolsCalled,
                    provider,
                    startedAt: rec.startedAt,
                    endedAt: rec.endedAt,
                    parentRunId: rec.parentRunId,
                  });
                },
              },
            });
          } finally {
            // Blanket-clear rather than untracking just `runId`: a goal-aborting rethrow
            // (GoalSuspendedError/ApprovalRequiredError/GoalBudgetExhaustedError) skips
            // `onSpecialistRun` by design (see `DelegationTracking`'s doc), which would otherwise leave
            // that child's id "active" forever — nothing for this goal is in flight once the
            // supervisor's own call has returned OR thrown, so the whole set is gone with it.
            activeRunsByGoal.delete(g.id);
          }
          await recordObservation(
            {
              v: 1, runId, agent: reg.supervisor.name, envelope, goal: g.goal, status: "ok",
              outcome: run.outcome, steps: [], modelCalls, toolCalls, toolsCalled: [], startedAt, endedAt: Date.now(),
            },
            g.tenantId,
            provider,
          );
          return { status: "ok", outcome: run.outcome, blackboard: run.blackboard, fanOut: run.blackboard.length };
        }

        const writeDef = reg.writeSpecialists[g.agent];
        if (writeDef) {
          // T2b — read-then-discard: the option is only needed for THIS run, and the map only ever
          // holds `false` entries (see the map's own doc), so `.get(...) ?? true` fallback keeps every
          // default-path goal identical whether or not it was ever inserted.
          const fileOnSuspend = goalOptionsById.get(g.id)?.fileOnSuspend ?? true;
          goalOptionsById.delete(g.id);
          // S0 — minted BEFORE the run (was: after, only when `completed`/`forced_read_only`) so events
          // can stream while the write agent is still executing, including a goal that ends up
          // `suspended` (no `agent_runs` row either way for that outcome — unchanged from before this
          // ticket; only the in-flight EVENTS are new for that path, tagged to a runId with no row).
          const runId = randomUUID();
          const emit = makeEmitter(store, { runId, goalId: g.id, tenantId: g.tenantId });
          trackRunStart(g.id, runId);
          let res: WriteAgentResult;
          try {
            res = await runWriteAgent(writeDef, g.goal, envelope, counted, g.tenantId, provider ?? "echo", { fileOnSuspend, emit });
          } finally {
            trackRunEnd(g.id, runId);
          }
          if (res.status === "suspended" && res.filed === null) {
            // T2b: park the intent (incl. REAL args) in-memory only — never in `patch`/the goal row.
            suspendedIntentsById.set(g.id, { intent: res.intent, expiresAt: Date.now() + cfg.intentTtlMs });
          }
          const mapped = mapWriteResult(res);
          if (res.status === "completed" || res.status === "forced_read_only") {
            const traceStatus: TraceStatus = "ok";
            const trace = traceFromRun(runId, writeDef, g.goal, envelope, traceStatus, res.run, startedAt, Date.now());
            await store.insertRun(runInputFromTrace(trace, g.id, g.tenantId, provider));
            await recordObservation(trace, g.tenantId, provider);
          }
          return mapped;
        }

        const readDef = reg.specialists[g.agent];
        // (agent was validated at POST time; readDef is present here)
        const runId = randomUUID();
        const emit = makeEmitter(store, { runId, goalId: g.id, tenantId: g.tenantId });
        trackRunStart(g.id, runId);
        let trace: AgentTrace;
        try {
          trace = await traceRun(runId, readDef, g.goal, envelope, counted, undefined, emit);
        } finally {
          trackRunEnd(g.id, runId);
        }
        await store.insertRun(runInputFromTrace(trace, g.id, g.tenantId, provider));
        await recordObservation(trace, g.tenantId, provider);
        return mapTrace(trace);
      }));
    } catch (err) {
      patch = mapError(err);
    }
    patch.modelCalls = modelCalls;
    patch.toolCalls = toolCalls;
    patch.fanOut = patch.fanOut ?? (patch.blackboard?.length ?? 0);
    await store.finishGoal(goalId, patch);
  }

  const queue = new GoalQueue(processGoal, { maxConcurrent: cfg.maxConcurrent, maxQueue: cfg.maxQueue });

  // Expose store/queue for tests + graceful shutdown (mirrors knowledge service returning the app).
  app.decorate("goalStore", store);
  app.decorate("goalQueue", queue);

  app.get("/health", async () => ({
    ok: true,
    agents: [...Object.keys(reg.specialists), reg.supervisor.name],
    writeAgents: Object.keys(reg.writeSpecialists),
    queue: queue.size(),
  }));

  app.post<{
    Body: {
      tenantId?: string;
      goal?: string;
      agent?: string;
      envelope?: { provider?: string; externalId?: string };
      requestedBy?: string;
      /** T2b (§7.2.5) — default TRUE (see write-agent.ts's `WriteAgentOptions` doc). Every existing
       *  caller omits this field and keeps today's file-immediately behaviour, byte-for-byte. */
      fileOnSuspend?: boolean;
    };
  }>("/goals", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const b = req.body ?? {};
    const agent = b.agent ?? "supervisor";
    if (!b.tenantId || !UUID_RE.test(b.tenantId)) return reply.code(400).send({ error: "tenantId (uuid) required" });
    if (typeof b.goal !== "string" || b.goal.length < 1 || b.goal.length > 4000)
      return reply.code(400).send({ error: "goal must be 1..4000 chars" });
    const known = agent === "supervisor" || !!reg.writeSpecialists[agent] || !!reg.specialists[agent];
    if (!known) return reply.code(400).send({ error: `unknown agent: ${agent}` });
    if (!b.envelope?.provider || !b.envelope?.externalId)
      return reply.code(400).send({ error: "envelope {provider, externalId} required" });
    if (b.fileOnSuspend !== undefined && typeof b.fileOnSuspend !== "boolean")
      return reply.code(400).send({ error: "fileOnSuspend must be boolean" });

    // Capacity check BEFORE inserting a row — a full queue is a clean 429, no orphaned goal.
    if (queue.size().queued >= cfg.maxQueue) return reply.code(429).send({ error: "goal queue full" });

    const id = await store.insertGoal({
      tenantId: b.tenantId,
      goal: b.goal,
      agent,
      envelopeProvider: b.envelope.provider,
      envelopeExternalId: b.envelope.externalId,
      requestedBy: b.requestedBy,
      budget: budgetForAgent(agent, reg),
    });
    // T2b — only a non-default request costs a map entry (see `goalOptionsById`'s own doc above).
    if (b.fileOnSuspend === false) goalOptionsById.set(id, { fileOnSuspend: false });
    const accepted = queue.enqueue(id);
    if (!accepted) {
      // Lost a race for the last slot — mark the just-inserted goal interrupted so it isn't orphaned.
      goalOptionsById.delete(id); // T2b: never consumed by processGoal — don't leak the entry
      await store.finishGoal(id, { status: "interrupted", outcome: "queue full at enqueue" });
      return reply.code(429).send({ error: "goal queue full" });
    }
    return reply.code(202).send({ id, status: "queued" });
  });

  app.get<{ Querystring: { tenant?: string; limit?: string } }>("/goals", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    const limit = Math.min(Math.max(Number(req.query?.limit ?? 50) || 50, 1), 200);
    return { goals: await store.listGoals(tenant, limit) };
  });

  app.get<{ Params: { id: string }; Querystring: { tenant?: string } }>("/goals/:id", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    const goal = await store.getGoal(req.params.id, tenant);
    if (!goal) return reply.code(404).send({ error: "goal not found" }); // tenant mismatch → 404, no probing
    // T2b — merge the in-memory intent in ONLY after the tenant-scoped lookup above has already
    // succeeded: the map is keyed by goalId alone (no tenant column), so gating on `goal` being
    // non-null first is what stops a wrong-tenant request from ever reaching this lookup at all — the
    // existing 404-before-probing guarantee extends to `suspendedIntent` for free, not by a second check.
    const entry = suspendedIntentsById.get(req.params.id);
    // S0 — ADDITIVE field, always present (unlike `suspendedIntent`, which is omitted when absent): the
    // run ids currently executing for this goal, so a client can discover what to poll/subscribe to
    // WHILE the goal is still running — see `activeRunsByGoal`'s doc for why `runs[]` alone cannot do
    // this. Empty for a queued/terminal goal, same tenant-scoping as everything else on this response
    // (keyed by the ALREADY-tenant-checked goal id above, same guard as `suspendedIntent`'s).
    const activeRunIds = [...(activeRunsByGoal.get(req.params.id) ?? [])];
    if (entry) {
      if (Date.now() < entry.expiresAt) return { ...goal, suspendedIntent: entry.intent, activeRunIds };
      suspendedIntentsById.delete(req.params.id); // lazy TTL eviction — no background sweep (see the map's doc)
    }
    return { ...goal, activeRunIds };
  });

  app.get<{ Params: { id: string }; Querystring: { tenant?: string } }>("/runs/:id", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    const run = await store.getRun(req.params.id, tenant);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });

  // S0 (agent event spine) — the polling half of the pair. `since` is the last `seq` the caller already
  // has; omitted/0 returns the run's whole history so far. See `GoalStore.listEvents`'s doc for why this
  // deliberately does NOT 404 a wrong-tenant or not-yet-existent run the way `GET /runs/:id` does — an
  // in-flight run frequently has no `agent_runs` row yet, and gating this endpoint on one existing would
  // defeat the reason it exists.
  app.get<{ Params: { id: string }; Querystring: { tenant?: string; since?: string } }>("/runs/:id/events", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    const since = Math.max(Number(req.query?.since ?? 0) || 0, 0);
    const events = await store.listEvents(req.params.id, tenant, since);
    return { events };
  });

  // S0 — the live half: SSE modelled on `platform-nest/src/core/portal-stream.controller.ts` (the
  // proven pattern this ticket is told to copy) — same heartbeat interval, same connection-lifetime cap,
  // same `retry:`/`hello`/heartbeat/`bye` frame shapes. It differs in ONE respect the header comment on
  // `events-bus.ts` explains: fan-out is a bare in-process EventEmitter, not Redis, because this service
  // (unlike the portal) runs its whole goal queue in one process today — there is no cross-process
  // "someone else's write" case yet to solve for.
  //
  // Bearer-gated like every other route here, NOT open like `/health`: a raw browser `EventSource`
  // cannot set an Authorization header, so this is reached by a server-side proxy holding the runner
  // token (e.g. a future `platform-ui` route under the single-egress rule) — never directly by a
  // browser. That proxy is explicitly OUT OF SCOPE for this ticket (see the S0 deploy notes).
  app.get<{ Params: { id: string }; Querystring: { tenant?: string; since?: string } }>("/runs/:id/events/stream", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    const runId = req.params.id;
    const since = Math.max(Number(req.query?.since ?? 0) || 0, 0);

    // Tell Fastify this handler owns the response from here on — it must not attempt to serialize or
    // send anything itself once we start writing to `reply.raw` (the documented escape hatch for a
    // hand-rolled streaming response; see Fastify's `reply.hijack()`).
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const write = (line: string): void => {
      if (!raw.destroyed) raw.write(line);
    };

    write(`retry: ${EVENTS_RETRY_MS}\n`);
    write(`event: hello\ndata: ${JSON.stringify({ mode: "live", at: new Date().toISOString() })}\n\n`);

    // Catch-up BEFORE subscribing live: replay whatever is already persisted since `since`, so there is
    // no gap between the history a client already has and the live feed it is about to join. Ordering
    // matters here for the SAME reason `agent.ts` awaits every `emit?.()` call — a client must never see
    // a live event before the backlog that precedes it.
    const backlog = await store.listEvents(runId, tenant, since);
    for (const ev of backlog) write(`event: step\ndata: ${JSON.stringify(ev)}\n\n`);

    const unsubscribe = subscribeTenant(tenant, (row) => {
      if (row.runId !== runId) return; // this bus fans out per-TENANT; filter to the one run requested
      write(`event: step\ndata: ${JSON.stringify(row)}\n\n`);
    });

    const heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), EVENTS_HEARTBEAT_MS);
    heartbeat.unref?.();

    const lifetime = setTimeout(() => {
      write(`event: bye\ndata: ${JSON.stringify({ reason: "rotate" })}\n\n`);
      raw.end();
    }, EVENTS_MAX_CONNECTION_MS);
    lifetime.unref?.();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      unsubscribe();
    };
    raw.on("close", cleanup);
    raw.on("error", cleanup);
  });

  app.post<{ Params: { id: string }; Querystring: { tenant?: string } }>("/goals/:id/cancel", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    const result = await store.cancel(req.params.id, tenant);
    if (result === "not_found") return reply.code(404).send({ error: "goal not found" });
    if (result === "conflict") return reply.code(409).send({ error: "goal not cancellable (already running/finished)" });
    return { id: req.params.id, status: "cancelled" };
  });

  app.get("/metrics/agents", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    return { summary: collector.summary(), alerts: collector.alerts() };
  });

  // ASST-21 — the roster's REAL registry (not a hand-maintained mirror). Bearer-gated like every
  // other route here (not `/health`'s open probe shape) since it names each agent's full tool
  // allow-list, which is more than the bare name list `/health` already exposes publicly.
  // `writeCapable` + `evaledProviders` let the roster panel show honestly whether a specialist's
  // write is currently live (D13) or forced read-only, without the platform having to mirror D13's
  // own enrollment logic.
  app.get("/agents", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const describe = (name: string, def: AgentDef, writeCapable: boolean) => ({
      name,
      tools: Object.keys(def.tools),
      maxSteps: def.maxSteps,
      maxToolCalls: def.maxToolCalls,
      writeCapable,
      evaledProviders: def.evaledProviders ?? [],
    });
    return {
      agents: [
        ...Object.entries(reg.specialists).map(([n, d]) => describe(n, d, false)),
        ...Object.entries(reg.writeSpecialists).map(([n, d]) => describe(n, d, true)),
      ],
      supervisor: { name: reg.supervisor.name, maxSubRuns: reg.supervisor.maxSubRuns, goalBudget: reg.supervisor.goalBudget },
    };
  });

  // ASST-21 — episodic run history, narrowed by the CALLER-SUPPLIED run-id set. This is the only
  // shape that keeps D9.1's tenant pre-filter AND respects that an Episode carries no owner/user
  // column (see episodic.ts's `query` header): the platform already knows, from its own
  // `assistant_handoffs` table, exactly which run ids belong to the requesting user's handoffs — it
  // asks for THOSE, never "give me this tenant's history" unfiltered. An empty/omitted `runIds`
  // returns [] (not the whole tenant's history) — the platform-nest caller always supplies the set.
  app.get<{ Querystring: { tenant?: string; runIds?: string } }>("/episodes", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    if (!episodic?.query) return reply.code(404).send({ error: "episodic store not configured" });
    const runIds = (req.query?.runIds ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const episodes = await episodic.query([tenant], { runIds });
    return { episodes };
  });

  return app;
}

async function start(): Promise<void> {
  const pool = new Pool({ connectionString: runnerConfig.databaseUrl });
  const store = new PgGoalStore(pool, { migrateUrl: runnerConfig.migrateDatabaseUrl });
  await store.init();
  // Boot recovery sweep BEFORE serving: orphaned queued/running goals → interrupted (design §3.2).
  const swept = await store.sweepInterrupted();
  if (swept > 0) console.log(`agent-runner: swept ${swept} orphaned goal(s) to interrupted`);
  // Durable episodic store shares the same DB/pool (design §3.1 "wire the existing episodic").
  const { PgEpisodicStore } = await import("../memory/episodic-pg");
  const episodic = new PgEpisodicStore(pool, { migrateUrl: runnerConfig.migrateDatabaseUrl });
  await episodic.init();
  const app = buildRunnerApp({ store, agentDeps: liveDeps, episodic });
  await app.listen({ port: runnerConfig.port, host: runnerConfig.host });
  // D14-12: start AFTER the listener is up, mirroring mcp-hub's module-tools ordering — a down hub
  // must never block the runner from serving. Retries with backoff until the first success, then
  // refreshes periodically; every run in the meantime falls back to each AgentDef's own label.
  startRegistryImpactBootstrap();
  console.log(`Gaiada agent-runner on :${runnerConfig.port}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
