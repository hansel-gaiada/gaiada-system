// S0 (agent event spine, 2026-08-22) — the runner's in-process fan-out for `GET /runs/:id/events/stream`.
//
// `portal-stream.controller.ts` (the pattern this ticket is told to copy) fans out over Redis, because
// the portal is served by multiple platform-nest instances and a subscriber on one instance must see a
// write made on another. The agent-runner has no such requirement TODAY: `runner/service.ts` runs the
// whole goal queue in ONE process (`GoalQueue` is in-memory; `AGENT_MAX_CONCURRENT_GOALS` bounds workers
// within that one process, not across a fleet — see queue.ts's own header), so the event that must reach
// a subscriber is always produced in the SAME process the subscriber is connected to. A Node
// `EventEmitter` is the entire mechanism required; reaching for Redis here would be infrastructure this
// ticket does not need, not fidelity to the pattern.
//
// If the runner is ever horizontally scaled, this module is exactly where a Redis (or NOTIFY/LISTEN)
// backend would slot in behind the same two functions below — the SSE route in `service.ts` does not
// know or care which one it's talking to, mirroring how `portal-stream.controller.ts` itself is written
// against `subscribePortal`'s interface, not against Redis directly.
import { EventEmitter } from "node:events";
import type { RunEventRow } from "./store";

const bus = new EventEmitter();
// Unbounded on purpose: each open SSE connection adds exactly one listener for the lifetime of that
// connection (capped at MAX_CONNECTION_MS in service.ts) and removes it on teardown. The default cap of
// 10 exists to catch LEAKED listeners on a single event name; many concurrent tenants each holding a few
// live connections is the intended shape, not a leak.
bus.setMaxListeners(0);

function topic(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/** Publish one persisted event row to every live subscriber for its tenant. Fire-and-forget: a topic
 *  with no subscribers is a no-op (EventEmitter semantics), which is the common case when nobody has the
 *  floor open — publishing must never be gated on a subscriber existing. */
export function publishRunEvent(tenantId: string, row: RunEventRow): void {
  bus.emit(topic(tenantId), row);
}

/** Subscribe to every event published for one tenant. The caller (the SSE route) filters by `runId`
 *  itself — subscribing per-tenant rather than per-run keeps this module ignorant of the goal/run
 *  hierarchy, matching `store.ts`'s "no FK, no assumed shape" choice for `agent_run_events.run_id`.
 *  Returns an idempotent unsubscribe function. */
export function subscribeTenant(tenantId: string, onEvent: (row: RunEventRow) => void): () => void {
  const handler = (row: RunEventRow): void => onEvent(row);
  bus.on(topic(tenantId), handler);
  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    bus.off(topic(tenantId), handler);
  };
}
