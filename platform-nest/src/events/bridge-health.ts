// Event → n8n bridge health (read-only, for the Automation admin console).
//
// The bridge is the delivery path that makes event-triggered workflows fire at all. Until now it
// was observable only through logs and WS9 metrics, so a stalled bridge looked identical to a
// healthy one in the console: workflows simply stopped running with no visible cause. This module
// reads the same Redis Streams the bridge itself uses and reports, per watched entity stream:
//   - backlog   : entries pending for the "n8n-bridge" consumer group (un-acked → not yet delivered)
//   - deadLetter: entries parked on <stream>:n8n-dead-letter after BRIDGE_DEAD_LETTER_MAX_RETRIES
//   - oldestPendingMs: age of the oldest un-acked entry — the actual "are we falling behind" signal
//
// Fail-soft by construction: Redis unreachable / stream never created / group not yet created all
// degrade to a per-stream `error` string rather than throwing, because a health READ must never be
// the thing that breaks the page it is reporting on.
import { config, n8nBridgeEnabled } from "../config";
import { getRedis } from "./redis";
import { BRIDGE_DEAD_LETTER_MAX_RETRIES } from "./n8n-bridge";

const GROUP = "n8n-bridge";

export interface BridgeStreamHealth {
  entityType: string;
  stream: string;
  backlog: number;
  deadLetter: number;
  oldestPendingMs: number | null;
  error?: string;
}

export interface BridgeHealth {
  /** The bridge only starts when webhook URL + secret + event list + stream list are ALL set. */
  enabled: boolean;
  webhookConfigured: boolean;
  secretConfigured: boolean;
  /** Event types allowed to cross to n8n — anything else is acked and dropped as "skipped". */
  events: string[];
  maxRetries: number;
  timeoutMs: number;
  streams: BridgeStreamHealth[];
  /** Set when the bridge is configured but Redis itself couldn't be reached at all. */
  error?: string;
}

/** Age in ms of the oldest pending entry, derived from its stream id (`<ms>-<seq>`). */
function pendingAgeMs(entryId: string | undefined, now: number): number | null {
  if (!entryId) return null;
  const ms = Number(entryId.split("-")[0]);
  return Number.isFinite(ms) ? Math.max(0, now - ms) : null;
}

async function streamHealth(entityType: string, now: number): Promise<BridgeStreamHealth> {
  const stream = `events:${entityType}`;
  const row: BridgeStreamHealth = { entityType, stream, backlog: 0, deadLetter: 0, oldestPendingMs: null };
  const redis = getRedis();
  try {
    // XPENDING summary: [count, minId, maxId, consumers]. A missing group (bridge never ran) throws
    // NOGROUP — that is "no backlog", not an error worth surfacing.
    const summary = (await redis.xpending(stream, GROUP)) as [number, string | null, string | null, unknown] | null;
    if (Array.isArray(summary)) {
      row.backlog = Number(summary[0] ?? 0);
      row.oldestPendingMs = pendingAgeMs(summary[1] ?? undefined, now);
    }
  } catch (e) {
    if (!/NOGROUP/i.test((e as Error).message)) row.error = (e as Error).message;
  }
  try {
    row.deadLetter = await redis.xlen(`${stream}:n8n-dead-letter`);
  } catch {
    row.deadLetter = 0; // no dead-letter stream yet == nothing dead-lettered
  }
  return row;
}

/** Move dead-lettered entries back onto the source stream so the bridge's consumer group redelivers
 *  them. This is the operator's retry for "the workflow never ran because delivery failed".
 *
 *  Ordering matters and is deliberate: each entry is re-added to the source stream FIRST and only
 *  then removed from the dead-letter stream. A crash between the two duplicates a delivery, which
 *  the bridge is already built for (it is at-least-once, and n8n dedupes on the envelope `id`) —
 *  whereas the reverse order could lose the event permanently.
 *
 *  Unlike the health read, this THROWS: a replay that silently did nothing would be worse than an
 *  error, because the operator would believe the events were requeued. */
export async function replayBridgeDeadLetters(
  entityType: string,
  limit = 100,
): Promise<{ entityType: string; replayed: number; remaining: number }> {
  const redis = getRedis();
  const stream = `events:${entityType}`;
  const dl = `${stream}:n8n-dead-letter`;

  // Oldest-first: replaying in arrival order keeps per-entity event sequence intact.
  const entries = (await redis.xrange(dl, "-", "+", "COUNT", limit)) as [string, string[]][];
  let replayed = 0;
  for (const [entryId, fields] of entries ?? []) {
    await redis.xadd(stream, "*", ...fields);
    await redis.xdel(dl, entryId);
    replayed++;
  }
  const remaining = await redis.xlen(dl).catch(() => 0);
  return { entityType, replayed, remaining };
}

/** Snapshot of bridge delivery health. Never throws. */
export async function getBridgeHealth(): Promise<BridgeHealth> {
  const b = config.n8nBridge;
  const out: BridgeHealth = {
    enabled: n8nBridgeEnabled(),
    webhookConfigured: !!b.webhookBaseUrl,
    secretConfigured: !!b.secret,
    events: b.events,
    maxRetries: BRIDGE_DEAD_LETTER_MAX_RETRIES,
    timeoutMs: b.timeoutMs,
    streams: [],
  };
  if (b.entityTypes.length === 0) return out;
  const now = Date.now();
  try {
    getRedis(); // surfaces "REDIS_URL not set" once, rather than per stream
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  }
  out.streams = await Promise.all(b.entityTypes.map((t) => streamHealth(t, now)));
  return out;
}
