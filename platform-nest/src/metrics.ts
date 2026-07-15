// WS9 domain metrics for the platform's event backbone. HTTP server latency/error metrics come
// free from the auto-instrumentation; this adds the business-backbone signals the SLOs read: event
// throughput, processing lag (outbox row age at consume time), and — the one that used to only be a
// greppable console line — dead-letters. All instruments are no-ops when OTEL is disabled (the API
// falls back to a no-op meter), so callers record unconditionally with no branching.
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("gaiada/platform");

const eventsConsumed = meter.createCounter("platform_events_consumed_total", {
  description: "Backbone events dispatched to handlers, by entity type and outcome",
});
const eventsDeadLettered = meter.createCounter("platform_events_dead_lettered_total", {
  description: "Backbone events moved to a dead-letter stream after exhausting retries",
});
const processingLag = meter.createHistogram("platform_event_processing_lag_ms", {
  description: "Age of an outbox row (created_at) at the moment it is successfully consumed",
  unit: "ms",
});

export function recordEventConsumed(entityType: string, ok: boolean): void {
  eventsConsumed.add(1, { entity_type: entityType, result: ok ? "ok" : "error" });
}

export function recordDeadLetter(entityType: string, eventType: string): void {
  eventsDeadLettered.add(1, { entity_type: entityType, event_type: eventType });
}

// recordProcessingLag is called once per successfully-handled event with the outbox row's
// created_at (ISO string). A missing/invalid timestamp is skipped rather than recorded as noise.
export function recordProcessingLag(entityType: string, createdAtIso: string | undefined): void {
  if (!createdAtIso) return;
  const created = Date.parse(createdAtIso);
  if (Number.isNaN(created)) return;
  const lag = Date.now() - created;
  if (lag >= 0) processingLag.record(lag, { entity_type: entityType });
}
