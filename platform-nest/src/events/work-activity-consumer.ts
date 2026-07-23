// WSUX-15 (ex-P1-05) — the outbox-driven consumer that makes the built P1-04 `work_activity` feed
// LIVE: a DEDICATED consumer group ("work-activity"), independent of the module-dispatch group in
// consumer.service.ts and the reconciler group in reconcile-consumer.ts, over the streams a
// department's activity actually happens on: pm_task, pm_project, meeting_recording, pipeline_run.
// Mirrors reconcile-consumer.ts's shape exactly (own group/consumer name, XAUTOCLAIM + XREADGROUP,
// ack-only-on-success, delivery-count-gated dead-letter) — see that file's header for why a
// dedicated group is the right shape (every group gets its own copy of every entry + its own retry
// accounting, so this consumer's failures/redeliveries can never interfere with module dispatch or
// the reconciler).
//
// Idempotency: `ingestWorkActivity`'s (tenant, source, source_ref) UNIQUE key is the same
// idempotency boundary the controller's synchronous ingest already relies on (see
// work-activity-ingest.service.ts). This consumer uses the outbox event's OWN id (`event.id`,
// stable across every redelivery of the same entry) as `sourceRef` — so a crash-and-redeliver, or
// XAUTOCLAIM reclaiming a stuck entry, always upserts the SAME work_activity row rather than
// minting a duplicate. `work_activity.created` is only emitted on the row's first insert (see the
// ingest core), so a replay never double-fires downstream automation either.
//
// KNOWN LIMITATION (flagged, not silently absorbed): the outbox event payloads emitted today by
// pm.controller.ts / meetings.controller.ts / pipeline.controller.ts do not carry the acting
// user's id (that's captured separately, per-call, in the flat `activities` audit table via
// writeActivity() — see http.ts). So actorUserId is left null on every consumer-derived
// work_activity row; the ActivityFeed contract (activityLabel/actorLabel in
// platform-ui/src/lib/activity.ts) already renders a null actor gracefully (no crash, just an
// unattributed line). Wiring actor identity through emitEvent's payload is a natural follow-up but
// is a change to five existing emit call sites outside this ticket's scope — flagged as a
// deviation, not fixed here.
import { hostname } from "os";
import { randomBytes } from "crypto";
import { recordDeadLetter, recordEventConsumed, recordProcessingLag } from "../metrics";
import { getRedis } from "./redis";
import { withTenants } from "../db";
import { ingestWorkActivity, type WorkActivityIngestInput } from "../core/work-activity-ingest.service";
import type { OutboxEvent } from "./types";

const GROUP = "work-activity";
// UNIQUE per process (host + pid + random) — same rationale as reconcile-consumer.ts's CONSUMER:
// two platform instances must register as distinct consumers so XREADGROUP ">" fans each entry out
// to exactly one of them instead of splitting one consumer's pending set across both.
const CONSUMER = `work-activity-${hostname()}-${process.pid}-${randomBytes(4).toString("hex")}`;
export const WORK_ACTIVITY_STREAMS = ["pm_task", "pm_project", "meeting_recording", "pipeline_run"];
export const DEAD_LETTER_MAX_RETRIES = 5;
// Unlike reconcile-consumer.ts's 60s guard (which exists to prevent two instances racing a
// non-idempotent multi-step teardown), min-idle-time 0 is safe HERE: ingestWorkActivity's every
// write is an upsert keyed on (tenant, source, source_ref) = a stable per-entry key (the outbox
// event's own id), so even a live sibling "theft" (two instances both claim + process the same
// pending entry) converges to the identical row — never a duplicate, never partial state. This
// also matches consumer.service.ts's own module-dispatch group (min-idle-time 0), the closer
// analogue for a single-write, idempotent handler.
const CLAIM_MIN_IDLE_MS = 0;

type WorkActivitySource = "pm" | "pipeline" | "system";

interface Mapped {
  source: WorkActivitySource;
  objectKind: string;
  title: string | null;
  payload: Record<string, unknown>;
}

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

/** pm.task.* — created events already carry {title, projectId} in the outbox payload; anything
 *  else (updated/deleted/tracker/suggestion events) falls back to a light lookup so the feed still
 *  gets a human title/project hint instead of a bare uuid. NULL-tolerant: a task the lookup can't
 *  find (e.g. already hard-deleted in a race) still ingests, just with title=null. */
async function mapPmTask(tenantId: string, event: OutboxEvent): Promise<Mapped> {
  let title = typeof event.payload.title === "string" ? event.payload.title : null;
  let projectId = typeof event.payload.projectId === "string" ? event.payload.projectId : undefined;
  if (title === null || projectId === undefined) {
    const row = await withTenants([tenantId], (c) =>
      c.query<{ title: string; project_id: string }>(`SELECT title, project_id FROM pm_tasks WHERE id = $1`, [event.entityId]),
    );
    if (row.rows[0]) {
      title = title ?? row.rows[0].title;
      projectId = projectId ?? row.rows[0].project_id;
    }
  }
  return {
    source: "pm",
    objectKind: "pm_task",
    title,
    payload: { taskId: event.entityId, ...(projectId ? { projectId } : {}) },
  };
}

