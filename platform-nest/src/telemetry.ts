// WS9 OpenTelemetry bootstrap for the platform. Its own per-service module (components are
// separate standalone projects — no shared telemetry package). MUST be imported FIRST in main.ts,
// before AppModule and anything that pulls in http/pg/ioredis, so the auto-instrumentations can
// patch those modules before they are loaded.
//
// Fail-soft: the SDK starts ONLY when OTEL_ENABLED is truthy. Unset ⇒ no exporter, no collector
// dependency — the platform runs bare (dev, tests) exactly as before. Endpoint + service name come
// from the standard OTEL_* env vars (OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318).
import { trace, context } from "@opentelemetry/api";

export function otelEnabled(): boolean {
  const v = process.env.OTEL_ENABLED;
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

// Default the service name so traces/metrics are attributed even if compose doesn't set it.
process.env.OTEL_SERVICE_NAME ||= "platform";

if (otelEnabled()) {
  // Lazily required so the (heavy) SDK graph is never loaded when telemetry is off.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { NodeSDK } = require("@opentelemetry/sdk-node");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");

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
    const shutdown = () => {
      void sdk.shutdown().finally(() => process.exit(0));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    // eslint-disable-next-line no-console
    console.log(`[telemetry] OTel started for ${process.env.OTEL_SERVICE_NAME}`);
  } catch (err) {
    // Telemetry must never take down the data plane.
    // eslint-disable-next-line no-console
    console.error("[telemetry] OTel init failed (continuing without it):", (err as Error).message);
  }
}

// pinoTraceMixin injects trace_id/span_id into every log line emitted inside an active span, so
// Loki logs join Tempo traces in Grafana. Used as pino's `mixin`.
export function pinoTraceMixin(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = span.spanContext();
  return { trace_id: sc.traceId, span_id: sc.spanId };
}

// fastifyLoggerOption returns a pino config for Fastify when telemetry is on (structured,
// trace-correlated JSON logs), and `false` otherwise — preserving the current logger:false default
// so the test oracle and local dev are unchanged.
export function fastifyLoggerOption(): unknown {
  if (!otelEnabled()) return false;
  return {
    level: process.env.LOG_LEVEL ?? "info",
    mixin: pinoTraceMixin,
  };
}
