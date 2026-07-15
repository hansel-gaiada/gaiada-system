// WS8 Step D — the DURABLE episodic store. `EpisodicStore` (in-memory) is the fast/test default; this
// is its Postgres-backed counterpart so run history + human feedback survive restarts and actually feed
// the trainer over time. Same D9 invariants, now enforced in SQL:
//   D9.1 — `query` hard pre-filters by the authorized-tenant-set (tenant_id = ANY).
//   D9.2 — `eraseTenant` hard-deletes (crypto-shred reach).
//   D9.3 — feedback carries provenance/trust; `trustedFeedback` is the only signal the trainer may use.
// Mirrors the KnowledgeStore convention (pool + init() DDL, optional owner migrateUrl).
import { Pool } from "pg";
import type { Episode, HumanFeedback } from "./episodic";
import { trustedFeedback } from "./episodic";
import type { TraceStatus } from "../evals/trace";

export class PgEpisodicStore {
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
        CREATE TABLE IF NOT EXISTS agent_episodes (
          run_id text PRIMARY KEY,
          agent text NOT NULL,
          tenant_id uuid NOT NULL,
          goal text NOT NULL,
          status text NOT NULL,
          outcome text,
          tools_called text[] NOT NULL DEFAULT '{}',
          failed_tools text[] NOT NULL DEFAULT '{}',
          model_calls int NOT NULL DEFAULT 0,
          tool_calls int NOT NULL DEFAULT 0,
          provider text,
          provenance text NOT NULL DEFAULT 'agent',
          ended_at bigint NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS agent_episode_feedback (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          run_id text NOT NULL,
          rating text NOT NULL,
          note text,
          provenance text NOT NULL,
          trust text NOT NULL,
          at bigint NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_episodes_tenant ON agent_episodes (tenant_id, agent);
        CREATE INDEX IF NOT EXISTS idx_agent_episode_feedback_run ON agent_episode_feedback (run_id);
      `);
    } finally {
      if (ddl !== this.pool) await ddl.end();
    }
  }

  /** Upsert an episode (idempotent on run_id — re-recording a run replaces it). */
  async record(ep: Episode): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_episodes
         (run_id, agent, tenant_id, goal, status, outcome, tools_called, failed_tools, model_calls, tool_calls, provider, provenance, ended_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (run_id) DO UPDATE SET
         agent=$2, tenant_id=$3, goal=$4, status=$5, outcome=$6, tools_called=$7, failed_tools=$8,
         model_calls=$9, tool_calls=$10, provider=$11, provenance=$12, ended_at=$13`,
      [ep.runId, ep.agent, ep.tenantId, ep.goal, ep.status, ep.outcome, ep.toolsCalled, ep.failedTools,
       ep.modelCalls, ep.toolCalls, ep.provider ?? null, ep.provenance, ep.createdAt],
    );
  }

  /** D9.1 — hard tenant pre-filter. Loads each episode's feedback too. */
  async query(tenantSet: string[], filter?: { agent?: string; status?: TraceStatus }): Promise<Episode[]> {
    if (tenantSet.length === 0) return [];
    const { rows } = await this.pool.query<{
      run_id: string; agent: string; tenant_id: string; goal: string; status: string; outcome: string | null;
      tools_called: string[]; failed_tools: string[]; model_calls: number; tool_calls: number;
      provider: string | null; provenance: string; ended_at: string;
    }>(
      `SELECT * FROM agent_episodes
       WHERE tenant_id = ANY($1::uuid[])
         AND ($2::text IS NULL OR agent = $2)
         AND ($3::text IS NULL OR status = $3)
       ORDER BY ended_at`,
      [tenantSet, filter?.agent ?? null, filter?.status ?? null],
    );
    if (rows.length === 0) return [];
    const fb = await this.pool.query<{ run_id: string; rating: string; note: string | null; provenance: string; trust: string; at: string }>(
      `SELECT run_id, rating, note, provenance, trust, at FROM agent_episode_feedback WHERE run_id = ANY($1::text[])`,
      [rows.map((r) => r.run_id)],
    );
    const byRun = new Map<string, HumanFeedback[]>();
    for (const f of fb.rows) {
      const list = byRun.get(f.run_id) ?? byRun.set(f.run_id, []).get(f.run_id)!;
      list.push({ rating: f.rating as "up" | "down", note: f.note ?? undefined, provenance: f.provenance as HumanFeedback["provenance"], trust: f.trust as HumanFeedback["trust"], at: Number(f.at) });
    }
    return rows.map((r) => ({
      runId: r.run_id, agent: r.agent, tenantId: r.tenant_id, goal: r.goal,
      status: r.status as TraceStatus, outcome: r.outcome,
      toolsCalled: r.tools_called, failedTools: r.failed_tools,
      modelCalls: r.model_calls, toolCalls: r.tool_calls, provider: r.provider ?? undefined,
      provenance: r.provenance as Episode["provenance"], feedback: byRun.get(r.run_id) ?? [],
      createdAt: Number(r.ended_at),
    }));
  }

  async addFeedback(runId: string, fb: HumanFeedback): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_episode_feedback (run_id, rating, note, provenance, trust, at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [runId, fb.rating, fb.note ?? null, fb.provenance, fb.trust, fb.at],
    );
  }

  /** D9.3 — same rule as the in-memory store: only trusted feedback is a signal. */
  trustedFeedback(e: Episode): HumanFeedback[] {
    return trustedFeedback(e);
  }

  /** D9.2 — hard-delete a tenant's episodes + their feedback. */
  async eraseTenant(tenantId: string): Promise<number> {
    await this.pool.query(
      `DELETE FROM agent_episode_feedback WHERE run_id IN (SELECT run_id FROM agent_episodes WHERE tenant_id = $1)`,
      [tenantId],
    );
    const r = await this.pool.query(`DELETE FROM agent_episodes WHERE tenant_id = $1`, [tenantId]);
    return r.rowCount ?? 0;
  }
}
