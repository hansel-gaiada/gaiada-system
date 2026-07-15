// WS9 — observability collector. The consumer of the Step-A trace schema (`evals/trace.ts`): it
// ingests agent-run traces and turns them into per-agent metrics, provider attribution, and quality
// alerts (task-success / refusal-rate / hallucination-proxy monitoring, spec §6). Dependency-free +
// in-memory here, so it runs anywhere; a live deployment points a sink at durable storage / a
// dashboard, but the record + metric shape is the stable contract.
//
// It also closes a DETECTIVE half of the D13 failover gate: `writesOnUnevaledProvider` flags any run
// that PERFORMED a write while served by a provider not eval-cleared for that agent — complementing
// the preventive gate in `write-agent.ts` with after-the-fact attribution (now possible because the
// Gateway reports the served provider).
import type { AgentStep } from "../agent";
import type { AgentTrace, TraceStatus } from "../evals/trace";

export interface RunRecord {
  runId: string;
  agent: string;
  status: TraceStatus;
  provider?: string;
  modelCalls: number;
  toolCalls: number;
  toolsCalled: string[];
  failedTools: string[];
  durationMs: number;
  endedAt: number;
}

export interface AgentMetrics {
  agent: string;
  runs: number;
  ok: number;
  successRate: number; // ok / runs
  byStatus: Record<string, number>;
  byProvider: Record<string, number>;
  toolFailures: Record<string, number>;
  avgModelCalls: number;
  avgToolCalls: number;
  avgDurationMs: number;
}

export interface AlertPolicy {
  minSuccessRate: number; // below ⇒ alert (task-success monitoring)
  maxRefusalRate: number; // (tool_not_allowed + protocol_error) / runs above ⇒ alert
  minRuns: number; // don't alert on thin evidence
}

export const DEFAULT_ALERT_POLICY: AlertPolicy = { minSuccessRate: 0.7, maxRefusalRate: 0.3, minRuns: 5 };

export interface Alert {
  agent: string;
  kind: "low_success" | "high_refusal";
  value: number;
  threshold: number;
}

function failedToolsOf(steps: AgentStep[]): string[] {
  return steps.filter((s) => s.kind === "tool" && s.detail.endsWith(" failed")).map((s) => s.detail.replace(/ failed$/, ""));
}

export class ObservabilityCollector {
  private records: RunRecord[] = [];

  /** Record a run from its trace. `provider` is the Gateway-reported served provider, when known. */
  record(trace: AgentTrace, provider?: string): RunRecord {
    const rec: RunRecord = {
      runId: trace.runId,
      agent: trace.agent,
      status: trace.status,
      provider,
      modelCalls: trace.modelCalls,
      toolCalls: trace.toolCalls,
      toolsCalled: trace.toolsCalled,
      failedTools: failedToolsOf(trace.steps),
      durationMs: Math.max(0, trace.endedAt - trace.startedAt),
      endedAt: trace.endedAt,
    };
    this.records.push(rec);
    return rec;
  }

  all(): RunRecord[] {
    return this.records;
  }

  recent(limit = 20, filter?: { agent?: string; status?: TraceStatus }): RunRecord[] {
    return this.records
      .filter((r) => (!filter?.agent || r.agent === filter.agent) && (!filter?.status || r.status === filter.status))
      .slice()
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, limit);
  }

  agentMetrics(agent: string): AgentMetrics {
    const rs = this.records.filter((r) => r.agent === agent);
    const byStatus: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    const toolFailures: Record<string, number> = {};
    let model = 0;
    let tool = 0;
    let dur = 0;
    for (const r of rs) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      if (r.provider) byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
      for (const t of r.failedTools) toolFailures[t] = (toolFailures[t] ?? 0) + 1;
      model += r.modelCalls;
      tool += r.toolCalls;
      dur += r.durationMs;
    }
    const runs = rs.length;
    const ok = byStatus["ok"] ?? 0;
    return {
      agent,
      runs,
      ok,
      successRate: runs ? ok / runs : 0,
      byStatus,
      byProvider,
      toolFailures,
      avgModelCalls: runs ? model / runs : 0,
      avgToolCalls: runs ? tool / runs : 0,
      avgDurationMs: runs ? dur / runs : 0,
    };
  }

  /** Per-agent metrics for every agent seen. */
  summary(): AgentMetrics[] {
    return [...new Set(this.records.map((r) => r.agent))].map((a) => this.agentMetrics(a));
  }

  /** Quality alerts (spec §6): agents below the success floor or above the refusal ceiling. */
  alerts(policy: AlertPolicy = DEFAULT_ALERT_POLICY): Alert[] {
    const out: Alert[] = [];
    for (const m of this.summary()) {
      if (m.runs < policy.minRuns) continue;
      if (m.successRate < policy.minSuccessRate) out.push({ agent: m.agent, kind: "low_success", value: m.successRate, threshold: policy.minSuccessRate });
      const refusals = (m.byStatus["tool_not_allowed"] ?? 0) + (m.byStatus["protocol_error"] ?? 0);
      const refusalRate = m.runs ? refusals / m.runs : 0;
      if (refusalRate > policy.maxRefusalRate) out.push({ agent: m.agent, kind: "high_refusal", value: refusalRate, threshold: policy.maxRefusalRate });
    }
    return out;
  }

  /** D13 detective control: runs that EXECUTED a write while served by a provider not eval-cleared
   *  for that agent. `evaledProviders` maps agent → its cleared providers. */
  writesOnUnevaledProvider(evaledProviders: Record<string, string[]>): RunRecord[] {
    return this.records.filter((r) => {
      if (!r.provider || r.toolsCalled.length === 0) return false;
      const cleared = evaledProviders[r.agent] ?? [];
      return !cleared.includes(r.provider);
    });
  }
}
