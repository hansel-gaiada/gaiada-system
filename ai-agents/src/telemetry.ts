// WS9 OpenTelemetry bootstrap for the AI-agents / knowledge service (ESM). Its own per-service
// module — no shared telemetry package. Import FIRST in any entrypoint (knowledge/service.ts, cli.ts)
// so auto-instrumentation patches http/pg before they load. Fail-soft: starts ONLY when OTEL_ENABLED;
// unset ⇒ runs bare (dev/tests). Endpoint + service name via standard OTEL_* env vars.
import { trace, context } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

export function otelEnabled(): boolean {
  const v = process.env.OTEL_ENABLED;
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

process.env.OTEL_SERVICE_NAME ||= "ai-agents";

if (otelEnabled()) {
  try {
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 15000,
      }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
    const shutdown = (): void => {
      void sdk.shutdown().finally(() => process.exit(0));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    // eslint-disable-next-line no-console
    console.log(`[telemetry] OTel started for ${process.env.OTEL_SERVICE_NAME}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[telemetry] OTel init failed (continuing without it):", (err as Error).message);
  }
}

// fastifyLoggerOption: pino JSON with trace correlation when OTEL is on, else `false` (preserving the
// knowledge service's current logger:false default for the test oracle).
export function fastifyLoggerOption(): unknown {
  if (!otelEnabled()) return false;
  return {
    level: process.env.LOG_LEVEL ?? "info",
    mixin(): Record<string, string> {
      const span = trace.getSpan(context.active());
      if (!span) return {};
      const sc = span.spanContext();
      return { trace_id: sc.traceId, span_id: sc.spanId };
    },
  };
}
