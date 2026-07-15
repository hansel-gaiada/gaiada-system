// WS8 Step D — the DURABLE episodic store proves the same D9 invariants as the in-memory one, now in
// Postgres. DB-backed; skips cleanly without a reachable DATABASE_URL_TEST.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { PgEpisodicStore } from "./episodic-pg";
import { episodeFromTrace } from "./episodic";
import { TEST_DB_URL as url, testDbReachable } from "../knowledge/testdb";
import type { AgentTrace } from "../evals/trace";

const dbUp = await testDbReachable();
const T_A = "dddddddd-0000-4000-8000-000000000001";
const T_B = "dddddddd-0000-4000-8000-000000000002";

function trace(runId: string, agent: string, over: Partial<AgentTrace> = {}): AgentTrace {
  return {
    v: 1, runId, agent, envelope: { provider: "telegram", externalId: "tg:1" }, goal: "g",
    status: "ok", outcome: "done",
    steps: [{ kind: "tool", detail: "tasks.update failed" }],
    modelCalls: 1, toolCalls: 1, toolsCalled: ["tasks.update"], startedAt: 1, endedAt: 2, ...over,
  };
}

describe.skipIf(!dbUp)("PgEpisodicStore (durable, D9)", () => {
  let pool: Pool;
  let store: PgEpisodicStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query("DROP TABLE IF EXISTS agent_episodes, agent_episode_feedback");
    store = new PgEpisodicStore(pool);
    await store.init();
    await store.record(episodeFromTrace(trace("r1", "task-triager"), T_A, "gemini"));
    await store.record(episodeFromTrace(trace("r2", "task-triager", { status: "protocol_error" }), T_A));
    await store.record(episodeFromTrace(trace("r3", "status-reporter"), T_B));
  });
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS agent_episodes, agent_episode_feedback");
    await pool.end();
  });

  it("record round-trips fields incl. failed tools + provider; upsert is idempotent", async () => {
    const [e] = await store.query([T_A], { agent: "task-triager", status: "ok" });
    expect(e).toMatchObject({ runId: "r1", provider: "gemini", provenance: "agent" });
    expect(e.failedTools).toEqual(["tasks.update"]);
    await store.record(episodeFromTrace(trace("r1", "task-triager"), T_A, "gemini")); // re-record
    expect((await store.query([T_A], { status: "ok" })).filter((x) => x.runId === "r1")).toHaveLength(1);
  });

  it("D9.1: query hard pre-filters by tenant set", async () => {
    expect((await store.query([T_A])).map((e) => e.runId).sort()).toEqual(["r1", "r2"]);
    expect((await store.query([T_B])).map((e) => e.runId)).toEqual(["r3"]);
    expect(await store.query([])).toEqual([]);
  });

  it("D9.3: feedback persists; only trusted is a signal", async () => {
    await store.addFeedback("r1", { rating: "down", provenance: "external", trust: "untrusted", at: 1 });
    await store.addFeedback("r1", { rating: "up", provenance: "human", trust: "trusted", at: 2 });
    const e = (await store.query([T_A], { agent: "task-triager", status: "ok" }))[0];
    expect(e.feedback).toHaveLength(2);
    expect(store.trustedFeedback(e).map((f) => f.rating)).toEqual(["up"]);
  });

  it("D9.2: eraseTenant hard-deletes episodes + their feedback", async () => {
    expect(await store.eraseTenant(T_A)).toBe(2);
    expect(await store.query([T_A])).toEqual([]);
    // feedback for the erased runs is gone too
    const orphan = await pool.query(`SELECT count(*)::int AS n FROM agent_episode_feedback WHERE run_id = 'r1'`);
    expect(orphan.rows[0].n).toBe(0);
  });
});
