// WS9 domain metrics for the bot surface. HTTP webhook spans/latency come free from
// auto-instrumentation; this adds the surface signals the SLOs/dashboards read: what people ask the
// assistant (discovery), and the media pipeline (enqueued vs processed). All PII-free by shape — the
// same discipline as discovery.ts (command NAME only, never args/ids/text). No-op when OTEL is off.
import { metrics } from "@opentelemetry/api";
import type { DiscoveryEvent } from "./discovery";

const meter = metrics.getMeter("gaiada/wa-chat-bot");

const discoveryEvents = meter.createCounter("bot_discovery_events_total", {
  description: "Assistant interactions by surface, kind, command name and group/DM",
});
const mediaEnqueued = meter.createCounter("bot_media_enqueued_total", {
  description: "Media messages enqueued for the media worker",
});
const mediaProcessed = meter.createCounter("bot_media_processed_total", {
  description: "Media jobs processed by the worker, by result",
});

export function recordDiscovery(e: DiscoveryEvent): void {
  discoveryEvents.add(1, {
    surface: e.surface,
    kind: e.kind,
    command: e.command ?? "",
    is_group: String(e.isGroup),
  });
}

export function recordMediaEnqueued(): void {
  mediaEnqueued.add(1);
}

export function recordMediaProcessed(result: "settled" | "not-pending" | "error"): void {
  mediaProcessed.add(1, { result });
}
