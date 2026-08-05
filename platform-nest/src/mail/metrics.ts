// MAIL-04 — the counters design §11 lists for this ticket's surface (queue/send/suppress/webhook).
// `mail_inbound_*` belongs to MAIL-13 (inbound is a separate ticket) and is intentionally not
// added here. Same no-op-when-OTEL-disabled convention as src/metrics.ts: callers record
// unconditionally, no branching on whether telemetry is on.
import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("gaiada/platform");

const enqueued = meter.createCounter("mail_enqueued_total", {
  description: "Mail rows written to mail_log, by stream and template",
});
const sent = meter.createCounter("mail_sent_total", {
  description: "Mail rows the sender worker successfully handed to a provider adapter, by stream",
});
const failed = meter.createCounter("mail_failed_total", {
  description: "Mail send attempts that errored (queued for retry or moved to failed), by stream",
});
const suppressed = meter.createCounter("mail_suppressed_total", {
  description: "Mail rows that never reached an adapter because the recipient is suppressed",
});
const sendDuration = meter.createHistogram("mail_send_duration_ms", {
  description: "Wall-clock time of one adapter.send() call",
  unit: "ms",
});
const webhookUnknown = meter.createCounter("mail_webhook_unknown_total", {
  description: "Delivery-event webhook posts that matched no mail_log row (204, logged, not an error)",
});
// MAIL-13 (design §11). Kept as TWO counters rather than one with an extra label because they answer
// different questions: `mail_inbound_total` covers deliveries that got as far as the pipeline
// (including the A9 unmatched drop, which is normal operation), while `mail_inbound_rejected_total`
// covers deliveries refused at the door and is the one an alert on "inbound rejection spike" watches.
const inbound = meter.createCounter("mail_inbound_total", {
  description: "Inbound deliveries processed, by provider and outcome (threaded|duplicate|ndr|unmatched|rejected)",
});
const inboundRejected = meter.createCounter("mail_inbound_rejected_total", {
  description: "Inbound deliveries refused at intake, by reason (auth|size|dupe|rate|malformed)",
});

export function recordEnqueued(stream: string, templateKey: string): void {
  enqueued.add(1, { stream, template: templateKey });
}
export function recordSent(stream: string): void {
  sent.add(1, { stream });
}
export function recordFailed(stream: string): void {
  failed.add(1, { stream });
}
export function recordSuppressed(stream: string): void {
  suppressed.add(1, { stream });
}
export function recordSendDuration(stream: string, ms: number): void {
  sendDuration.record(ms, { stream });
}
export function recordWebhookUnknown(): void {
  webhookUnknown.add(1);
}
export function recordInbound(provider: string, outcome: string): void {
  inbound.add(1, { provider, outcome });
}
/** Reason-only. It deliberately does NOT also bump `mail_inbound_total{outcome="rejected"}`: the two
 *  counters have different denominators, and a message that was THREADED while one over-cap
 *  attachment was dropped is a rejected *attachment*, not a rejected delivery. The controller bumps
 *  the delivery-level outcome itself for the refusals that are whole-delivery refusals. */
export function recordInboundRejected(reason: string): void {
  inboundRejected.add(1, { reason });
}
