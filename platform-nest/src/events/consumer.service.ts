// EventConsumerService (WS1 event-backbone spec §5): reads each entity_type stream's
// consumer group, dispatches to whichever ENABLED module registered a handler for that
// event_type. Each handler call is isolated (try/catch) so one module's failure can't
// stall dispatch to others sharing the same batch.
import { allModules, isModuleEnabled } from "../modules/registry";
import { recordDeadLetter, recordEventConsumed, recordProcessingLag } from "../metrics";
import { getRedis } from "./redis";
import type { OutboxEvent } from "./types";

const GROUP = "in-process-platform";
const CONSUMER = "platform-1";

// Task 7: entries that fail every handler this many times are moved off the live
// stream onto a plain (non-consumer-group) dead-letter stream and ack'd there so
// they stop being redelivered.
export const DEAD_LETTER_MAX_RETRIES = 5;

async function ensureGroup(stream: string, groupName: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.xgroup("CREATE", stream, groupName, "0", "MKSTREAM");
  } catch (err) {
    if (!(err as Error).message.includes("BUSYGROUP")) throw err;
  }
}

function parseFields(fields: string[]): Omit<OutboxEvent, "entityType"> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return {
    id: obj.outboxId,
    tenantId: obj.tenantId,
    entityId: obj.entityId,
    eventType: obj.eventType,
    payload: JSON.parse(obj.payload || "{}"),
    originSite: obj.originSite,
    schemaVersion: Number(obj.schemaVersion || "1"),
    // Real outbox-row creation time (set by relay.ts from the row's created_at column),
    // NOT consume time — do not fabricate `new Date().toISOString()` here.
    createdAt: obj.createdAt,
  };
}

export async function consumeOnce(entityType: string, groupName = GROUP): Promise<number> {
  const redis = getRedis();
  const stream = `events:${entityType}`;
  await ensureGroup(stream, groupName);

  // Self-claim any entries left pending by a prior failed attempt (min-idle-time 0: this
  // is a single in-process consumer, so there's no other worker to race). XCLAIM/XAUTOCLAIM
  // bumps each entry's delivery count, which is what lets DEAD_LETTER_MAX_RETRIES retries
  // actually accumulate across repeated consumeOnce calls — plain XREADGROUP with ">" only
  // ever delivers brand-new entries, never already-pending ones.
  const claimed = (await redis.xautoclaim(stream, groupName, CONSUMER, 0, "0", "COUNT", "50")) as [
    string,
    [string, string[]][],
    string[],
  ];
  const claimedEntries = claimed?.[1] ?? [];

  const result = await redis.xreadgroup("GROUP", groupName, CONSUMER, "COUNT", "50", "STREAMS", stream, ">");
  const freshEntries = result ? (result as [string, [string, string[]][]][])[0][1] : [];

  const entries = [...claimedEntries, ...freshEntries];
  let handled = 0;
  for (const [entryId, fields] of entries) {
    const event: OutboxEvent = { ...parseFields(fields), entityType };
    let allOk = true;
    for (const mod of allModules()) {
      const handler = mod.eventHandlers?.[event.eventType];
      if (!handler) continue;
      if (!(await isModuleEnabled(event.tenantId, mod.key))) continue;
      try {
        await handler(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`event handler failed (module=${mod.key}, event=${event.eventType}):`, (err as Error).message);
        allOk = false;
      }
    }
    if (allOk) {
      // Only ack when every handler for this entry succeeded — leave un-ACKed on any
      // failure so it's redelivered on a future XREADGROUP/XCLAIM pass.
      await redis.xack(stream, groupName, entryId);
      recordEventConsumed(entityType, true);
      recordProcessingLag(entityType, event.createdAt);
      handled++;
      continue;
    }
    recordEventConsumed(entityType, false);
    // A handler failed: check how many times this entry has now been delivered via
    // XPENDING (the 4th field of the summary entry is the delivery count) and, past
    // the retry threshold, move it to a plain dead-letter stream and ack the original
    // so it stops being redelivered there. Under the threshold, leave it un-ACKed for
    // a future redelivery pass.
    const pending = await redis.xpending(stream, groupName, entryId, entryId, 1);
    const deliveryCount = Array.isArray(pending) && pending[0] ? Number((pending[0] as unknown[])[3]) : 1;
    if (deliveryCount >= DEAD_LETTER_MAX_RETRIES) {
      await redis.xadd(`${stream}:dead-letter`, "*", ...fields);
      await redis.xack(stream, groupName, entryId);
      // WS9: emit the dead-letter as a metric so Alertmanager can page on a nonzero rate
      // (`platform_events_dead_lettered_total`) — the cross-service alerting this comment used to
      // defer. The greppable log line stays for forensic context.
      recordDeadLetter(entityType, event.eventType);
      // eslint-disable-next-line no-console
      console.error("[DEAD-LETTER]", {
        stream,
        entryId,
        eventType: event.eventType,
        tenantId: event.tenantId,
        deliveryCount,
      });
    }
  }
  return handled;
}

export function startConsumerLoop(entityTypes: string[], intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const t of entityTypes) {
      try {
        await consumeOnce(t);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`consumer tick failed for ${t}:`, (err as Error).message);
      }
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
