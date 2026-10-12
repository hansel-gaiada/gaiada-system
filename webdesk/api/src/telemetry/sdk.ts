// M4 telemetry — the OpenTelemetry TRACES SDK. This file is only ever loaded through a dynamic import from
// telemetry/index.ts, and only when the gate (gate.ts) says on: with telemetry off, none of these
// packages is required and nothing patches anything.
//
// Shape: NodeTracerProvider -> BatchSpanProcessor -> SanitizingSpanExporter -> OTLP/HTTP protobuf exporter.
// Traces only: no logs exporter, no metrics reader. Deliberately NOT @opentelemetry/sdk-node and NOT the
// auto-instrumentations meta-package: five named instrumentations, nothing implicit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { context, propagation, trace } from "@opentelemetry/api";
import { CompositePropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { TelemetryGate } from "./gate";
import { SanitizingSpanExporter } from "./sanitizing-exporter";

/** Bounded on purpose: this api shares a 2-vCPU box and a 768 MiB cap with the ERP. */
export const BATCH_LIMITS = {
  maxQueueSize: 512, // spans waiting for export; beyond this new spans are DROPPED, never queued without bound
  maxExportBatchSize: 128,
  scheduledDelayMillis: 5_000,
  exportTimeoutMillis: 3_000,
} as const;
/** The OTLP exporter's own request timeout. Shorter than the batch timeout so the processor never has to cut it off. */
export const EXPORT_REQUEST_TIMEOUT_MS = 2_500;
/** How long shutdown may spend flushing before it gives up (a SIGTERM must not hang a deploy). */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

export interface TelemetryHandle {
  /** Flush what is queued and stop. Bounded by `timeoutMs`; never rejects. */
  shutdown(timeoutMs?: number): Promise<void>;
  forceFlush(): Promise<void>;
}

export interface StartOptions {
  gate: Extract<TelemetryGate, { enabled: true }>;
  /** Operator-visible notices. Receives no URLs, headers or span content. */
  warn?: (message: string) => void;
  /** TEST SEAMS. Production passes none of these. */
  exporter?: SpanExporter;
  /** Run the negative control with redaction off. Test only; sdk callers in src/ never pass it. */
  redact?: boolean;
  /** Register the instrumentations. Off only for unit tests of the pipeline itself. */
  instrument?: boolean;
  scheduledDelayMillis?: number;
}

function packageVersion(): string {
  try {
    // dist/telemetry/sdk.js and src/telemetry/sdk.ts are both two levels below the package root. Read at runtime,
    // not imported, so tsc's rootDir (and `node dist/main.js`) stay as they are.
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function startTelemetry(opts: StartOptions): TelemetryHandle {
  const { gate } = opts;
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  const otlp =
    opts.exporter ??
    new OTLPTraceExporter({
      url: gate.tracesUrl,
      headers: gate.headers,
      timeoutMillis: EXPORT_REQUEST_TIMEOUT_MS,
    });
  const exporter = new SanitizingSpanExporter(otlp, { redact: opts.redact ?? true, warn });

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "webdesk-api",
      [ATTR_SERVICE_VERSION]: packageVersion(),
      "service.namespace": "webdesk", // the collector's resource/webdesk upserts it anyway
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        ...BATCH_LIMITS,
        scheduledDelayMillis: opts.scheduledDelayMillis ?? BATCH_LIMITS.scheduledDelayMillis,
      }),
    ],
  });
  // No context propagation in either direction. This api is internet-facing: honouring an inbound
  // `traceparent` lets any caller pick our trace ids and force sampling, and injecting one into outbound
  // calls hands our ids to tenants' webhook receivers. An empty composite is a no-op propagator.
  provider.register({ propagator: new CompositePropagator({ propagators: [] }) });

  let unregister: () => void = () => undefined;
  if (opts.instrument !== false) {
    const otlpHost = (() => {
      try {
        return new URL(gate.tracesUrl).host;
      } catch {
        return "";
      }
    })();
    unregister = registerInstrumentations({
      tracerProvider: provider,
      instrumentations: [
        // Inbound requests (Fastify runs on node:http) and outbound node:http(s) (the S3 client). No headers
        // are turned into attributes (the option is left unset), no bodies are ever read.
        new HttpInstrumentation({
          // the exporter's own POST must never be traced (the processor also suppresses tracing around export)
          ignoreOutgoingRequestHook: (req) => {
            if (otlpHost === "") return false;
            const host = String(req.hostname ?? req.host ?? "");
            return (req.port ? `${host}:${req.port}` : host) === otlpHost;
          },
        }),
        // Outbound global `fetch` (tenant webhooks, the events bridge, Turnstile) is undici, not node:http.
        // Only inside a traced request: queue workers and timers do not start traces of their own.
        new UndiciInstrumentation({ requireParentforSpans: true }),
        // Route-level spans for Nest-on-Fastify (@fastify/otel is the Fastify project's own, the contrib one is deprecated for it).
        new FastifyOtelInstrumentation({ registerOnInitialization: true, instrumentHooks: false, instrumentHandler: false, recordExceptions: false }),
        // `enhancedDatabaseReporting: false`: no parameter values in db.statement (the query text keeps its `$1` placeholders).
        new PgInstrumentation({ enhancedDatabaseReporting: false, requireParentSpan: true, ignoreConnectSpans: true }),
        // Command name only: no key names, no arguments (BullMQ job payloads travel as redis arguments).
        new IORedisInstrumentation({ dbStatementSerializer: (cmdName) => cmdName, requireParentSpan: true }),
      ],
    });
  }

  let stopped = false;
  return {
    async forceFlush() {
      try {
        await provider.forceFlush();
      } catch {
        // lost batch, never an error
      }
    },
    async shutdown(timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS) {
      if (stopped) return;
      stopped = true;
      try {
        unregister();
      } catch {
        // nothing to do
      }
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      try {
        await Promise.race([provider.shutdown().catch(() => undefined), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
        // leave no global trace state behind (matters to tests that start several SDKs in one process)
        trace.disable();
        context.disable();
        propagation.disable();
      }
    },
  };
}
