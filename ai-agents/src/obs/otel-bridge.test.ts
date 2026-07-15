// WS9 — the collector→OTel bridge: verifies the agent-run rollup is exported as real metric
// datapoints (using an SDK MeterProvider + ManualReader so we can force a collection and inspect it).
import { describe, it, expect } from "vitest";
import { MeterProvider, PeriodicExportingMetricReader, InMemoryMetricExporter, AggregationTemporality } from "@opentelemetry/sdk-metrics";
import { metrics } from "@opentelemetry/api";
import { ObservabilityCollector } from "./collector";
import { registerCollectorGauges } from "./otel-bridge";
import type { AgentTrace, TraceStatus } from "../evals/trace";

let clock = 0;
function trace(agent: string, status: TraceStatus): AgentTrace {
  clock += 10;
  return {
    v: 1,
    runId: `r-${clock}`,
    agent,
    envelope: { provider: "telegram", externalId: "tg:1" },
    goal: "g",
    status,
    outcome: status === "ok" ? "done" : status,
    steps: [{ kind: "model", detail: "{...}" }],
    modelCalls: 1,
    toolCalls: 0,
    toolsCalled: [],
    startedAt: clock,
    endedAt: clock + 5,
  };
}

describe("WS9 collector→OTel bridge", () => {
  it("exports per-agent gauges backed by the live collector", async () => {
    // Large interval so the periodic push never races our manual collect().
    const reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      exportIntervalMillis: 600000,
    });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);

    const collector = new ObservabilityCollector();
    registerCollectorGauges(collector);

    // Two ok, one error for "reporter" ⇒ success rate 2/3.
    collector.record(trace("reporter", "ok"));
    collector.record(trace("reporter", "ok"));
    collector.record(trace("reporter", "budget_exhausted"));

    const collected = await reader.collect();
    const byName = new Map<string, unknown>();
    for (const scope of collected.resourceMetrics.scopeMetrics) {
      for (const m of scope.metrics) byName.set(m.descriptor.name, m);
    }

    expect(byName.has("agent_runs_total")).toBe(true);
    expect(byName.has("agent_success_rate")).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runs = byName.get("agent_runs_total") as any;
    const reporterRuns = runs.dataPoints.find((d: any) => d.attributes.agent === "reporter");
    expect(reporterRuns.value).toBe(3);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sr = byName.get("agent_success_rate") as any;
    const reporterSr = sr.dataPoints.find((d: any) => d.attributes.agent === "reporter");
    expect(reporterSr.value).toBeCloseTo(2 / 3, 5);

    await provider.shutdown();
  });
});
