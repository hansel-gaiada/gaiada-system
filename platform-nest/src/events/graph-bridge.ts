// Event → knowledge-graph bridge (WS8 Step E live wire, D9.2 "the indexer subscribes to source
// changes"). A SEPARATE Redis consumer group ("graph-bridge") over the same entity_type streams,
// forwarding every business event to the WS8 knowledge service's /graph/ingest, which maps it to
// source-of-truth graph nodes + edges. Own group so its acks never interfere with module dispatch or
// the n8n bridge. Not tenant-gated (infra, like the relay). At-least-once: /graph/ingest upserts by
// (tenant, entity_key), so redelivery is idempotent.
import { config } from "../config";
import { getRedis } from "./redis";
import type { OutboxEvent } from "./types";

const GROUP = "graph-bridge";
const CONSUMER = "graph-1";
export const GRAPH_BRIDGE_DEAD_LETTER_MAX_RETRIES = 5;

export type ForwardResult = "delivered" | "retry";

/** POST one event to the knowledge service /graph/ingest as a PlatformEvent. */
export async function forwardToGraph(e: OutboxEvent): Promise<ForwardResult> {
  const url = `${config.services.knowledge.url.replace(/\/$/, "")}/graph/ingest`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.graphBridge.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ac.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.services.knowledge.token}` },
      body: JSON.stringify({
        eventType: e.eventType,
        tenantId: e.tenantId,
        entityType: e.entityType,
        entityId: e.entityId,
        payload: e.payload,
      }),
    });
    if (res.ok) return "delivered";
    return res.status >= 500 ? "retry" : "delivered"; // 4xx: ack (don't loop); 5xx: retry
  } catch {
    return "retry";
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

export async function graphBridgeOnce(entityType: string): Promise<number> {
  const redis = getRedis();
  const stream = `events:${entityType}`;
  await ensureGroup(stream);

  const claimed = (await redis.xautoclaim(stream, GROUP, CONSUMER, 0, "0", "COUNT", "50")) as [string, [string, string[]][], string[]];
  const claimedEntries = claimed?.[1] ?? [];
  const result = await redis.xreadgroup("GROUP", GROUP, CONSUMER, "COUNT", "50", "STREAMS", stream, ">");
  const freshEntries = result ? (result as [string, [string, string[]][]][])[0][1] : [];

  let forwarded = 0;
  for (const [entryId, fields] of [...claimedEntries, ...freshEntries]) {
    const event = parseFields(fields, entityType);
    const outcome = await forwardToGraph(event);
    if (outcome === "delivered") {
      await redis.xack(stream, GROUP, entryId);
      forwarded++;
      continue;
    }
    const pending = await redis.xpending(stream, GROUP, entryId, entryId, 1);
    const deliveryCount = Array.isArray(pending) && pending[0] ? Number((pending[0] as unknown[])[3]) : 1;
    if (deliveryCount >= GRAPH_BRIDGE_DEAD_LETTER_MAX_RETRIES) {
      await redis.xadd(`${stream}:graph-dead-letter`, "*", ...fields);
      await redis.xack(stream, GROUP, entryId);
      // eslint-disable-next-line no-console
      console.error("[GRAPH-BRIDGE-DEAD-LETTER]", { stream, entryId, eventType: event.eventType, tenantId: event.tenantId, deliveryCount });
    }
  }
  return forwarded;
}

export function startGraphBridgeLoop(entityTypes: string[], intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const t of entityTypes) {
      try {
        await graphBridgeOnce(t);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`graph-bridge tick failed for ${t}:`, (err as Error).message);
      }
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
