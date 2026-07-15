// WS9 OpenTelemetry bootstrap for the MCP hub (ESM). Its own per-service module — no shared
// telemetry package. MUST be imported FIRST in server.ts, before express/pg/the MCP SDK, so the
// auto-instrumentations patch them. Fail-soft: the SDK starts ONLY when OTEL_ENABLED is truthy;
// unset ⇒ no exporter, no collector dependency (dev/tests run bare). Endpoint + service name come
// from standard OTEL_* env vars (OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318).
import { trace, context } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import pino from "pino";

export function otelEnabled(): boolean {
  const v = process.env.OTEL_ENABLED;
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

process.env.OTEL_SERVICE_NAME ||= "mcp-hub";

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

// Structured JSON logger, trace-correlated so Loki logs join Tempo traces in Grafana.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.OTEL_SERVICE_NAME },
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) return {};
    const sc = span.spanContext();
    return { trace_id: sc.traceId, span_id: sc.spanId };
  },
});
