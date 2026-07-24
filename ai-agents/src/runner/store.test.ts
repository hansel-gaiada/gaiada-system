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
    await pool.query("DROP TABLE IF EXISTS agent_runs, agent_goals CASCADE");
    store = new PgGoalStore(pool);
    await store.init();
  });
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS agent_runs, agent_goals CASCADE");
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
});