async function mapPmProject(tenantId: string, event: OutboxEvent): Promise<Mapped> {
  const row = await withTenants([tenantId], (c) =>
    c.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [event.entityId]),
  );
  return { source: "pm", objectKind: "project", title: row.rows[0]?.name ?? null, payload: { projectId: event.entityId } };
}

/** meeting_recording — sourced as "system" (an automated capture/ingest pipeline step, not a
 *  person's manual PM action; see the migration header's "system-generated rows" category). Title
 *  and the optional project hint (so auto-linking can chain meeting -> project -> department) come
 *  from meeting_recordings, since none of its outbox payloads carry a title. */
async function mapMeetingRecording(tenantId: string, event: OutboxEvent): Promise<Mapped> {
  const row = await withTenants([tenantId], (c) =>
    c.query<{ title: string | null; project_id: string | null }>(
      `SELECT title, project_id FROM meeting_recordings WHERE id = $1`,
      [event.entityId],
    ),
  );
  const projectId = row.rows[0]?.project_id ?? undefined;
  return {
    source: "system",
    objectKind: "meeting_recording",
    title: row.rows[0]?.title ?? null,
    payload: projectId ? { projectId } : {},
  };
}

/** pipeline_run — only `pipeline.run.created` is emitted on this entityType (stage/gate advances
 *  emit under the separate pipeline_stage/pipeline_gate entityTypes, out of this ticket's scoped
 *  stream list), and its payload already carries `title`, so no extra lookup is needed. */
async function mapPipelineRun(_tenantId: string, event: OutboxEvent): Promise<Mapped> {
  const title = typeof event.payload.title === "string" ? event.payload.title : null;
  return { source: "pipeline", objectKind: "pipeline_run", title, payload: {} };
}

const MAPPERS: Record<string, (tenantId: string, event: OutboxEvent) => Promise<Mapped>> = {
  pm_task: mapPmTask,
  pm_project: mapPmProject,
  meeting_recording: mapMeetingRecording,
  pipeline_run: mapPipelineRun,
};

/** Route one outbox entry to a work_activity row. An entityType/eventType this consumer doesn't
 *  map is a silent no-op (still ACKed) — mirrors reconcile-consumer.ts's dispatch() convention for
 *  "unrelated event on a shared stream". */
export async function dispatchWorkActivity(event: OutboxEvent): Promise<void> {
  const mapper = MAPPERS[event.entityType];
  if (!mapper) return;
  const mapped = await mapper(event.tenantId, event);
  const verb = event.eventType.includes(".") ? event.eventType.slice(event.eventType.lastIndexOf(".") + 1) : event.eventType;
  const input: WorkActivityIngestInput = {
    source: mapped.source,
    // The outbox event's OWN id is the idempotency key — stable across every redelivery of this
    // SAME entry, so a crash-and-retry or an XAUTOCLAIM reclaim always upserts, never duplicates.
    sourceRef: event.id,
    actorUserId: null,
    verb,
    objectKind: mapped.objectKind,
    objectRef: event.entityId,
    title: mapped.title,
    payload: mapped.payload,
    occurredAt: event.createdAt,
  };
  await ingestWorkActivity(event.tenantId, input);
}

export async function consumeWorkActivityOnce(stream: string): Promise<number> {
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
      await dispatchWorkActivity(event);
      await redis.xack(key, GROUP, entryId);
      recordEventConsumed(stream, true);
      recordProcessingLag(stream, event.createdAt);
      handled++;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`work-activity consumer failed (event=${event.eventType}, id=${event.entityId}):`, (err as Error).message);
      recordEventConsumed(stream, false);
      const pending = await redis.xpending(key, GROUP, entryId, entryId, 1);
      const deliveryCount = Array.isArray(pending) && pending[0] ? Number((pending[0] as unknown[])[3]) : 1;
      if (deliveryCount >= DEAD_LETTER_MAX_RETRIES) {
        await redis.xadd(`${key}:work-activity-dead-letter`, "*", ...fields);
        await redis.xack(key, GROUP, entryId);
        recordDeadLetter(stream, event.eventType);
        // eslint-disable-next-line no-console
        console.error("[WORK-ACTIVITY-DEAD-LETTER]", { stream, entryId, eventType: event.eventType, deliveryCount });
      }
      // under the threshold: leave un-ACKed for redelivery (durable retry)
    }
  }
  return handled;
}

export function startWorkActivityConsumerLoop(intervalMs = 500): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    for (const s of WORK_ACTIVITY_STREAMS) {
      try {
        await consumeWorkActivityOnce(s);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`work-activity consumer tick failed for ${s}:`, (err as Error).message);
      }
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return { stop: () => { stopped = true; } };
}
