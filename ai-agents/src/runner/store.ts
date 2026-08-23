// Agent-runner goal/run store (B1, design §3.1). Postgres-backed goal + run tables created by the
// runner's owner-DSN init() DDL — EXACTLY like PgEpisodicStore / knowledge/service.ts (tables live in
// gaiada_knowledge; init-cluster.sh default-grants new owner-created tables to knowledge_app, so no
// migration and no new DB role is needed). Same conventions: pool + init() DDL, optional owner
// migrateUrl. Tenant is pinned on EVERY read (getGoal/getRun/listGoals) — a wrong tenant returns null,
// never another tenant's row (no cross-tenant id probing, design §4).
import { Pool } from "pg";
import type { BlackboardEntry } from "../orchestrator";
import type { AgentStep } from "../agent";
import type { TraceStatus } from "../evals/trace";

/** Goal lifecycle status (design §3.1). */
export type GoalStatus =
  | "queued"
  | "running"
  | "ok"
  | "suspended"
  | "budget_exhausted"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface BudgetCaps {
  modelCalls: number;
  toolCalls: number;
}

/** What POST /goals persists for a new (queued) goal. */
export interface GoalInput {
  tenantId: string;
  goal: string;
  agent: string;
  envelopeProvider: string;
  envelopeExternalId: string;
  requestedBy?: string;
  budget: BudgetCaps;
}

/** The minimum a worker needs to execute a claimed goal (no PII beyond the goal text + envelope). */
export interface GoalRunContext {
  id: string;
  tenantId: string;
  goal: string;
  agent: string;
  envelopeProvider: string;
  envelopeExternalId: string;
  budget: BudgetCaps;
}

/** The patch a finished goal writes back (the typed-outcome → status mapping result). */
export interface FinishGoalPatch {
  status: GoalStatus;
  outcome?: string | null;
  errorKind?: string | null;
  approvalId?: string | null;
  modelCalls?: number;
  toolCalls?: number;
  fanOut?: number;
  blackboard?: BlackboardEntry[] | null;
}

