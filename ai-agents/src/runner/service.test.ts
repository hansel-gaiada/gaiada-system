// Agent-runner service — the goal-lifecycle state machine + typed-error→status mapping (design §3.2).
// Runs WITHOUT a DB by injecting an in-memory GoalStore (mirrors the EpisodicStore in-memory-vs-durable
// idiom) and SCRIPTED AgentDeps that drive the real, proven runners (runOrchestrator / runWriteAgent /
// traceRun) to each terminal outcome — the mappings are exercised end-to-end, never re-implemented.
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildRunnerApp, type AgentRegistry } from "./service";
import type {
  GoalStore, GoalInput, GoalRunContext, FinishGoalPatch, GoalListItem, GoalDetail, RunInput, RunRow, CancelResult,
} from "./store";
import { EpisodicStore } from "../memory/episodic";
import { ObservabilityCollector } from "../obs/collector";
import { supervisor as realSupervisor, taskTriager } from "../specialists";
import { tenantContext, envelopeContext } from "../deps";
import type { AgentDef, AgentDeps } from "../agent";
import type { OrchestratorDef } from "../orchestrator";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const TOKEN = "runner-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

// ---- in-memory GoalStore (test double for PgGoalStore) -----------------------------------------
interface Rec extends GoalInput {
  id: string;
  status: GoalListItem["status"];
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  modelCalls: number;
  toolCalls: number;
  fanOut: number;
  blackboard: GoalDetail["blackboard"];
  seq: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

class MemGoalStore implements GoalStore {
  goals = new Map<string, Rec>();
  runs: RunInput[] = [];
  private n = 0;
  async init(): Promise<void> {}
  seed(partial: Partial<Rec> & { status: Rec["status"] }): string {
    const id = randomUUID();
    this.goals.set(id, {
      id, tenantId: TENANT, goal: "g", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
      budget: { modelCalls: 1, toolCalls: 1 }, outcome: null, errorKind: null, approvalId: null,
      modelCalls: 0, toolCalls: 0, fanOut: 0, blackboard: null, seq: this.n++,
      createdAt: new Date().toISOString(), startedAt: null, endedAt: null, ...partial,
    } as Rec);
    return id;
  }
  async insertGoal(input: GoalInput): Promise<string> {
    return this.seed({ ...input, status: "queued" });
  }
  async claimForRun(id: string): Promise<GoalRunContext | null> {
    const g = this.goals.get(id);
    if (!g || g.status !== "queued") return null;
    g.status = "running";
    g.startedAt = new Date().toISOString();
    return {
      id: g.id, tenantId: g.tenantId, goal: g.goal, agent: g.agent,
      envelopeProvider: g.envelopeProvider, envelopeExternalId: g.envelopeExternalId, budget: g.budget,
    };
  }
  async finishGoal(id: string, patch: FinishGoalPatch): Promise<void> {
    const g = this.goals.get(id);
    if (!g) return;
    g.status = patch.status;
    g.outcome = patch.outcome ?? null;
    g.errorKind = patch.errorKind ?? null;
    g.approvalId = patch.approvalId ?? null;
    g.modelCalls = patch.modelCalls ?? 0;
    g.toolCalls = patch.toolCalls ?? 0;
    g.fanOut = patch.fanOut ?? 0;
    g.blackboard = patch.blackboard ?? null;
    g.endedAt = new Date().toISOString();
  }
  async insertRun(run: RunInput): Promise<void> {
    this.runs.push(run);
  }
  private list(g: Rec): GoalListItem {
    return {
      id: g.id, tenantId: g.tenantId, goal: g.goal, agent: g.agent, status: g.status, outcome: g.outcome,
      errorKind: g.errorKind, approvalId: g.approvalId, modelCalls: g.modelCalls, toolCalls: g.toolCalls,
      fanOut: g.fanOut, budget: g.budget, createdAt: g.createdAt, startedAt: g.startedAt, endedAt: g.endedAt,
    };
  }
  async listGoals(tenantId: string, limit: number): Promise<GoalListItem[]> {
    return [...this.goals.values()].filter((g) => g.tenantId === tenantId).sort((a, b) => b.seq - a.seq).slice(0, limit).map((g) => this.list(g));
  }
  async getGoal(id: string, tenantId: string): Promise<GoalDetail | null> {
    const g = this.goals.get(id);
    if (!g || g.tenantId !== tenantId) return null;
    const runs = this.runs.filter((r) => r.goalId === id && r.tenantId === tenantId).map((r) => ({
      runId: r.runId, agent: r.agent, status: r.status, outcome: r.outcome, modelCalls: r.modelCalls,
      toolCalls: r.toolCalls, provider: r.provider, startedAt: r.startedAt, endedAt: r.endedAt,
    }));
    return { ...this.list(g), blackboard: g.blackboard, runs };
  }
  async getRun(runId: string, tenantId: string): Promise<RunRow | null> {
    const r = this.runs.find((x) => x.runId === runId && x.tenantId === tenantId);
    if (!r) return null;
    return {
      runId: r.runId, goalId: r.goalId, tenantId: r.tenantId, agent: r.agent, status: r.status, outcome: r.outcome,
      steps: r.steps, modelCalls: r.modelCalls, toolCalls: r.toolCalls, toolsCalled: r.toolsCalled,
      provider: r.provider, startedAt: r.startedAt, endedAt: r.endedAt,
    };
  }
  async cancel(id: string, tenantId: string): Promise<CancelResult> {
    const g = this.goals.get(id);
    if (!g || g.tenantId !== tenantId) return "not_found";
    if (g.status !== "queued") return "conflict";
    g.status = "cancelled";
    g.endedAt = new Date().toISOString();
    return "cancelled";
  }
  async sweepInterrupted(): Promise<number> {
    let n = 0;
    for (const g of this.goals.values()) if (g.status === "queued" || g.status === "running") { g.status = "interrupted"; n++; }
    return n;
  }
}

// ---- scripted deps ------------------------------------------------------------------------------
// `calls` records every `callTool` invocation (name only, in order) — the D14-14 tests use it as the
// "zero new approval rows" detector (asserting `approvals.request` was never called), mirroring the
// `Harness.calls` idiom `approval-resume.test.ts` already uses for the same purpose.
function scripted(responses: string[], toolResults: Record<string, string> = {}, getRegistryImpact?: AgentDeps["getRegistryImpact"]): AgentDeps & { calls: Array<{ name: string }> } {
  let i = 0;
  const calls: Array<{ name: string }> = [];
  return {
    calls,
    complete: async () => responses[Math.min(i++, responses.length - 1)],
    callTool: async (name) => {
      calls.push({ name });
      return toolResults[name] ?? "ok";
    },
    lastProvider: () => undefined,
    getRegistryImpact,
  };
}

// custom agents for scripted terminal outcomes
const reader: AgentDef = { name: "reader", systemPrompt: "read", tools: { "x.read": "read" }, maxSteps: 2, maxToolCalls: 5 };
const writer: AgentDef = { name: "test-writer", systemPrompt: "write", tools: { "danger.write": "high_write" }, maxSteps: 4, maxToolCalls: 4, evaledProviders: ["echo"] };
// D14-12 — declared LOW; only the hub registry (via getRegistryImpact) makes this dangerous. Used to
// prove the runner's `counted` wrapper in service.ts forwards `getRegistryImpact`, not just resolveApproval.
const writerLowDeclared: AgentDef = { name: "reconcile-writer", systemPrompt: "write", tools: { "maybe.write": "low_write" }, maxSteps: 4, maxToolCalls: 4, evaledProviders: ["echo"] };

function registry(over: Partial<AgentRegistry> = {}): AgentRegistry {
  return {
    supervisor: realSupervisor,
    specialists: { reader },
    writeSpecialists: { "test-writer": writer, "task-triager": taskTriager, "reconcile-writer": writerLowDeclared },
    ...over,
  };
}

let apps: FastifyInstance[] = [];
function build(opts: { deps: AgentDeps; reg?: AgentRegistry; token?: string; servingProvider?: string; maxConcurrent?: number; maxQueue?: number; collector?: ObservabilityCollector; episodic?: EpisodicStore; store?: MemGoalStore }) {
  const store = opts.store ?? new MemGoalStore();
  const app = buildRunnerApp({
    store,
    agentDeps: opts.deps,
    registry: opts.reg ?? registry(),
    collector: opts.collector,
    episodic: opts.episodic,
    config: {
      token: opts.token ?? TOKEN,
      servingProvider: opts.servingProvider,
      maxConcurrent: opts.maxConcurrent ?? 1,
      maxQueue: opts.maxQueue ?? 10,
    },
  });
  apps.push(app);
  return { app, store };
}
async function idle(app: FastifyInstance) {
  await (app as unknown as { goalQueue: { idle(): Promise<void> } }).goalQueue.idle();
}
async function trigger(app: FastifyInstance, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/goals", headers: AUTH, payload: { tenantId: TENANT, envelope: { provider: "platform", externalId: "u1" }, ...body } });
}
async function goalStatus(app: FastifyInstance, id: string, tenant = TENANT) {
  const r = await app.inject({ method: "GET", url: `/goals/${id}?tenant=${tenant}`, headers: AUTH });
  return r;
}

afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

describe("agent-runner service", () => {
  it("auth fail-closed: no token configured ⇒ every token route 401; wrong bearer ⇒ 401", async () => {
    const { app } = build({ deps: scripted(['{"final":"x"}']), token: "" });
    for (const url of ["/goals?tenant=" + TENANT, "/metrics/agents"]) {
      expect((await app.inject({ method: "GET", url, headers: AUTH })).statusCode).toBe(401);
    }
    const { app: app2 } = build({ deps: scripted(['{"final":"x"}']) });
    expect((await app2.inject({ method: "GET", url: "/goals?tenant=" + TENANT, headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    // /health is open
    expect((await app2.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("validates the trigger body (400s)", async () => {
    const { app } = build({ deps: scripted(['{"final":"x"}']) });
    expect((await trigger(app, { tenantId: "not-a-uuid", goal: "hi" })).statusCode).toBe(400);
    expect((await trigger(app, { goal: "" })).statusCode).toBe(400);
    expect((await trigger(app, { goal: "hi", agent: "does-not-exist" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/goals", headers: AUTH, payload: { tenantId: TENANT, goal: "hi" } })).statusCode).toBe(400); // no envelope
  });

  it("ok: a read specialist completes → status ok + a traced run row with transcript", async () => {
    const { app } = build({ deps: scripted(['{"final":"all good"}']) });
    const res = await trigger(app, { goal: "report", agent: "reader" });
    expect(res.statusCode).toBe(202);
    const { id } = res.json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(g.status).toBe("ok");
    expect(g.outcome).toBe("all good");
    expect(g.runs).toHaveLength(1);
    const runId = g.runs[0].runId;
    const run = (await app.inject({ method: "GET", url: `/runs/${runId}?tenant=${TENANT}`, headers: AUTH })).json() as RunRow;
    expect(run.status).toBe("ok");
    expect(run.steps.length).toBeGreaterThan(0);
  });

  it("failed: a tool off the allow-list → status failed + error_kind tool_not_allowed", async () => {
    const { app } = build({ deps: scripted(['{"tool":"evil.delete","args":{}}']) });
    const { id } = (await trigger(app, { goal: "hack", agent: "reader" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(g.status).toBe("failed");
    expect(g.errorKind).toBe("tool_not_allowed");
  });

  it("budget_exhausted: a specialist that never finalizes → status budget_exhausted", async () => {
    const { app } = build({ deps: scripted(['{"tool":"x.read","args":{}}']) }); // always a tool call, never final
    const { id } = (await trigger(app, { goal: "loop", agent: "reader" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(g.status).toBe("budget_exhausted");
    expect(g.errorKind).toBe("budget_exhausted");
  });

  it("forced_read_only (D13): task-triager on an un-evaled provider → status ok + error_kind forced_read_only, NEVER widened", async () => {
    // task-triager.evaledProviders === [] ⇒ no provider is cleared ⇒ writes disabled, surfaced honestly.
    const { app } = build({ deps: scripted(['{"final":"reviewed; nothing to write"}']), servingProvider: undefined });
    const { id } = (await trigger(app, { goal: "triage tasks", agent: "task-triager" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(g.status).toBe("ok");
    expect(g.errorKind).toBe("forced_read_only"); // D13 downgrade is SURFACED, not silently widened
    expect(g.outcome).toContain("writes disabled");
    // the recorded run executed no write tool
    const run = (await app.inject({ method: "GET", url: `/runs/${g.runs[0].runId}?tenant=${TENANT}`, headers: AUTH })).json() as RunRow;
    expect(run.toolsCalled).not.toContain("tasks.update");
  });

  it("suspended (+approval_id): a write specialist hits a high_write → suspended, approval filed", async () => {
    // danger.write is high_write ⇒ ApprovalRequiredError ⇒ runWriteAgent files via hub approvals.request.
    const { app } = build({
      deps: scripted(['{"tool":"danger.write","args":{"x":1}}'], { "approvals.request": '{"id":"appr-1"}' }),
      servingProvider: "echo", // echo is in test-writer.evaledProviders ⇒ D13 gate passes ⇒ reaches D14
    });
    const { id } = (await trigger(app, { goal: "do the write", agent: "test-writer" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(g.status).toBe("suspended");
    expect(g.approvalId).toBe("appr-1");
    expect(g.errorKind).toBe("approval_required");
  });

  it("D14-12: a declared low_write promoted to high_write by the registry still suspends through the runner (proves service.ts's `counted` wrapper forwards getRegistryImpact — the same hazard D14-10 hit with resolveApproval)", async () => {
    const { app } = build({
      deps: scripted(
        ['{"tool":"maybe.write","args":{"x":1}}'],
        { "approvals.request": '{"id":"appr-reconcile"}' },
        (name) => (name === "maybe.write" ? { write: true, impact: "high" } : undefined),
      ),
      servingProvider: "echo",
    });
    const { id } = (await trigger(app, { goal: "maybe write it", agent: "reconcile-writer" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    // If getRegistryImpact were silently dropped by the `counted` wrapper, this agent's declared
    // low_write would run unattended and land `status: "ok"` instead — exactly the drift D14-12 closes.
    expect(g.status).toBe("suspended");
    expect(g.approvalId).toBe("appr-reconcile");
    expect(g.errorKind).toBe("approval_required");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // D14-14 — the resolver survives service.ts's `counted` wrapper (the SAME dep-rebuild hazard D14-10's
  // own comment on `resolveApproval: agentDeps.resolveApproval` above already flags). These prove it by
  // assertion, not by inference: a goal that hits a high_write and gets a decided resolution back
  // actually completes through the REAL HTTP path (`buildRunnerApp` → `processGoal` → the `counted`
  // wrapper → `runWriteAgent`/`runAgent`), and the goal's own envelope/tenantId are genuinely visible to
  // `AgentDeps.resolveApproval` at the moment it is called — proving `envelopeContext`/`tenantContext`
  // are populated by the time the wrapped deps reach the runner, not merely that the field survives.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  it("D14-14: `resolveApproval` reaches the runner THROUGH service.ts's `counted` wrapper, with the goal's own tenantId/envelope visible via context", async () => {
    let consulted = 0;
    let seenTenant: string | undefined;
    let seenProvider: string | undefined;
    const deps = scripted(['{"tool":"danger.write","args":{"x":1}}', '{"final":"done"}'], {});
    deps.resolveApproval = async (input) => {
      consulted++;
      // The counted wrapper must not have dropped tenantContext/envelopeContext visibility either —
      // service.ts opens both around the SAME body that calls runWriteAgent/runOrchestrator.
      seenTenant = tenantContext.getStore();
      seenProvider = envelopeContext.getStore()?.provider;
      expect(input).toEqual({ agentName: "test-writer", toolName: "danger.write", toolArgs: { x: 1 } });
      return { match: "executed", approvalId: "ap-1", consumed: false, result: "done", truncated: false };
    };
    const { app } = build({ deps, servingProvider: "echo" });
    const { id } = (await trigger(app, { goal: "do the write", agent: "test-writer" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(consulted).toBe(1); // reached through the counted wrapper
    expect(seenTenant).toBe(TENANT);
    expect(seenProvider).toBe("platform"); // trigger()'s default envelope
    expect(g.status).toBe("ok"); // completed, not suspended — the write was resumed, not re-filed
    expect(deps.calls.map((c) => c.name)).not.toContain("approvals.request"); // nothing (re-)filed
  });

  // ── the mandated negative (D14-14): hub down ⇒ a loud goal failure, ZERO new approval rows ─────────
  it("D14-14: resolveApproval throwing (hub down) ⇒ the goal FAILS loudly and files NO approval — never treated as `none`", async () => {
    const deps = scripted(['{"tool":"danger.write","args":{"x":1}}'], { "approvals.request": '{"id":"should-never-file"}' });
    deps.resolveApproval = async () => {
      throw new Error("hub unreachable: ECONNREFUSED");
    };
    const { app } = build({ deps, servingProvider: "echo" });
    const { id } = (await trigger(app, { goal: "do the write", agent: "test-writer" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    // Loud failure — NOT "suspended" (which would mean it was treated as if nothing were decided, i.e.
    // the exact fault-to-`none` mapping this ticket forbids) and NOT "ok".
    expect(g.status).toBe("failed");
    expect(g.outcome).toContain("hub unreachable");
    // The zero-new-approval-rows assertion: `approvals.request` was never called despite being
    // available and armed to succeed — a fault during consultation must never fall through to filing.
    expect(deps.calls.map((c) => c.name)).not.toContain("approvals.request");
  });

  it("suspended via supervisor: a delegated write suspends the WHOLE goal (GoalSuspendedError +approval_id, blackboard persisted)", async () => {
    const sup: OrchestratorDef = {
      name: "supervisor", systemPrompt: "sup", specialists: { "test-writer": writer },
      maxPlannerSteps: 5, maxSubRuns: 3, goalBudget: { modelCalls: 20, toolCalls: 20 },
    };
    const { app } = build({
      reg: registry({ supervisor: sup }),
      servingProvider: "echo",
      deps: scripted(
        ['{"assign":{"specialist":"test-writer","task":"write it"}}', '{"tool":"danger.write","args":{}}'],
        { "approvals.request": '{"id":"appr-2"}' },
      ),
    });
    const { id } = (await trigger(app, { goal: "delegate a write", agent: "supervisor" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(g.status).toBe("suspended");
    expect(g.approvalId).toBe("appr-2");
    expect(g.errorKind).toBe("GoalSuspendedError");
  });

  it("budget_exhausted via supervisor: per-goal budget exceeded (GoalBudgetExhaustedError)", async () => {
    const sup: OrchestratorDef = {
      name: "supervisor", systemPrompt: "sup", specialists: { reader },
      maxPlannerSteps: 5, maxSubRuns: 3, goalBudget: { modelCalls: 1, toolCalls: 1 }, // planner uses the 1 model call; specialist run exceeds it
    };
    const { app } = build({
      reg: registry({ supervisor: sup }),
      deps: scripted(['{"assign":{"specialist":"reader","task":"t"}}', '{"final":"x"}']),
    });
    const { id } = (await trigger(app, { goal: "tiny budget", agent: "supervisor" })).json() as { id: string };
    await idle(app);
    const g = (await goalStatus(app, id)).json() as GoalDetail;
    expect(g.status).toBe("budget_exhausted");
    expect(g.errorKind).toBe("GoalBudgetExhaustedError");
  });

  it("tenant mismatch → 404 on goal + run reads (no cross-tenant probing)", async () => {
    const { app } = build({ deps: scripted(['{"final":"ok"}']) });
    const { id } = (await trigger(app, { goal: "report", agent: "reader" })).json() as { id: string };
    await idle(app);
    const mine = (await goalStatus(app, id)).json() as GoalDetail;
    expect((await goalStatus(app, id, OTHER)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/runs/${mine.runs[0].runId}?tenant=${OTHER}`, headers: AUTH })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/runs/${mine.runs[0].runId}?tenant=${TENANT}`, headers: AUTH })).statusCode).toBe(200);
  });

  it("queue full → 429 (bounded FIFO)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps: AgentDeps = { complete: async () => { await gate; return '{"final":"ok"}'; }, callTool: async () => "ok", lastProvider: () => undefined };
    const { app } = build({ deps, maxConcurrent: 1, maxQueue: 1 });
    const r1 = await trigger(app, { goal: "1", agent: "reader" });
    const r2 = await trigger(app, { goal: "2", agent: "reader" });
    const r3 = await trigger(app, { goal: "3", agent: "reader" });
    expect(r1.statusCode).toBe(202);
    expect(r2.statusCode).toBe(202);
    expect(r3.statusCode).toBe(429); // one running + one queued = full
    const health = (await app.inject({ method: "GET", url: "/health" })).json() as { queue: { running: number; queued: number } };
    expect(health.queue).toEqual({ running: 1, queued: 1 });
    release();
    await idle(app);
  });

  it("cancel: queued→cancelled(200); running→409; unknown→404; a cancelled goal is never executed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps: AgentDeps = { complete: async () => { await gate; return '{"final":"ok"}'; }, callTool: async () => "ok", lastProvider: () => undefined };
    const { app, store } = build({ deps, maxConcurrent: 1, maxQueue: 10 });
    const running = ((await trigger(app, { goal: "run", agent: "reader" })).json() as { id: string }).id;
    const queued = ((await trigger(app, { goal: "wait", agent: "reader" })).json() as { id: string }).id;

    // the queued one cancels cleanly; the running one is a conflict; a random id is not_found
    expect((await app.inject({ method: "POST", url: `/goals/${queued}/cancel?tenant=${TENANT}`, headers: AUTH })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/goals/${running}/cancel?tenant=${TENANT}`, headers: AUTH })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/goals/${randomUUID()}/cancel?tenant=${TENANT}`, headers: AUTH })).statusCode).toBe(404);
    // cancelling again is a conflict (no longer queued)
    expect((await app.inject({ method: "POST", url: `/goals/${queued}/cancel?tenant=${TENANT}`, headers: AUTH })).statusCode).toBe(409);

    release();
    await idle(app);
    // the cancelled goal was claimed as null → never ran → status stays cancelled (no outcome written)
    expect(store.goals.get(queued)!.status).toBe("cancelled");
    expect(store.goals.get(running)!.status).toBe("ok");
  });

  it("boot sweep marks orphaned queued/running goals interrupted (no autonomous re-run)", async () => {
    const store = new MemGoalStore();
    store.seed({ status: "queued" });
    store.seed({ status: "running" });
    store.seed({ status: "ok" });
    const swept = await store.sweepInterrupted(); // start() calls exactly this before listen
    expect(swept).toBe(2);
    const statuses = [...store.goals.values()].map((g) => g.status).sort();
    expect(statuses).toEqual(["interrupted", "interrupted", "ok"]);
    // interrupted goals are not re-enqueued and cannot be claimed → deterministically no re-run
    for (const g of store.goals.values()) if (g.status === "interrupted") expect(await store.claimForRun(g.id)).toBeNull();
  });

  it("wires the existing episodic store + observability collector; /metrics/agents reflects runs", async () => {
    const collector = new ObservabilityCollector();
    const episodic = new EpisodicStore();
    const { app } = build({ deps: scripted(['{"final":"done"}']), collector, episodic });
    const { id } = (await trigger(app, { goal: "report", agent: "reader" })).json() as { id: string };
    await idle(app);
    // episodic (durable feed) recorded the run under the tenant
    expect(episodic.query([TENANT]).map((e) => e.agent)).toContain("reader");
    // collector metrics are exposed
    const m = (await app.inject({ method: "GET", url: "/metrics/agents", headers: AUTH })).json() as { summary: Array<{ agent: string; runs: number; ok: number }> };
    const reader = m.summary.find((s) => s.agent === "reader")!;
    expect(reader.runs).toBe(1);
    expect(reader.ok).toBe(1);
    void id;
  });
});
