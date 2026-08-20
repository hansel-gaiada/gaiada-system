// P2-05 — outbox-driven triggers for the POSITION reconciler (design §3.3).
//
// Registered as CORE event handlers (`registerCoreEventHandler`) on the shared module-dispatch
// consumer group, rather than as a second dedicated group like ORG-6's `reconcile-consumer.ts`.
// Reason: the position reconciler is single-tenant (it only ever writes the tenant the event was
// emitted in), so it needs none of the cross-tenant leg/retry accounting that justified ORG-6
// having its own group. The reconciler entry points are idempotent, so a redelivered event
// converges to a no-op.
//
// ⚠ THE SILENT-CONSUMER TRAP. A handler registered here does NOTHING unless its ENTITY-TYPE stream
// is in `startConsumerLoop([...])` in `main.ts` — the event is written to the outbox, relayed to
// Redis, and read by nobody. The two streams these handlers need are `position_assignment` and
// `position`, and both are added to that list in `main.ts`. They are added UNCONDITIONALLY (not
// behind `positionSyncEnabled`) on purpose: an always-drained stream can never accumulate a
// backlog that a flag flip would suddenly replay, and the handlers themselves are what the flag
// gates. `position-consumer.test.ts` pins the streams-vs-handlers agreement so this cannot rot.
//
// ⚠ NO FEEDBACK LOOP. The reconciler EMITS on entityType `position_assignment` too
// (`position_grants.reconciled`, `iam.drift_detected`). Handlers are keyed by EVENT TYPE, and
// neither of those is registered below, so a reconcile can never re-trigger itself. Do not add a
// wildcard handler here.
import { config } from "../config";
import { registerCoreEventHandler } from "./consumer.service";
import { reconcileAssignment, reconcilePosition } from "../admin/position-reconciler";
import type { OutboxEvent } from "./types";

/** The entity-type streams these handlers need. Exported so `main.ts` and the test that pins the
 *  agreement both read ONE list rather than two hand-copied ones. */
export const POSITION_STREAMS = ["position_assignment", "position"] as const;

/** Event types that re-diff ONE assignment's holder. P2-06 (transfer) and P2-12 (the positions
 *  composer) are the producers; nothing emits these yet, which is why this wiring lands dark. */
export const ASSIGNMENT_TRIGGERS = [
  "position_assignment.created",
  "position_assignment.closed",
  "position_assignment.updated",
] as const;

/** Event types that re-diff EVERY holder of one position (its role set or status changed). */
export const POSITION_TRIGGERS = [
  "position.updated",
  "position.retired",
  "position.orphaned",
  "position.roles_changed",
] as const;

async function onAssignmentEvent(event: OutboxEvent): Promise<void> {
  if (!config.positionSyncEnabled) return;
  await reconcileAssignment(event.tenantId, event.entityId);
}

async function onPositionEvent(event: OutboxEvent): Promise<void> {
  if (!config.positionSyncEnabled) return;
  await reconcilePosition(event.tenantId, event.entityId);
}

/** Register the position reconciler's outbox triggers. Called from `bootstrap()`. Idempotent per
 *  process only in the sense that `registerCoreEventHandler` APPENDS — call it once. */
export function registerPositionEventHandlers(): void {
  for (const t of ASSIGNMENT_TRIGGERS) registerCoreEventHandler(t, onAssignmentEvent);
  for (const t of POSITION_TRIGGERS) registerCoreEventHandler(t, onPositionEvent);
}
