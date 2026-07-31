// WSUX-15 (ex-P1-05 / TR-05) — the outbox-driven consumer that makes the built P1-04 `work_activity`
// feed LIVE: a DEDICATED consumer group ("work-activity"), independent of the module-dispatch group
// in consumer.service.ts and the reconciler group in reconcile-consumer.ts, over the streams a
// department's activity actually happens on: pm_task, pm_project, pm_doc, meeting_recording,
// pipeline_run.
//
// TR-05 additions on top of the original WSUX-15 build: pm_doc (doc create/update/restore,
// pm.controller.ts) and comment events (pm.task.commented, emitted onto the EXISTING pm_task
// stream by collab.controller.ts, guarded there to only fire when the commented entity is a real
// pm_tasks row) — plus is_done-FLAG-derived verb classification for task status changes (see
// deriveVerb below): completed/reopened/status_changed, never a literal status id.
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
// TR-31 (closed the KNOWN LIMITATION formerly documented here): pm.controller.ts /
// collab.controller.ts / meetings.controller.ts / pipeline.controller.ts now attach the acting
// user's id onto the outbox payload as `actorId` (the SAME structured-hint key
// work-activity-linker.ts's rule (a) already looked for — see migration 0030's payload column
// comment: "raw source payload + structured link hints (taskId/projectId/actorId)"). This
// consumer reads it generically off the RAW event payload (actorUserIdOf, below) — never off a
// mapper's reshaped payload — so every current and future entityType mapper picks it up for free
// without needing its own actor-extraction logic. Folded into both the dedicated actor_user_id
// column AND the ingest payload (so the linker's exact person-link rule actually fires; it
// existed since P1-04 but had nothing to read until now).
//
// Deliberately still null for genuinely system/AI-originated entries — the controllers simply
// never attach actorId at the emit site for those (recurrence auto-spawn, the AI Tracker run, an
// async transcription job with no request principal, an admin reconciliation sweep over other
// people's recordings): see each call site's own TR-31 comment. Never guessed, never defaulted.
// Also tolerant of events already in flight / already relayed before this ticket landed — those
// simply have no `actorId` key at all, so actorUserIdOf returns null exactly as the old hardcoded
// `null` did (no consumer crash, no special-casing needed for the backlog).
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
export const WORK_ACTIVITY_STREAMS = ["pm_task", "pm_project", "pm_doc", "meeting_recording", "pipeline_run"];
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

/** pm_doc (TR-05) — created/updated/restored events already carry {title, projectId} in the
 *  outbox payload (pm.controller.ts's doc handlers pass them explicitly), so the DB fallback below
 *  is defensive only (mirrors mapPmTask's NULL-tolerant convention) and is never expected to fire
 *  in practice. object_kind is 'doc' (not 'pm_doc') so this activity also surfaces via the
 *  deliverable_evidence view (migration 0030 filters object_kind IN ('file','doc','deliverable')). */
async function mapPmDoc(tenantId: string, event: OutboxEvent): Promise<Mapped> {
  let title = typeof event.payload.title === "string" ? event.payload.title : null;
  let projectId = typeof event.payload.projectId === "string" ? event.payload.projectId : undefined;
  if (title === null || projectId === undefined) {
    const row = await withTenants([tenantId], (c) =>
      c.query<{ title: string; project_id: string }>(`SELECT title, project_id FROM pm_docs WHERE id = $1`, [event.entityId]),
    );
    if (row.rows[0]) {
      title = title ?? row.rows[0].title;
      projectId = projectId ?? row.rows[0].project_id;
    }
  }
  return {
    source: "pm",
    objectKind: "doc",
    title,
    payload: { docId: event.entityId, ...(projectId ? { projectId } : {}) },
  };
}

