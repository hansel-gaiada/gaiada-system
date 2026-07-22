// ORG-6 outbox-driven trigger (A7). A DEDICATED consumer group ("reconciler") over the
// service_assignment + org_structure streams, independent of the module-dispatch group in
// consumer.service.ts and the n8n/graph bridges — each group gets its own copy of every entry,
// its own retry accounting, and its own dead-letter. On any handler failure the entry is left
// un-ACKed and redelivered (durable retry), which is exactly how a crash BETWEEN per-target legs
// recovers: the same reconcile.* trigger comes back and reconcile is idempotent, so completed
// legs converge to no-ops and the unfinished one finishes.
//
// The reconciler entry points are already idempotent, so consuming the EXISTING lifecycle events
// (emitted per-tenant with a correlationId by the ServiceAssignments controller and org PUT) is
// equivalent to a dedicated reconcile.requested event and needs no controller change:
//   service_assignment.{activated,revoked,suspended,resumed,relinked,proposed} → reconcileAssignment
//   org_structure.updated                                                      → reconcileProvider
import { hostname } from "os";
import { randomBytes } from "crypto";
import { recordDeadLetter, recordEventConsumed, recordProcessingLag } from "../metrics";
import { getRedis } from "./redis";
import { reconcileAssignment, reconcileProvider, sweepDriftAndOrphans } from "../admin/service-reconciler";
import type { OutboxEvent } from "./types";

const GROUP = "reconciler";
// UNIQUE per process (host + pid + random). Two platform instances MUST register as distinct
// consumers, otherwise Redis routes the same logical name to both and splits one consumer's
// pending set across them — the very interleave that drives concurrent teardown of overlapping
// claims. Distinct names keep XREADGROUP ">" delivering each entry to exactly one instance.
const CONSUMER = `reconciler-${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;
export const RECONCILE_STREAMS = ["service_assignment", "org_structure"];
export const DEAD_LETTER_MAX_RETRIES = 5;
// Crash recovery WITHOUT live-sibling theft: XAUTOCLAIM only reclaims entries idle longer than
// this (a crashed/stuck instance), never an entry a healthy sibling is actively processing (which
// completes in milliseconds). A single instance still self-heals its own pending on the next tick
// once an entry has aged past the threshold.
const CLAIM_MIN_IDLE_MS = 60_000;

async function ensureGroup(stream: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.xgroup("CREATE", stream, GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!(err as Error).message.includes("BUSYGROUP")) throw err;
  }
}

function parse(fields: string[]): Omit<OutboxEvent, "entityType"> {
  const o: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return {
    id: o.outboxId,
    tenantId: o.tenantId,
    entityId: o.entityId,
    eventType: o.eventType,
    payload: JSON.parse(o.payload || "{}"),
    originSite: o.originSite,
    schemaVersion: Number(o.schemaVersion || "1"),
    createdAt: o.createdAt,
  };
}

/** Route one event to the reconciler. Unrelated event types are a no-op (still ACKed). */
async function dispatch(event: OutboxEvent): Promise<void> {
  if (event.entityType === "org_structure" && event.eventType === "org_structure.updated") {
    await reconcileProvider(event.tenantId);
    return;
  }
  if (event.entityType === "service_assignment" && event.eventType.startsWith("service_assignment.")) {
    // event.tenantId is provider OR target — both can legally see the row (sa_select dual-side).
    await reconcileAssignment(event.entityId, event.tenantId);
  }
}

export async function consumeReconcileOnce(stream: string): Promise<number> {
  const redis = getRedis();
  const key = `events:${stream}`;
  await ensureGroup(key);

  const claimed = (await redis.xautoclaim(key, GROUP, CONSUMER, CLAIM_MIN_IDLE_MS, "0", "COUNT", "50")) as [
    string,
    [string, string[]][],
    string[],
  ];
  const claimedEntries = claimed?.[1] ?? [];
  const fresh = await redis.xreadgroup("GROUP", GROUP, CONSUMER, "COUNT", "50", "STREAMS", key, ">");
  const freshEntries = fresh ? (fresh as [string, [string, string[]][]][])[0][1] : [];

  let handled = 0;
  for (const [entryId, fields] of [...claimedEntries, ...freshEntries]) {
    const event: OutboxEvent = { ...parse(fields), entityType: stream };
    try {
      await dispatch(event);
      await redis.xack(key, GROUP, entryId);
      recordEventConsumed(stream, true);
      recordProcessingLag(stream, event.createdAt);
      handled++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`reconcile handler failed (event=${event.eventType}, id=${event.entityId}):`, (err as Error).message);
      recordEventConsumed(stream, false);
      const pending = await redis.xpending(key, GROUP, entryId, entryId, 1);
      const deliveryCount = Array.isArray(pending) && pending[0] ? Number((pending[0] as unknown[])[3]) : 1;
      if (deliveryCount >= DEAD_LETTER_MAX_RETRIES) {
        await redis.xadd(`${key}:reconcile-dead-letter`, "*", ...fields);
        await redis.xack(key, GROUP, entryId);
        recordDeadLetter(stream, event.eventType);
        // eslint-disable-next-line no-console
        console.error("[RECONCILE-DEAD-LETTER]", { stream, entryId, eventType: event.eventType, deliveryCount });
      }
      // under the threshold: leave un-ACKed for redelivery (durable retry)
    }
  }
  return handled;
}

export function startReconcileLoop(intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const s of RECONCILE_STREAMS) {
      try {
        await consumeReconcileOnce(s);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`reconcile tick failed for ${s}:`, (err as Error).message);
      }
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}

// ORG-7 §3 — nightly drift/orphan sweep (A7 + A16 insurance policy). The event-driven consumer
// above is the primary path; this is the belt-and-suspenders backstop for anything it missed
// (a dead-lettered event, a manual DB edit, a bug) PLUS the orphan-TTL auto-suspend escalation
// sweepDriftAndOrphans() owns. No Redis dependency (it's a plain Postgres sweep, not stream-
// driven) — gated purely by SERVICE_ASSIGNMENTS_ENABLED at the call site in main.ts, same as the
// reconcile loop. A guarded setInterval-style loop (via chained setTimeout, matching
// startReconcileLoop's pattern above) since no @nestjs/schedule dependency exists in this repo.
export function startDriftSweepLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await sweepDriftAndOrphans();
      // drift > 0 means the sweep found + fixed a REAL discrepancy — surfaced loudly (the plan's
      // wired-to-the-observability-alert-path requirement lands as a durable, greppable log line;
      // OTEL/metrics wiring for this signal is a WS9 follow-up, not part of this ticket's scope).
      if (result.drift > 0 || result.autoSuspended > 0) {
        // eslint-disable-next-line no-console
        console.warn("[SERVICE-DRIFT-SWEEP] non-zero drift found and corrected:", result);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("drift sweep tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
