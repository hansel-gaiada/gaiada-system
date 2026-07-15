// WS9 bridge: the WS8 agent-run signal → OpenTelemetry. The in-memory ObservabilityCollector
// (collector.ts) stays the source of truth for per-agent quality; this mirrors its rollup as OTel
// observable gauges so the WS9 dashboards/SLOs and Alertmanager can read agent quality alongside
// service metrics (spec §6: "Everything traced → WS9"). Attach it wherever a persistent collector
// lives (a long-running agent runtime); observable gauges re-read the collector on each collection.
//
// No-op when OTEL is disabled (the API returns a no-op meter), so wiring it is always safe.
import { metrics } from "@opentelemetry/api";
import type { ObservabilityCollector, AlertPolicy } from "./collector";
import { DEFAULT_ALERT_POLICY } from "./collector";

// registerCollectorGauges installs observable gauges backed by `collector`. `evaledProviders` (agent
// → cleared providers) enables the D13 detective gauge; omit to skip it. Returns nothing — the
// callback lives for the process lifetime (matching how a collector is a process singleton).
export function registerCollectorGauges(
  collector: ObservabilityCollector,
  opts: { policy?: AlertPolicy; evaledProviders?: Record<string, string[]> } = {},
): void {
  const meter = metrics.getMeter("gaiada/ai-agents");
  const policy = opts.policy ?? DEFAULT_ALERT_POLICY;

  const runs = meter.createObservableGauge("agent_runs_total", {
    description: "Runs recorded per agent (cumulative in the collector's window)",
  });
  const successRate = meter.createObservableGauge("agent_success_rate", {
    description: "ok / runs per agent",
  });
  const avgDuration = meter.createObservableGauge("agent_avg_duration_ms", {
    description: "Average run duration per agent",
    unit: "ms",
  });
  const alerts = meter.createObservableGauge("agent_quality_alert", {
    description: "1 per firing quality alert (low_success / high_refusal), labeled by agent+kind",
  });
  const unevaledWrites = meter.createObservableGauge("agent_writes_on_unevaled_provider", {
    description: "D13 detective control: runs that wrote while served by a non-eval-cleared provider",
  });

  meter.addBatchObservableCallback(
    (observer) => {
      for (const m of collector.summary()) {
        observer.observe(runs, m.runs, { agent: m.agent });
        observer.observe(successRate, m.successRate, { agent: m.agent });
        observer.observe(avgDuration, m.avgDurationMs, { agent: m.agent });
      }
      for (const a of collector.alerts(policy)) {
        observer.observe(alerts, 1, { agent: a.agent, kind: a.kind });
      }
      if (opts.evaledProviders) {
        observer.observe(unevaledWrites, collector.writesOnUnevaledProvider(opts.evaledProviders).length);
      }
    },
    [runs, successRate, avgDuration, alerts, unevaledWrites],
  );
}