/** meeting_recording — sourced as "system" (an automated capture/ingest pipeline step, not a
 *  person's manual PM action; see the migration header's "system-generated rows" category). Title
 *  and the optional project hint (so auto-linking can chain meeting -> project -> department) come
 *  from meeting_recordings, since none of its outbox payloads carry a title.
 *  TR-31 note: `source: "system"` here is the work_activity CATEGORY bucket, a separate concept
 *  from actor attribution — meetings.controller.ts still attaches a real `actorId` to the
 *  per-request lifecycle events (start/update/transcript/upload/ingest/drive), so these rows CAN
 *  carry a genuine actor_user_id even while bucketed "system". Only the truly principal-less
 *  events (the detached transcription job, the admin relink sweep) stay actor-less. */
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
  pm_doc: mapPmDoc,
  meeting_recording: mapMeetingRecording,
  pipeline_run: mapPipelineRun,
};

/** pm.task.updated carries FLAG-DRIVEN completion facts (statusChanged/wasDone/isDoneNow)
 *  precomputed by pm.controller.ts's patchTask via effectiveStatuses()'s is_done FLAG — never a
 *  literal status id (0040/§3.2 discipline: a renamed or custom "done" status must still count).
 *  This consumer REUSES those booleans rather than re-deriving is_done itself, so there is exactly
 *  one place in the codebase that decides is_done-ness. A patch that didn't change status at all
 *  (statusChanged !== true) falls through to the generic eventType-tail verb below, same as every
 *  other stream/eventType this consumer handles. */
function deriveVerb(event: OutboxEvent): string {
  if (event.entityType === "pm_task" && event.eventType === "pm.task.updated" && event.payload.statusChanged === true) {
    const wasDone = event.payload.wasDone === true;
    const isDoneNow = event.payload.isDoneNow === true;
    if (isDoneNow && !wasDone) return "completed";
    if (wasDone && !isDoneNow) return "reopened";
    return "status_changed";
  }
  return event.eventType.includes(".") ? event.eventType.slice(event.eventType.lastIndexOf(".") + 1) : event.eventType;
}

/** TR-31 — the acting user id, read generically off the RAW outbox payload (never the mapper's
 *  reshaped one, so this works for every entityType without per-mapper plumbing). Only a
 *  non-empty string is honored; anything else (absent, non-string, an in-flight pre-TR-31 event)
 *  is "no known actor" — never guessed. */
function actorUserIdOf(event: OutboxEvent): string | null {
  const v = event.payload.actorId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Same shape for the external-actor tag some system/service call sites attach (e.g.
 *  "pm:recurrence-engine", "whisper-worker") instead of a platform user id. */
function actorExternalOf(event: OutboxEvent): string | null {
  const v = event.payload.actorExternal;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Route one outbox entry to a work_activity row. An entityType/eventType this consumer doesn't
 *  map is a silent no-op (still ACKed) — mirrors reconcile-consumer.ts's dispatch() convention for
 *  "unrelated event on a shared stream". */
export async function dispatchWorkActivity(event: OutboxEvent): Promise<void> {
  const mapper = MAPPERS[event.entityType];
  if (!mapper) return;
  const mapped = await mapper(event.tenantId, event);
  const verb = deriveVerb(event);
  // TR-31: fold the propagated actor into BOTH the dedicated actor_user_id column (below) and the
  // ingest payload — ingestWorkActivity hands `payload` straight to the pure linker (deriveLinks),
  // whose rule (a) reads payload.actorId to mint an EXACT person link (work-activity-linker.ts).
  // Mappers above build `mapped.payload` from scratch (taskId/projectId hints, no actorId), so it
  // has to be merged in here rather than relying on any mapper to carry it through.
  const actorUserId = actorUserIdOf(event);
  const payload = actorUserId ? { ...mapped.payload, actorId: actorUserId } : mapped.payload;
  const input: WorkActivityIngestInput = {
    source: mapped.source,
    // The outbox event's OWN id is the idempotency key — stable across every redelivery of this
    // SAME entry, so a crash-and-retry or an XAUTOCLAIM reclaim always upserts, never duplicates.
    sourceRef: event.id,
    actorUserId,
    actorExternal: actorUserId ? null : actorExternalOf(event),
    verb,
    objectKind: mapped.objectKind,
    objectRef: event.entityId,
    title: mapped.title,
    payload,
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
