// WS9 OpenTelemetry bootstrap for the WhatsApp/Telegram bot (ESM). Its own per-service module — no
// shared telemetry package. MUST be imported FIRST in server.ts and media-worker.ts, before Fastify
// and the gateway/store modules, so auto-instrumentation patches http/pg/ioredis. Fail-soft: starts
// ONLY when OTEL_ENABLED; unset ⇒ the bot runs bare (dev/tests). Endpoint + service name from the
// standard OTEL_* env vars (OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318).
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

process.env.OTEL_SERVICE_NAME ||= "wa-chat-bot";

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

// fastifyLoggerOption: Fastify's built-in pino, with trace_id/span_id injected so bot logs join
// traces in Grafana. Logging stays ON as today; this only adds correlation fields + a stable level.
export function fastifyLoggerOption(): unknown {
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
