// Event → n8n bridge (WS4 §4). Closes the v1-deferred "event-backbone triggers" gap: a
// SEPARATE Redis consumer group over the same entity_type streams the in-process consumer
// reads, forwarding allow-listed events to n8n webhooks so workflows can fire on business
// events. It runs its own group ("n8n-bridge") so its acks never interfere with module
// dispatch, and it is NOT tenant-gated (infra, like the relay).
//
// Contract: POST ${N8N_WEBHOOK_BASE_URL}/webhook/ev/<eventType> with a stable v1 envelope and
// a shared-secret header. n8n dedupes on the envelope `id` (the bridge is at-least-once).
import { config } from "../config";
import { getRedis } from "./redis";
import type { OutboxEvent } from "./types";

const GROUP = "n8n-bridge";
const CONSUMER = "bridge-1";
export const BRIDGE_DEAD_LETTER_MAX_RETRIES = 5;

/** The stable, versioned payload n8n receives. Built only from fields the relay puts on the
 *  stream — no fabricated timestamps (createdAt is the outbox row's real creation time). */
export interface BridgeEnvelope {
  v: 1;
  id: string;
  eventType: string;
  entityType: string;
  tenantId: string;
  entityId: string;
  originSite: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export function buildEnvelope(e: OutboxEvent): BridgeEnvelope {
  return {
    v: 1,
    id: e.id,
    eventType: e.eventType,
    entityType: e.entityType,
    tenantId: e.tenantId,
    entityId: e.entityId,
    originSite: e.originSite,
    createdAt: e.createdAt,
    payload: e.payload,
  };
}

export type ForwardResult = "delivered" | "skipped" | "retry";

/** Forward one event to its n8n webhook. Returns:
 *  - "skipped"  : not on the allow-list → ack, never our concern.
 *  - "delivered": 2xx, or a 4xx (client error — a missing/inactive webhook; ack to avoid a
 *                 poison-redelivery loop, but the caller logs it).
 *  - "retry"    : network error / timeout / 5xx → leave un-acked for redelivery. */
export async function forwardEvent(e: OutboxEvent): Promise<ForwardResult> {
  if (!config.n8nBridge.events.includes(e.eventType)) return "skipped";
  const url = `${config.n8nBridge.webhookBaseUrl.replace(/\/$/, "")}/webhook/ev/${encodeURIComponent(e.eventType)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.n8nBridge.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", "x-gaiada-bridge-secret": config.n8nBridge.secret },
      body: JSON.stringify(buildEnvelope(e)),
    });
    if (res.ok) return "delivered";
    // 5xx: n8n is up but erroring — retry. 4xx: no/inactive webhook — ack (don't loop forever).
    return res.status >= 500 ? "retry" : "delivered";
  } catch {
    return "retry"; // network / timeout
  } finally {
    clearTimeout(timer);
  }
}

function parseFields(fields: string[], entityType: string): OutboxEvent {
  const o: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) o[fields[i]] = fields[i + 1];
  return {
    id: o.outboxId,
    tenantId: o.tenantId,
    entityType,
    entityId: o.entityId,
    eventType: o.eventType,
    payload: JSON.parse(o.payload || "{}"),
    originSite: o.originSite,
    schemaVersion: Number(o.schemaVersion || "1"),
    createdAt: o.createdAt,
  };
}

async function ensureGroup(stream: string): Promise<void> {
  const redis = getRedis();
  try {
    await redis.xgroup("CREATE", stream, GROUP, "0", "MKSTREAM");
  } catch (err) {
    if (!(err as Error).message.includes("BUSYGROUP")) throw err;
  }
}

export async function bridgeOnce(entityType: string): Promise<number> {
  const redis = getRedis();
  const stream = `events:${entityType}`;
  await ensureGroup(stream);

  // Reclaim entries left pending by a prior failed forward (bumps delivery count → dead-letter).
  const claimed = (await redis.xautoclaim(stream, GROUP, CONSUMER, 0, "0", "COUNT", "50")) as [
    string,
    [string, string[]][],
    string[],
  ];
  const claimedEntries = claimed?.[1] ?? [];
  const result = await redis.xreadgroup("GROUP", GROUP, CONSUMER, "COUNT", "50", "STREAMS", stream, ">");
  const freshEntries = result ? (result as [string, [string, string[]][]][])[0][1] : [];

  let forwarded = 0;
  for (const [entryId, fields] of [...claimedEntries, ...freshEntries]) {
    const event = parseFields(fields, entityType);
    const outcome = await forwardEvent(event);
    if (outcome === "delivered" || outcome === "skipped") {
      await redis.xack(stream, GROUP, entryId);
      if (outcome === "delivered") forwarded++;
      continue;
    }
    // "retry": dead-letter past the threshold, else leave un-acked for a future pass.
    const pending = await redis.xpending(stream, GROUP, entryId, entryId, 1);
    const deliveryCount = Array.isArray(pending) && pending[0] ? Number((pending[0] as unknown[])[3]) : 1;
    if (deliveryCount >= BRIDGE_DEAD_LETTER_MAX_RETRIES) {
      await redis.xadd(`${stream}:n8n-dead-letter`, "*", ...fields);
      await redis.xack(stream, GROUP, entryId);
      // eslint-disable-next-line no-console
      console.error("[N8N-BRIDGE-DEAD-LETTER]", { stream, entryId, eventType: event.eventType, tenantId: event.tenantId, deliveryCount });
    }
  }
  return forwarded;
}

export function startN8nBridgeLoop(entityTypes: string[], intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const t of entityTypes) {
      try {
        await bridgeOnce(t);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`n8n-bridge tick failed for ${t}:`, (err as Error).message);
      }
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
