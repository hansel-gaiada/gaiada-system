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
/** Query parameters whose VALUE is a credential and must never reach a log line.
 *
 *  `token` is the webhook shared secret: WAHA is configured to call `POST /webhook?token=<secret>`
 *  (see the fail-closed warning in `server.ts`), so the secret travels in the URL by the caller's
 *  design, not ours. `key` / `apikey` / `api_key` / `secret` / `access_token` are included because
 *  the same shape recurs and a redactor that only covers today's one parameter is a redactor that
 *  will be wrong at the next integration. */
const REDACTED_QUERY_PARAMS = new Set(["token", "key", "apikey", "api_key", "secret", "access_token", "signature"]);

/** Replace credential-bearing query values with `[redacted]`, preserving everything else about the
 *  URL so it stays useful for debugging (path, other params, ordering).
 *
 *  Exported for the test — this is security-relevant string handling, and the one thing worse than
 *  no redactor is a redactor nobody checked. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const path = url.slice(0, q);
  // Hand-parsed rather than via URLSearchParams: this value is a RELATIVE url, and round-tripping
  // through URL/URLSearchParams re-encodes characters, so a logged line would stop matching the
  // request that produced it — which is exactly what someone reading logs is trying to correlate.
  const parts = url
    .slice(q + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      return REDACTED_QUERY_PARAMS.has(name.toLowerCase()) ? `${name}=[redacted]` : pair;
    });
  return `${path}?${parts.join("&")}`;
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
    // ── SIM-F3 (2026-08-24) — the webhook secret was being logged in clear ────────────────────────
    // Fastify's default request serialiser logs `req.url` verbatim, so every inbound webhook wrote
    // the shared secret to stdout and onward to Loki:
    //
    //   "req":{"method":"POST","url":"/webhook?token=<the actual secret>", ...}
    //
    // Found by reading this container's own log while driving simulated traffic through it. Read
    // access to logs is normally granted far more freely than read access to secrets, so anyone with
    // a Grafana login held the credential for the retention period.
    //
    // Redacting here rather than at the route is deliberate: the leak is a property of LOGGING a
    // url, not of that one handler, so any future route taking a credential in a query string is
    // covered without anyone remembering to think about it. The right longer-term fix is also to
    // accept the secret from a header (WAHA supports custom hook headers) and retire the query form
    // — but that needs a coordinated WAHA reconfiguration, whereas this closes the exposure now and
    // stays correct afterwards.
    serializers: {
      req(request: { method?: string; url?: string; headers?: Record<string, unknown>; ip?: string }) {
        return {
          method: request.method,
          url: redactUrl(request.url ?? ""),
          host: (request.headers?.host as string) ?? undefined,
          remoteAddress: request.ip,
        };
      },
    },
  };
}
