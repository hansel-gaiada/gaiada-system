// PgGoalStore — durable goal/run store. DB-backed; skips cleanly without a reachable DATABASE_URL_TEST
// (mirrors episodic-pg.test.ts / knowledge/service.test.ts). Proves DDL-on-init, tenant pin on every
// read, atomic claim, cancel semantics, and the boot interrupted-sweep.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { PgGoalStore } from "./store";
import { TEST_DB_URL as url, testDbReachable } from "../knowledge/testdb";

const dbUp = await testDbReachable();
const T_A = "eeeeeeee-0000-4000-8000-000000000001";
const T_B = "eeeeeeee-0000-4000-8000-000000000002";

describe.skipIf(!dbUp)("PgGoalStore (durable)", () => {
  let pool: Pool;
  let store: PgGoalStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS agent_run_events, agent_runs, agent_goals CASCADE");
    store = new PgGoalStore(pool);
    await store.init();
  });
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS agent_run_events, agent_runs, agent_goals CASCADE");
    await pool.end();
  });

  it("insert → get round-trips fields; tenant pin returns null cross-tenant (→ 404)", async () => {
    const id = await store.insertGoal({
      tenantId: T_A, goal: "status please", agent: "supervisor",
      envelopeProvider: "platform", envelopeExternalId: "u1", requestedBy: "u1",
      budget: { modelCalls: 40, toolCalls: 20 },
    });
    const mine = await store.getGoal(id, T_A);
    expect(mine).toMatchObject({ id, goal: "status please", agent: "supervisor", status: "queued" });
    expect(mine!.budget).toEqual({ modelCalls: 40, toolCalls: 20 });
    expect(await store.getGoal(id, T_B)).toBeNull(); // tenant mismatch → null → 404
  });

  it("claimForRun is atomic queued→running and single-winner", async () => {
    const id = await store.insertGoal({
      tenantId: T_A, goal: "g", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
      budget: { modelCalls: 1, toolCalls: 1 },
    });
    const first = await store.claimForRun(id);
    expect(first?.id).toBe(id);
    expect(await store.claimForRun(id)).toBeNull(); // already running — no second run
    await store.finishGoal(id, { status: "ok", outcome: "done", modelCalls: 2, toolCalls: 1, fanOut: 1 });
    const g = await store.getGoal(id, T_A);
    expect(g).toMatchObject({ status: "ok", outcome: "done", modelCalls: 2, fanOut: 1 });
  });

  it("insertRun + getRun carries the transcript, tenant-pinned", async () => {
    const goalId = await store.insertGoal({
      tenantId: T_A, goal: "g", agent: "status-reporter", envelopeProvider: "platform", envelopeExternalId: "u1",
      budget: { modelCalls: 8, toolCalls: 6 },
    });
    await store.insertRun({
      runId: "run-1", goalId, tenantId: T_A, agent: "status-reporter", status: "ok", outcome: "ok",
      steps: [{ kind: "model", detail: "thinking" }, { kind: "tool", detail: "projects.list ok" }],
      modelCalls: 2, toolCalls: 1, toolsCalled: ["projects.list"], provider: "echo", startedAt: 1, endedAt: 2,
    });
    const run = await store.getRun("run-1", T_A);
    expect(run!.steps).toHaveLength(2);
    expect(run!.toolsCalled).toEqual(["projects.list"]);
    expect(await store.getRun("run-1", T_B)).toBeNull(); // tenant pin
    const detail = await store.getGoal(goalId, T_A);
    expect(detail!.runs.map((r) => r.runId)).toEqual(["run-1"]);
  });

  it("cancel: queued→cancelled; running→conflict; unknown→not_found", async () => {
    const id = await store.insertGoal({
      tenantId: T_A, goal: "g", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
      budget: { modelCalls: 1, toolCalls: 1 },
    });
    expect(await store.cancel(id, T_A)).toBe("cancelled");
    expect(await store.cancel(id, T_A)).toBe("conflict"); // now cancelled, not queued
    expect(await store.cancel("eeeeeeee-0000-4000-8000-0000000000ff", T_A)).toBe("not_found");
    const running = await store.insertGoal({
      tenantId: T_A, goal: "g", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
      budget: { modelCalls: 1, toolCalls: 1 },
    });
    await store.claimForRun(running);
    expect(await store.cancel(running, T_A)).toBe("conflict"); // running is not cancellable here
  });

  it("boot sweep marks orphaned queued/running goals interrupted (no auto re-run)", async () => {
    await pool.query("DELETE FROM agent_runs; DELETE FROM agent_goals");
    const queued = await store.insertGoal({
      tenantId: T_A, goal: "q", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
      budget: { modelCalls: 1, toolCalls: 1 },
    });
    const running = await store.insertGoal({
      tenantId: T_A, goal: "r", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
      budget: { modelCalls: 1, toolCalls: 1 },
    });
    await store.claimForRun(running);
    expect(await store.sweepInterrupted()).toBe(2);
    expect((await store.getGoal(queued, T_A))!.status).toBe("interrupted");
    expect((await store.getGoal(running, T_A))!.status).toBe("interrupted");
    // interrupted goals cannot be claimed → deterministically no autonomous re-run
    expect(await store.claimForRun(queued)).toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // S0 (agent event spine, 2026-08-22) — agent_run_events + agent_runs.parent_run_id.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  describe("S0: agent_run_events (append-only, in-flight)", () => {
    it("insertEvent -> listEvents round-trips fields and returns them in ascending seq order", async () => {
      const goalId = await store.insertGoal({
        tenantId: T_A, goal: "g", agent: "reader", envelopeProvider: "platform", envelopeExternalId: "u1",
        budget: { modelCalls: 4, toolCalls: 4 },
      });
      const runId = "run-events-1";
      const e1 = await store.insertEvent({ runId, goalId, tenantId: T_A, seq: 1, kind: "model", detail: "thinking", durationMs: 12 });
      const e2 = await store.insertEvent({ runId, goalId, tenantId: T_A, seq: 2, kind: "tool", detail: "x.read ok", durationMs: 34, parentRunId: "sup-1" });
      expect(e1.eventId).toBeTruthy();
      expect(e1.ts).toBeTruthy();
      expect(e2.parentRunId).toBe("sup-1");

      const events = await store.listEvents(runId, T_A, 0);
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
      expect(events[0]).toMatchObject({ kind: "model", detail: "thinking", durationMs: 12, parentRunId: null });
      expect(events[1]).toMatchObject({ kind: "tool", detail: "x.read ok", durationMs: 34, parentRunId: "sup-1" });
    });

    it("listEvents(since) returns only events strictly after the given seq — the poll/catch-up contract", async () => {
      const goalId = await store.insertGoal({
        tenantId: T_A, goal: "g", agent: "reader", envelopeProvider: "platform", envelopeExternalId: "u1",
        budget: { modelCalls: 4, toolCalls: 4 },
      });
      const runId = "run-events-2";
      for (let seq = 1; seq <= 4; seq++) {
        await store.insertEvent({ runId, goalId, tenantId: T_A, seq, kind: "model", detail: `step ${seq}` });
      }
      expect((await store.listEvents(runId, T_A, 0)).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect((await store.listEvents(runId, T_A, 2)).map((e) => e.seq)).toEqual([3, 4]);
      expect(await store.listEvents(runId, T_A, 4)).toEqual([]);
    });

    it("(run_id, seq) is uniquely constrained — a caller bug that reuses a seq is a loud DB error, never a silent overwrite", async () => {
      const goalId = await store.insertGoal({
        tenantId: T_A, goal: "g", agent: "reader", envelopeProvider: "platform", envelopeExternalId: "u1",
        budget: { modelCalls: 4, toolCalls: 4 },
      });
      const runId = "run-events-dup-seq";
      await store.insertEvent({ runId, goalId, tenantId: T_A, seq: 1, kind: "model", detail: "first" });
      await expect(store.insertEvent({ runId, goalId, tenantId: T_A, seq: 1, kind: "model", detail: "second" })).rejects.toThrow();
    });

    it("listEvents is tenant-filtered at the SQL level: a wrong-tenant read is an EMPTY list, never another tenant's rows", async () => {
      const goalId = await store.insertGoal({
        tenantId: T_A, goal: "g", agent: "reader", envelopeProvider: "platform", envelopeExternalId: "u1",
        budget: { modelCalls: 4, toolCalls: 4 },
      });
      const runId = "run-events-tenant";
      await store.insertEvent({ runId, goalId, tenantId: T_A, seq: 1, kind: "model", detail: "mine" });
      expect(await store.listEvents(runId, T_B, 0)).toEqual([]); // wrong tenant → empty, not a leak
      expect((await store.listEvents(runId, T_A, 0)).length).toBe(1); // right tenant → the real row
    });

    it("events survive with no corresponding agent_runs row — the in-flight case (no FK to agent_runs)", async () => {
      // A supervisor's own planner-step events are tagged with a run id that is often never inserted
      // into agent_runs at all (orchestrator.ts's DelegationTracking doc). Prove the table accepts that.
      const goalId = await store.insertGoal({
        tenantId: T_A, goal: "g", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
        budget: { modelCalls: 20, toolCalls: 10 },
      });
      const supervisorRunId = "sup-no-row";
      await store.insertEvent({ runId: supervisorRunId, goalId, tenantId: T_A, seq: 1, kind: "delegate", detail: "assign reader: x" });
      expect(await store.getRun(supervisorRunId, T_A)).toBeNull(); // no agent_runs row for the supervisor level
      expect((await store.listEvents(supervisorRunId, T_A, 0)).length).toBe(1); // the event is still there
    });
  });

  describe("S0: agent_runs.parent_run_id (delegation edge)", () => {
    it("insertRun persists parentRunId, and it round-trips via both getRun and getGoal's runs[]", async () => {
      const goalId = await store.insertGoal({
        tenantId: T_A, goal: "g", agent: "supervisor", envelopeProvider: "platform", envelopeExternalId: "u1",
        budget: { modelCalls: 20, toolCalls: 10 },
      });
      await store.insertRun({
        runId: "child-run-1", goalId, tenantId: T_A, agent: "status-reporter", status: "ok", outcome: "done",
        steps: [{ kind: "model", detail: "thinking" }], modelCalls: 1, toolCalls: 0, toolsCalled: [],
        provider: "echo", startedAt: 1, endedAt: 2, parentRunId: "supervisor-run-1",
      });
      const run = await store.getRun("child-run-1", T_A);
      expect(run!.parentRunId).toBe("supervisor-run-1");
      const detail = await store.getGoal(goalId, T_A);
      expect(detail!.runs[0].parentRunId).toBe("supervisor-run-1");
    });

    it("a run with no parent (every run before this ticket, and every non-delegated run since) persists parentRunId: null", async () => {
      const goalId = await store.insertGoal({
        tenantId: T_A, goal: "g", agent: "reader", envelopeProvider: "platform", envelopeExternalId: "u1",
        budget: { modelCalls: 4, toolCalls: 4 },
      });
      await store.insertRun({
        runId: "top-level-run-1", goalId, tenantId: T_A, agent: "reader", status: "ok", outcome: "done",
        steps: [], modelCalls: 0, toolCalls: 0, toolsCalled: [], provider: "echo", startedAt: 1, endedAt: 2,
      });
      const run = await store.getRun("top-level-run-1", T_A);
      expect(run!.parentRunId).toBeNull();
    });
  });

  it("init() is idempotent against a PRE-S0 agent_runs table (no parent_run_id, no agent_run_events) — the upgrade path", async () => {
    const legacyPool = new Pool({ connectionString: url });
    try {
      await legacyPool.query("DROP TABLE IF EXISTS agent_run_events, agent_runs, agent_goals CASCADE");
      // Recreate the EXACT pre-S0 shape (copied from this file's own DDL, minus parent_run_id/the
      // events table) to prove `init()` upgrades an existing deployment in place rather than assuming a
      // fresh database.
      await legacyPool.query(`
        CREATE TABLE agent_goals (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, goal text NOT NULL,
          agent text NOT NULL DEFAULT 'supervisor', envelope_provider text NOT NULL,
          envelope_external_id text NOT NULL, requested_by text, status text NOT NULL DEFAULT 'queued',
          outcome text, error_kind text, approval_id text, model_calls int NOT NULL DEFAULT 0,
          tool_calls int NOT NULL DEFAULT 0, budget jsonb, fan_out int NOT NULL DEFAULT 0,
          blackboard jsonb, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, ended_at timestamptz
        );
        CREATE TABLE agent_runs (
          run_id text PRIMARY KEY, goal_id uuid NOT NULL REFERENCES agent_goals(id) ON DELETE CASCADE,
          tenant_id uuid NOT NULL, agent text NOT NULL, status text NOT NULL, outcome text,
          steps jsonb NOT NULL DEFAULT '[]', model_calls int NOT NULL DEFAULT 0, tool_calls int NOT NULL DEFAULT 0,
          tools_called text[] NOT NULL DEFAULT '{}', provider text, started_at bigint NOT NULL DEFAULT 0,
          ended_at bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const preexistingGoalId = (
        await legacyPool.query<{ id: string }>(
          `INSERT INTO agent_goals (tenant_id, goal, envelope_provider, envelope_external_id) VALUES ($1,'legacy','platform','u1') RETURNING id`,
          [T_A],
        )
      ).rows[0].id;
      await legacyPool.query(
        `INSERT INTO agent_runs (run_id, goal_id, tenant_id, agent, status, steps) VALUES ('legacy-run', $1, $2, 'reader', 'ok', '[]')`,
        [preexistingGoalId, T_A],
      );

      const upgraded = new PgGoalStore(legacyPool);
      await upgraded.init(); // must not throw against the pre-S0 shape

      // The pre-existing row survived the upgrade with parent_run_id defaulting to NULL.
      const legacyRun = await upgraded.getRun("legacy-run", T_A);
      expect(legacyRun!.parentRunId).toBeNull();

      // The new table is now usable.
      await upgraded.insertEvent({ runId: "legacy-run", goalId: preexistingGoalId, tenantId: T_A, seq: 1, kind: "model", detail: "post-upgrade" });
      expect((await upgraded.listEvents("legacy-run", T_A, 0)).length).toBe(1);
    } finally {
      await legacyPool.query("DROP TABLE IF EXISTS agent_run_events, agent_runs, agent_goals CASCADE");
      await legacyPool.end();
    }
  });
});
