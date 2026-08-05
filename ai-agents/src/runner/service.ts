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
} from "../agent";
import {
  runOrchestrator,
  UnknownSpecialistError,
  GoalBudgetExhaustedError,
  GoalSuspendedError,
  PlannerProtocolError,
  type OrchestratorDef,
} from "../orchestrator";
import { runWriteAgent, type WriteAgentResult } from "../write-agent";
import { traceRun, type AgentTrace, type TraceStatus } from "../evals/trace";
import { specialists, writeSpecialists, supervisor } from "../specialists";
import { ObservabilityCollector } from "../obs/collector";
import { episodeFromTrace, type Episode } from "../memory/episodic";
import { liveDeps, tenantContext, envelopeContext, startRegistryImpactBootstrap } from "../deps";
import { PgGoalStore, type GoalStore, type FinishGoalPatch, type BudgetCaps, type RunInput } from "./store";
import { GoalQueue } from "./queue";

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
};

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** A minimal episodic sink both EpisodicStore (in-memory) and PgEpisodicStore satisfy. */
export interface EpisodicSink {
  record(ep: Episode): void | Promise<void>;
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
  // suspended: a durable approval is already filed (WS4 inbox) via runWriteAgent → hub approvals.request.
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

export function buildRunnerApp(deps: RunnerDeps): FastifyInstance {
  const cfg = { ...runnerConfig, ...deps.config };
  const store = deps.store;
  const agentDeps = deps.agentDeps;
  const collector = deps.collector ?? new ObservabilityCollector();
  const episodic = deps.episodic;
  const reg = deps.registry ?? defaultRegistry;

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
          const run = await runOrchestrator(reg.supervisor, g.goal, envelope, counted, {
            tenantId: g.tenantId,
            servingProvider: provider ?? undefined,
          });
          const runId = randomUUID();
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
          const res = await runWriteAgent(writeDef, g.goal, envelope, counted, g.tenantId, provider ?? "echo");
          const mapped = mapWriteResult(res);
          if (res.status === "completed" || res.status === "forced_read_only") {
            const traceStatus: TraceStatus = "ok";
            const runId = randomUUID();
            const trace = traceFromRun(runId, writeDef, g.goal, envelope, traceStatus, res.run, startedAt, Date.now());
            await store.insertRun(runInputFromTrace(trace, g.id, g.tenantId, provider));
            await recordObservation(trace, g.tenantId, provider);
          }
          return mapped;
        }

        const readDef = reg.specialists[g.agent];
        // (agent was validated at POST time; readDef is present here)
        const runId = randomUUID();
        const trace = await traceRun(runId, readDef, g.goal, envelope, counted);
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
    const accepted = queue.enqueue(id);
    if (!accepted) {
      // Lost a race for the last slot — mark the just-inserted goal interrupted so it isn't orphaned.
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
    return goal;
  });

  app.get<{ Params: { id: string }; Querystring: { tenant?: string } }>("/runs/:id", async (req, reply) => {
    if (!authorized(req)) return reply.code(401).send({ error: "unauthorized" });
    const tenant = req.query?.tenant;
    if (!tenant || !UUID_RE.test(tenant)) return reply.code(400).send({ error: "tenant (uuid) required" });
    const run = await store.getRun(req.params.id, tenant);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
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