/** List item — never carries the blackboard or step transcripts. */
export interface GoalListItem {
  id: string;
  tenantId: string;
  goal: string;
  agent: string;
  status: GoalStatus;
  outcome: string | null;
  errorKind: string | null;
  approvalId: string | null;
  modelCalls: number;
  toolCalls: number;
  fanOut: number;
  budget: BudgetCaps | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface RunSummary {
  runId: string;
  agent: string;
  status: TraceStatus;
  outcome: string | null;
  modelCalls: number;
  toolCalls: number;
  provider: string | null;
  startedAt: number;
  endedAt: number;
  /** S0 — see `RunInput.parentRunId`'s doc. `null` for every run before this ticket and for every
   *  top-level (non-delegated) run since. */
  parentRunId: string | null;
}

/** Full goal detail: list fields + blackboard + run summaries (design §3.2 GET /goals/:id). */
export interface GoalDetail extends GoalListItem {
  blackboard: BlackboardEntry[] | null;
  runs: RunSummary[];
}

export interface RunInput {
  runId: string;
  goalId: string;
  tenantId: string;
  agent: string;
  status: TraceStatus;
  outcome: string | null;
  steps: AgentStep[];
  modelCalls: number;
  toolCalls: number;
  toolsCalled: string[];
  provider: string | null;
  startedAt: number;
  endedAt: number;
  /** S0 (agent event spine) — the run that spawned this one, when one did. Populated by
   *  `runner/service.ts` from `orchestrator.ts`'s `DelegationTracking.onSpecialistRun` for a
   *  supervisor-spawned specialist; `null`/omitted for every top-level (non-delegated) run, byte-
   *  identical to before this column existed. NOT a foreign key: a supervisor's own "run" is a logical
   *  id (see `agent_run_events.parent_run_id`'s doc) that may never itself become an `agent_runs` row. */
  parentRunId?: string | null;
}

/** Full run incl. the step transcript (design §3.2 GET /runs/:id). */
export interface RunRow extends RunSummary {
  goalId: string;
  tenantId: string;
  steps: AgentStep[];
  toolsCalled: string[];
  parentRunId: string | null;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// S0 (agent event spine, 2026-08-22) — `agent_run_events`: append-only, per-step, IN-FLIGHT.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above this block (`agent_goals`, `agent_runs`) is written ONCE, after a run/goal ends —
// exactly the gap the S0 spec exists to close ("steps[] is serialised once, after the run ends;
// nothing is emitted in flight"). This table is written ONE ROW PER STEP BOUNDARY, as it happens, by
// `runner/service.ts`'s emitter closures (see `agent.ts`'s `EmitStep`) — so a client polling
// `GET /runs/:id/events?since=<seq>` or holding the SSE stream open sees progress WHILE the goal is
// still `running`, not only once it reaches a terminal status.
//
// `run_id` is a plain `text` column, deliberately NOT a foreign key to `agent_runs(run_id)`: a
// supervisor's own planner-step/delegate events are tagged with a run id that is often never inserted
// into `agent_runs` at all (see `orchestrator.ts`'s `DelegationTracking` doc — only specialist sub-runs
// get a persisted `agent_runs` row; the supervisor level does not). Requiring the FK would silently drop
// exactly the events this table exists to carry.
//
// Append-only: this store exposes `insertEvent` and `listEvents` only — no update, no delete. That is
// an application-layer guarantee here (matching every other table this file owns, all created via
// owner-DSN inline DDL, not a migration); a stricter guarantee (REVOKE UPDATE, DELETE at the DB role
// level) is a natural follow-up for the DB seat and is called out in the S0 deploy notes rather than
// improvised here.
export type RunEventKind = "model" | "tool" | "delegate" | "approval_wait" | "error";

export interface RunEventInput {
  runId: string;
  goalId: string;
  tenantId: string;
  /** Monotonic per `run_id`, assigned by the caller (a per-run in-memory counter — see
   *  `runner/service.ts`'s `makeEmitter`). The DB enforces uniqueness of `(run_id, seq)`, so a caller
   *  bug that reuses a seq is a loud constraint violation, never a silent overwrite (append-only). */
  seq: number;
  kind: RunEventKind;
  detail: string;
  durationMs?: number | null;
  parentRunId?: string | null;
}

/** `insertEvent` returns the persisted row (DB-assigned `eventId`/`ts` included) so the caller can
 *  publish the EXACT stored values to the SSE bus — one source of truth, no clock drift between the
 *  DB's `now()` and the process's `Date.now()`. */
export interface RunEventRow extends RunEventInput {
  eventId: string;
  ts: string;
}

export type CancelResult = "cancelled" | "not_found" | "conflict";

/** The store contract the runner service depends on. PgGoalStore is the durable impl; tests inject an
 *  in-memory one (mirrors the EpisodicStore / PgEpisodicStore in-memory-vs-durable idiom). */
export interface GoalStore {
  init(): Promise<void>;
  insertGoal(input: GoalInput): Promise<string>;
  /** Atomic queued→running claim. Returns null if the goal is no longer queued (e.g. cancelled) —
   *  the worker then does nothing, so a cancel between enqueue and claim is race-safe. */
  claimForRun(id: string): Promise<GoalRunContext | null>;
  finishGoal(id: string, patch: FinishGoalPatch): Promise<void>;
  insertRun(run: RunInput): Promise<void>;
  listGoals(tenantId: string, limit: number): Promise<GoalListItem[]>;
  getGoal(id: string, tenantId: string): Promise<GoalDetail | null>;
  getRun(runId: string, tenantId: string): Promise<RunRow | null>;
  cancel(id: string, tenantId: string): Promise<CancelResult>;
  /** Boot recovery sweep: orphaned queued/running goals → interrupted (design §3.2; no auto re-run). */
  sweepInterrupted(): Promise<number>;
  /** S0 — append one in-flight step event. Returns the persisted row (see `RunEventRow`'s doc). Never
   *  throws by contract from the CALLER's perspective in practice — `runner/service.ts`'s emitter wraps
   *  every call in try/catch so a transient DB error degrades to "this one step wasn't recorded",
   *  never to a failed or slowed agent run — but the store method itself propagates faithfully so a
   *  caller that wants to know CAN. */
  insertEvent(event: RunEventInput): Promise<RunEventRow>;
  /** S0 — events for one run, strictly after `sinceSeq`, ascending. Tenant-filtered at the SQL level
   *  (`WHERE tenant_id=$2`), so a wrong-tenant or nonexistent `runId` reads as an EMPTY list rather than
   *  the 404 `getRun`/`getGoal` give for the same case — see this file's `RunEventInput` doc for why: an
   *  in-flight run often has no `agent_runs` row yet, so gating this on one existing would defeat the
   *  entire point of an in-flight endpoint. This is a deliberate, narrow deviation from the "wrong
   *  tenant → null → 404" convention used everywhere else in this file; it leaks no cross-tenant data
   *  (the row is never returned), only the same-shaped "nothing here" a legitimate empty backlog gives. */
  listEvents(runId: string, tenantId: string, sinceSeq: number): Promise<RunEventRow[]>;
}

interface GoalDbRow {
  id: string;
  tenant_id: string;
  goal: string;
  agent: string;
  status: GoalStatus;
  outcome: string | null;
  error_kind: string | null;
  approval_id: string | null;
  model_calls: number;
  tool_calls: number;
  budget: BudgetCaps | null;
  fan_out: number;
  blackboard: BlackboardEntry[] | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

function listItem(r: GoalDbRow): GoalListItem {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    goal: r.goal,
    agent: r.agent,
    status: r.status,
    outcome: r.outcome,
    errorKind: r.error_kind,
    approvalId: r.approval_id,
    modelCalls: r.model_calls,
    toolCalls: r.tool_calls,
    fanOut: r.fan_out,
    budget: r.budget,
    createdAt: r.created_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

/** Quote a Postgres identifier for interpolation. Role names come from `SELECT current_user`, not
 *  user input, but an identifier still cannot be parameterised in a GRANT/REVOKE — so it is quoted
 *  properly rather than concatenated raw. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export class PgGoalStore implements GoalStore {
  private migrateUrl: string;
  constructor(
    private pool: Pool,
    opts: { migrateUrl?: string } = {},
  ) {
    this.migrateUrl = opts.migrateUrl ?? "";
  }

  async init(): Promise<void> {
    const ddl = this.migrateUrl ? new Pool({ connectionString: this.migrateUrl }) : this.pool;
    try {
      await ddl.query(`
        CREATE TABLE IF NOT EXISTS agent_goals (
          id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id            uuid NOT NULL,
          goal                 text NOT NULL,
          agent                text NOT NULL DEFAULT 'supervisor',
          envelope_provider    text NOT NULL,
          envelope_external_id text NOT NULL,
          requested_by         text,
          status               text NOT NULL DEFAULT 'queued',
          outcome              text,
          error_kind           text,
          approval_id          text,
          model_calls          int NOT NULL DEFAULT 0,
          tool_calls           int NOT NULL DEFAULT 0,
          budget               jsonb,
          fan_out              int NOT NULL DEFAULT 0,
          blackboard           jsonb,
          created_at           timestamptz NOT NULL DEFAULT now(),
          started_at           timestamptz,
          ended_at             timestamptz
        );
        CREATE INDEX IF NOT EXISTS idx_agent_goals_tenant ON agent_goals (tenant_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS agent_runs (
          run_id       text PRIMARY KEY,
          goal_id      uuid NOT NULL REFERENCES agent_goals(id) ON DELETE CASCADE,
          tenant_id    uuid NOT NULL,
          agent        text NOT NULL,
          status       text NOT NULL,
          outcome      text,
          steps        jsonb NOT NULL DEFAULT '[]',
          model_calls  int NOT NULL DEFAULT 0,
          tool_calls   int NOT NULL DEFAULT 0,
          tools_called text[] NOT NULL DEFAULT '{}',
          provider     text,
          started_at   bigint NOT NULL DEFAULT 0,
          ended_at     bigint NOT NULL DEFAULT 0,
          created_at   timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS idx_agent_runs_goal   ON agent_runs (goal_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_tenant ON agent_runs (tenant_id, created_at DESC);

        -- S0 (agent event spine, 2026-08-22) — additive: a pre-existing agent_runs table (every
        -- environment before this ticket) gets the column added; a fresh one gets it from CREATE TABLE
        -- above. Nullable, no default beyond NULL — a run with no parent is unchanged.
        ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id text;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs (parent_run_id);

        -- S0 — append-only step events. See this file's RunEventInput doc for why run_id/parent_run_id
        -- are plain text, not foreign keys.
        CREATE TABLE IF NOT EXISTS agent_run_events (
          event_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          run_id        text NOT NULL,
          goal_id       uuid NOT NULL,
          tenant_id     uuid NOT NULL,
          seq           int NOT NULL,
          ts            timestamptz NOT NULL DEFAULT now(),
          kind          text NOT NULL,
          detail        text,
          duration_ms   int,
          parent_run_id text
        );
        -- Uniqueness on (run_id, seq) is the monotonic-seq guarantee at the DB layer: the caller's
        -- in-memory counter is trusted to increment, but a bug that reuses one is a loud constraint
        -- violation here, never a silent duplicate/overwrite (append-only).
        CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_events_run_seq ON agent_run_events (run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_agent_run_events_goal_ts ON agent_run_events (goal_id, ts);
      `);

      // APPEND-ONLY, ENFORCED BY THE DATABASE — not merely by the fact that no code path issues an
      // UPDATE or DELETE today. This table is an audit trail: its whole value is that a row, once
      // written, is what happened. "We don't write that query" is a convention one future
      // refactor away from being false, and the failure is silent — a rewritten event reads
      // exactly like a real one.
      //
      // Only applied when `migrateUrl` is set, i.e. when DDL and runtime are genuinely DIFFERENT
      // roles. With a single shared role the REVOKE would strip the emitter's own ability to write
      // and the spine would fail closed on the first step. Better to leave the guarantee at the
      // application layer in that configuration and say so, than to break the runner in dev.
      //
      // The runtime role is READ from the runtime pool rather than hardcoded — the connection
      // string is deployment config, and a hardcoded role name would silently target the wrong
      // grantee (or none) the moment it changed.
      if (this.migrateUrl) {
        const { rows } = await this.pool.query<{ role: string }>("SELECT current_user AS role");
        const runtimeRole = rows[0]?.role;
        if (runtimeRole) {
          await ddl.query(`REVOKE UPDATE, DELETE ON agent_run_events FROM ${quoteIdent(runtimeRole)}`);
        }
      }
    } finally {
      if (ddl !== this.pool) await ddl.end();
    }
  }

  async insertGoal(input: GoalInput): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO agent_goals (tenant_id, goal, agent, envelope_provider, envelope_external_id, requested_by, budget)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id`,
      [
        input.tenantId,
        input.goal,
        input.agent,
        input.envelopeProvider,
        input.envelopeExternalId,
        input.requestedBy ?? null,
        JSON.stringify(input.budget),
      ],
    );
    return rows[0].id;
  }

  async claimForRun(id: string): Promise<GoalRunContext | null> {
    const { rows } = await this.pool.query<GoalDbRow>(
      `UPDATE agent_goals SET status='running', started_at=now()
       WHERE id=$1 AND status='queued'
       RETURNING id, tenant_id, goal, agent, envelope_provider, envelope_external_id, budget`,
      [id],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as unknown as {
      id: string; tenant_id: string; goal: string; agent: string;
      envelope_provider: string; envelope_external_id: string; budget: BudgetCaps | null;
    };
    return {
      id: r.id,
      tenantId: r.tenant_id,
      goal: r.goal,
      agent: r.agent,
      envelopeProvider: r.envelope_provider,
      envelopeExternalId: r.envelope_external_id,
      budget: r.budget ?? { modelCalls: 0, toolCalls: 0 },
    };
  }

  async finishGoal(id: string, patch: FinishGoalPatch): Promise<void> {
    await this.pool.query(
      `UPDATE agent_goals SET
         status=$2, outcome=$3, error_kind=$4, approval_id=$5,
         model_calls=$6, tool_calls=$7, fan_out=$8,
         blackboard=$9::jsonb, ended_at=now()
       WHERE id=$1`,
      [
        id,
        patch.status,
        patch.outcome ?? null,
        patch.errorKind ?? null,
        patch.approvalId ?? null,
        patch.modelCalls ?? 0,
        patch.toolCalls ?? 0,
        patch.fanOut ?? 0,
        patch.blackboard ? JSON.stringify(patch.blackboard) : null,
      ],
    );
  }

  async insertRun(run: RunInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_runs
         (run_id, goal_id, tenant_id, agent, status, outcome, steps, model_calls, tool_calls, tools_called, provider, started_at, ended_at, parent_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (run_id) DO NOTHING`,
      [
        run.runId,
        run.goalId,
        run.tenantId,
        run.agent,
        run.status,
        run.outcome,
        JSON.stringify(run.steps),
        run.modelCalls,
        run.toolCalls,
        run.toolsCalled,
        run.provider,
        run.startedAt,
        run.endedAt,
        run.parentRunId ?? null,
      ],
    );
  }

  async insertEvent(e: RunEventInput): Promise<RunEventRow> {
    const { rows } = await this.pool.query<{
      event_id: string; run_id: string; goal_id: string; tenant_id: string; seq: number;
      ts: string; kind: string; detail: string | null; duration_ms: number | null; parent_run_id: string | null;
    }>(
      `INSERT INTO agent_run_events (run_id, goal_id, tenant_id, seq, kind, detail, duration_ms, parent_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING event_id, run_id, goal_id, tenant_id, seq, ts, kind, detail, duration_ms, parent_run_id`,
      [e.runId, e.goalId, e.tenantId, e.seq, e.kind, e.detail, e.durationMs ?? null, e.parentRunId ?? null],
    );
    const r = rows[0];
    return {
      eventId: r.event_id, runId: r.run_id, goalId: r.goal_id, tenantId: r.tenant_id, seq: r.seq,
      ts: r.ts, kind: r.kind as RunEventKind, detail: r.detail ?? "", durationMs: r.duration_ms, parentRunId: r.parent_run_id,
    };
  }

  async listEvents(runId: string, tenantId: string, sinceSeq: number): Promise<RunEventRow[]> {
    const { rows } = await this.pool.query<{
      event_id: string; run_id: string; goal_id: string; tenant_id: string; seq: number;
      ts: string; kind: string; detail: string | null; duration_ms: number | null; parent_run_id: string | null;
    }>(
      `SELECT event_id, run_id, goal_id, tenant_id, seq, ts, kind, detail, duration_ms, parent_run_id
       FROM agent_run_events WHERE run_id=$1 AND tenant_id=$2 AND seq>$3 ORDER BY seq ASC`,
      [runId, tenantId, sinceSeq],
    );
    return rows.map((r) => ({
      eventId: r.event_id, runId: r.run_id, goalId: r.goal_id, tenantId: r.tenant_id, seq: r.seq,
      ts: r.ts, kind: r.kind as RunEventKind, detail: r.detail ?? "", durationMs: r.duration_ms, parentRunId: r.parent_run_id,
    }));
  }

  async listGoals(tenantId: string, limit: number): Promise<GoalListItem[]> {
    const { rows } = await this.pool.query<GoalDbRow>(
      `SELECT id, tenant_id, goal, agent, status, outcome, error_kind, approval_id,
              model_calls, tool_calls, budget, fan_out, NULL::jsonb AS blackboard,
              created_at, started_at, ended_at
       FROM agent_goals WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map(listItem);
  }

  async getGoal(id: string, tenantId: string): Promise<GoalDetail | null> {
    const { rows } = await this.pool.query<GoalDbRow>(
      `SELECT * FROM agent_goals WHERE id=$1 AND tenant_id=$2`,
      [id, tenantId],
    );
    if (rows.length === 0) return null; // tenant mismatch or absent → 404 (no cross-tenant probing)
    const runs = await this.runSummaries(id, tenantId);
    return { ...listItem(rows[0]), blackboard: rows[0].blackboard, runs };
  }

  private async runSummaries(goalId: string, tenantId: string): Promise<RunSummary[]> {
    const { rows } = await this.pool.query<{
      run_id: string; agent: string; status: string; outcome: string | null;
      model_calls: number; tool_calls: number; provider: string | null;
      started_at: string; ended_at: string; parent_run_id: string | null;
    }>(
      `SELECT run_id, agent, status, outcome, model_calls, tool_calls, provider, started_at, ended_at, parent_run_id
       FROM agent_runs WHERE goal_id=$1 AND tenant_id=$2 ORDER BY created_at`,
      [goalId, tenantId],
    );
    return rows.map((r) => ({
      runId: r.run_id,
      agent: r.agent,
      status: r.status as TraceStatus,
      outcome: r.outcome,
      modelCalls: r.model_calls,
      toolCalls: r.tool_calls,
      provider: r.provider,
      startedAt: Number(r.started_at),
      endedAt: Number(r.ended_at),
      parentRunId: r.parent_run_id,
    }));
  }

  async getRun(runId: string, tenantId: string): Promise<RunRow | null> {
    const { rows } = await this.pool.query<{
      run_id: string; goal_id: string; tenant_id: string; agent: string; status: string;
      outcome: string | null; steps: AgentStep[]; model_calls: number; tool_calls: number;
      tools_called: string[]; provider: string | null; started_at: string; ended_at: string;
      parent_run_id: string | null;
    }>(
      `SELECT * FROM agent_runs WHERE run_id=$1 AND tenant_id=$2`,
      [runId, tenantId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      runId: r.run_id,
      goalId: r.goal_id,
      tenantId: r.tenant_id,
      agent: r.agent,
      status: r.status as TraceStatus,
      outcome: r.outcome,
      steps: r.steps ?? [],
      modelCalls: r.model_calls,
      toolCalls: r.tool_calls,
      toolsCalled: r.tools_called,
      provider: r.provider,
      startedAt: Number(r.started_at),
      endedAt: Number(r.ended_at),
      parentRunId: r.parent_run_id,
    };
  }

  async cancel(id: string, tenantId: string): Promise<CancelResult> {
    const r = await this.pool.query(
      `UPDATE agent_goals SET status='cancelled', ended_at=now()
       WHERE id=$1 AND tenant_id=$2 AND status='queued'`,
      [id, tenantId],
    );
    if ((r.rowCount ?? 0) === 1) return "cancelled";
    const exists = await this.pool.query(`SELECT 1 FROM agent_goals WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
    return (exists.rowCount ?? 0) === 0 ? "not_found" : "conflict";
  }

  async sweepInterrupted(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE agent_goals SET status='interrupted', ended_at=now() WHERE status IN ('queued','running')`,
    );
    return r.rowCount ?? 0;
  }
}
