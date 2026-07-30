// Durable inbound intake (WA operability hardening).
//
// THE BUG THIS EXISTS TO FIX: `POST /webhook` used to answer 200 and then process the event in a
// detached promise. WAHA treats the 200 as "delivered" and never redelivers, so a process death
// between the ACK and `saveMessage` lost the message permanently — no trace, no retry, no alert.
// That is not hypothetical: Docker Desktop stopped mid-day on 2026-07-28 with real client chats
// flowing through this path.
//
// THE SHAPE: persist -> ACK -> process. The event is written to the store (encrypted at rest) as
// `pending` BEFORE the webhook answers, so the durable record exists no matter when we die. Then
// it is processed inline (so replies stay fast) and marked `done`. Anything still `pending` after a
// crash is replayed by the reconciler — at boot, and periodically for rows that outlived their
// inline attempt.
//
// AT-LEAST-ONCE, not exactly-once: a replay can re-process an event whose inline run had already
// half-finished. That is safe because the layers underneath are idempotent — `seenBefore()` dedups
// in memory, and the store now has a UNIQUE index on (tenant_id, wa_message_id) with
// ON CONFLICT DO NOTHING, so a duplicate insert is a no-op rather than a second row. Losing a
// message is unrecoverable; re-processing one is not.
import {
  saveInboundEvent,
  getPendingInboundEvents,
  markInboundEventDone,
  markInboundEventFailed,
} from "./store";
import { handleEvent } from "./bot";
import { config } from "./config";
import type { InboundEvent } from "./gateway/events";
import type { WhatsAppGateway } from "./waha";

/** Crypto-shred axes for the queued payload: subject = the human it is about, entity = the chat.
 *  Same two-axis model as stored sender identity, so erasing a subject also makes any of their
 *  still-queued events unreadable — the intake log must not be a plaintext side-channel. */
function shredAxes(event: InboundEvent): { subjectId: string; entityId: string } {
  switch (event.kind) {
    case "message":
      return { subjectId: event.message.senderId, entityId: event.message.chatId };
    case "button":
    case "reaction":
      return { subjectId: event.senderId, entityId: event.chatId };
    case "member":
      return { subjectId: event.userId, entityId: event.chatId };
    case "session":
      // No human subject and no chat — a session status carries no PII at all.
      return { subjectId: "system", entityId: "session" };
  }
}

function surfaceOf(event: InboundEvent): string {
  if (event.kind === "message") return event.message.chatId.startsWith("tg:") ? "telegram" : "whatsapp";
  if (event.kind === "session") return "whatsapp";
  return "chatId" in event && event.chatId.startsWith("tg:") ? "telegram" : "whatsapp";
}

/**
 * Persist the event durably. Returns the intake id, or null when the store rejected it — the
 * CALLER decides what to do with a null (the webhook must NOT ACK 200 on null, or we are back to
 * losing messages silently; a non-2xx makes WAHA redeliver, which is exactly what we want).
 */
export async function recordInbound(event: InboundEvent): Promise<string | null> {
  try {
    const { subjectId, entityId } = shredAxes(event);
    return await saveInboundEvent({
      surface: surfaceOf(event),
      kind: event.kind,
      subjectId,
      entityId,
      payload: event,
    });
  } catch (err) {
    console.error(`[intake] could not persist inbound event (${event.kind}): ${(err as Error).message}`);
    return null;
  }
}

/**
 * Process an already-persisted event and settle its row. Never throws: a handler failure marks the
 * row `failed` (with the reason) instead of bubbling into the request path — a poison event must
 * not be retried forever, but it also must not vanish. `failed` rows stay queryable for an
 * operator, and are NOT picked up again by the reconciler.
 */
export async function processRecorded(gw: WhatsAppGateway, id: string, event: InboundEvent): Promise<void> {
  try {
    await handleEvent(gw, event);
    await markInboundEventDone(id);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[intake] handling failed for ${event.kind} (${id}): ${msg}`);
    await markInboundEventFailed(id, msg).catch(() => undefined);
  }
}

/**
 * Replay `pending` rows — the crash-recovery path.
 *
 * `minAgeMs` guards against racing a row that is still legitimately being processed inline (an
 * AI-gateway reply can take seconds). The BOOT sweep passes 0: a freshly started process has no
 * in-flight work of its own, so every pending row is by definition orphaned.
 * Returns how many were replayed.
 */
export async function reconcileInbound(gw: WhatsAppGateway, minAgeMs = 0): Promise<number> {
  let rows;
  try {
    rows = await getPendingInboundEvents(minAgeMs);
  } catch (err) {
    console.warn(`[intake] reconcile could not read pending events: ${(err as Error).message}`);
    return 0;
  }
  if (rows.length === 0) return 0;
  console.warn(`[intake] replaying ${rows.length} pending inbound event(s) left by a previous run`);
  let replayed = 0;
  for (const row of rows) {
    // A row whose payload can't be decrypted (key shredded after an erasure request) is not
    // recoverable and must not block the queue — settle it and move on.
    if (row.payload == null) {
      await markInboundEventFailed(row.id, "payload unreadable (key shredded or corrupt)").catch(() => undefined);
      continue;
    }
    await processRecorded(gw, row.id, row.payload as InboundEvent);
    replayed++;
  }
  return replayed;
}

/** Periodic reconciler. Deliberately independent of Redis: the store IS the durability guarantee
 *  here, so this path must keep working when the queue is down. Returns a stop handle. */
export function startIntakeReconciler(gw: WhatsAppGateway): { stop: () => void } {
  const everyMs = Math.max(10, config.intakeReconcileSeconds) * 1000;
  const timer = setInterval(() => {
    void reconcileInbound(gw, config.intakeReconcileMinAgeMs).catch(() => undefined);
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
