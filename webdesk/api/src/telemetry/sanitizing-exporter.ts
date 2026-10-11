// M4 telemetry — the ONE place spans are cleaned, and the place that makes the exporter fail-soft.
//
// Why an exporter wrapper and not a SpanProcessor: a span keeps changing after onStart (an instrumentation
// renames it and adds url/route attributes when the response is known), and onEnd receives a ReadableSpan
// whose fields are read-only. The exporter is the last hop and sees each span's FINAL state, so rewriting
// there is both complete and independent of how the SDK stores attributes. Whatever the pipeline records,
// only the rewritten copy can reach the wire.
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { redactAttributes, redactName, type Attrs } from "./redact";

type Warn = (message: string) => void;

export interface SanitizingExporterOptions {
  /**
   * Rewrite spans before export. ALWAYS true in production (sdk.ts never passes anything else). It exists
   * only so the test suite can run the negative control: with it off, the same requests must leak the token,
   * proving the redaction test is not passing vacuously.
   */
  redact?: boolean;
  /** Operator-visible warning sink (rate limited here). Never receives span content, URLs or headers. */
  warn?: Warn;
  /** Minimum gap between two failure warnings (ms). */
  warnEveryMs?: number;
  now?: () => number;
}

/** A copy of the span with every string and attribute rewritten. The original object is untouched. */
export function sanitizeSpan(span: ReadableSpan): ReadableSpan {
  const kind = span.kind as number;
  return {
    name: redactName(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    // A status message is an error message (a pg error quotes the offending values): keep the code only.
    status: { code: span.status.code },
    attributes: redactAttributes(span.attributes as Attrs, kind),
    links: span.links.map((l) => ({ context: l.context, attributes: redactAttributes(l.attributes as Attrs | undefined, kind) })),
    events: span.events.map((e) => ({ name: redactName(e.name), time: e.time, attributes: redactAttributes(e.attributes as Attrs | undefined, kind), droppedAttributesCount: e.droppedAttributesCount })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/**
 * Wraps the real exporter. Every failure mode ends in `{ code: FAILED }` handed to the callback: a thrown
 * error (sanitizing or exporting), a refused connection, a timeout. Nothing is ever rethrown into the
 * BatchSpanProcessor, and nothing here is on a request's path (the processor exports from a timer).
 */
export class SanitizingSpanExporter implements SpanExporter {
  private readonly redact: boolean;
  private readonly warn: Warn;
  private readonly warnEveryMs: number;
  private readonly now: () => number;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private failedSinceWarn = 0;

  constructor(private readonly inner: SpanExporter, opts: SanitizingExporterOptions = {}) {
    this.redact = opts.redact ?? true;
    this.warn = opts.warn ?? (() => undefined);
    this.warnEveryMs = opts.warnEveryMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let done = false;
    const finish = (result: ExportResult): void => {
      if (done) return;
      done = true;
      if (result.code !== ExportResultCode.SUCCESS) this.noteFailure();
      try {
        resultCallback(result);
      } catch {
        // a throwing callback must not travel back into the exporter or the processor's timer
      }
    };
    try {
      const out = this.redact ? spans.map(sanitizeSpan) : spans;
      this.inner.export(out, finish);
    } catch {
      finish({ code: ExportResultCode.FAILED });
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.inner.shutdown();
    } catch {
      // a failed final flush is a lost batch, never an error at shutdown
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.inner.forceFlush?.();
    } catch {
      // see shutdown
    }
  }

  private noteFailure(): void {
    this.failedSinceWarn += 1;
    const t = this.now();
    if (t - this.lastWarnAt < this.warnEveryMs) return;
    this.lastWarnAt = t;
    const n = this.failedSinceWarn;
    this.failedSinceWarn = 0;
    try {
      this.warn(`[webdesk:otel] trace export failed (${n} batch${n === 1 ? "" : "es"} since the last notice); spans are dropped, requests are unaffected`);
    } catch {
      // never throw from the warning path
    }
  }
}
