// WS8 Step D — episodic memory (spec §3, D9). Durable run-history: what the brigade tried, what
// happened, and any human feedback — the trainer's input (Step D). It is a DERIVED, tenant-scoped,
// access-controlled store, so it inherits D9:
//   D9.1 retrieval-time authorization — `query` hard pre-filters by the caller's authorized-tenant-set;
//        an episode outside it is NEVER returned (authorizing the read is not enough).
//   D9.2 source-driven lifecycle — `eraseTenant` HARD-DELETES a tenant's episodes (crypto-shred reach).
//   D9.3 memory integrity — an episode's outcome is AGENT-generated (provenance "agent"); human
//        feedback is provenance "human". UNTRUSTED feedback is quarantined and never treated as signal
//        by the trainer (`trustedFeedback`), so an unverified thumbs-down can't drive self-improvement.
//
// In-memory here (dependency-free + testable). The persistent implementation lives behind the D9 store
// / change-feed — the same schema as the Step-A JSONL trace, so a live run appends episodes directly.
import type { Provenance, Trust } from "../knowledge/store";
import type { AgentStep } from "../agent";
import type { AgentTrace, TraceStatus } from "../evals/trace";

export interface HumanFeedback {
  rating: "up" | "down";
  note?: string;
  provenance: Provenance; // typically "human"
  trust: Trust; // "untrusted" ⇒ quarantined: recorded for audit, never a trainer signal
  at: number;
}

export interface Episode {
  runId: string;
  agent: string;
  tenantId: string;
  goal: string;
  status: TraceStatus;
  outcome: string | null;
  toolsCalled: string[];
  failedTools: string[]; // tools whose execution FAILED (a key trainer signal)
  modelCalls: number;
  toolCalls: number;
  provider?: string; // the serving provider when known (D13 context)
  provenance: Provenance; // "agent" — the run/outcome is agent-generated (down-weighted vs human fact)
  feedback: HumanFeedback[];
  createdAt: number;
}

/** Build an episode from a Step-A trace. Recovers failed tools from the step details. */
export function episodeFromTrace(t: AgentTrace, tenantId: string, provider?: string): Episode {
  const failedTools = t.steps
    .filter((s: AgentStep) => s.kind === "tool" && s.detail.endsWith(" failed"))
    .map((s) => s.detail.replace(/ failed$/, ""));
  return {
    runId: t.runId,
    agent: t.agent,
    tenantId,
    goal: t.goal,
    status: t.status,
    outcome: t.outcome,
    toolsCalled: t.toolsCalled,
    failedTools,
    modelCalls: t.modelCalls,
    toolCalls: t.toolCalls,
    provider,
    provenance: "agent",
    feedback: [],
    createdAt: t.endedAt,
  };
}

/** D9.3 — only TRUSTED feedback is a legitimate trainer signal; untrusted stays quarantined. Shared
 *  by the in-memory and Postgres stores so the rule can't drift between them. */
export function trustedFeedback(e: Episode): HumanFeedback[] {
  return e.feedback.filter((f) => f.trust === "trusted");
}

export class EpisodicStore {
  private episodes: Episode[] = [];

  record(ep: Episode): void {
    this.episodes.push(ep);
  }

  /** D9.1 — hard tenant pre-filter. Only episodes in the caller's authorized-tenant-set are returned. */
  query(tenantSet: string[], filter?: { agent?: string; status?: TraceStatus }): Episode[] {
    const allowed = new Set(tenantSet);
    return this.episodes.filter(
      (e) => allowed.has(e.tenantId) && (!filter?.agent || e.agent === filter.agent) && (!filter?.status || e.status === filter.status),
    );
  }

  addFeedback(runId: string, fb: HumanFeedback): void {
    const e = this.episodes.find((x) => x.runId === runId);
    if (e) e.feedback.push(fb);
  }

  /** D9.3 — only TRUSTED feedback is a legitimate signal; untrusted stays quarantined. */
  trustedFeedback(e: Episode): HumanFeedback[] {
    return trustedFeedback(e);
  }

  /** D9.2 — crypto-shred / erasure reaches this derived store: hard-delete a tenant's episodes. */
  eraseTenant(tenantId: string): number {
    const before = this.episodes.length;
    this.episodes = this.episodes.filter((e) => e.tenantId !== tenantId);
    return before - this.episodes.length;
  }
}
