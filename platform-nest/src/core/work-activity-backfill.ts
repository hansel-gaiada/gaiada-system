// WSUX-15 (ex-P1-05) — one-shot backfill: populate `work_activity` from the pre-existing flat
// `activities` audit table (see http.ts's writeActivity — the "existing flat audit table" the
// work-activity.controller.ts header distinguishes itself from) so the department console's
// ActivityFeed isn't blank for history that predates this ticket's outbox consumer
// (work-activity-consumer.ts). Idempotent by construction: `activities.id` (globally unique) is
// used as the `sourceRef` half of ingestWorkActivity's (tenant, source, source_ref) upsert key, so
// re-running this backfill (e.g. on every restart, per main.ts's Redis-gated startup call) never
// creates a duplicate row or double-emits `work_activity.created`.
//
// SCOPE: only the `activities.target_entity_type` values this ticket's live stream list also
// covers — pm_task, pm_project, pm_doc, meeting_recording — have a historical trail worth
// backfilling. pipeline_run has NO writeActivity call under that entityType (its writeActivity
// calls are for pipeline_gate/scope_signoff, both out of this ticket's scoped stream list — see
// work-activity-consumer.ts's mapPipelineRun comment), so pipeline_run activity only starts
// appearing from the live consumer forward; there is no historical pipeline_run backfill source.
// This is a deliberate scope boundary, not an oversight — flagged in the ticket return.
//
// TR-05: pm_doc added — pm.controller.ts's doc handlers have always called writeActivity(...,
// "pm_doc", docId, ...) (created/updated/restored), so that history predates this ticket's
// pm.doc.* outbox events and is backfillable the same way pm_task/pm_project already were.
// object_kind is 'doc' here to match the live consumer's mapPmDoc (surfaces via
// deliverable_evidence). Comment history is DELIBERATELY NOT backfilled: writeActivity's
// "commented" rows are filed under whatever entityType the caller passed (e.g. "task", shared
// across subsystems — see collab.controller.ts), so a backfill would need to join against
// pm_tasks to tell a PM comment apart from a non-PM one; flagged as a follow-up, not attempted
// here — comment activity starts from this ticket's live consumer go-live forward only.
import { withGlobal, withTenants } from "../db";
import { ingestWorkActivity, type WorkActivityIngestInput } from "./work-activity-ingest.service";

type BackfillSource = "pm" | "system";

const ENTITY_MAP: Record<string, { source: BackfillSource; objectKind: string }> = {
  pm_task: { source: "pm", objectKind: "pm_task" },
  pm_project: { source: "pm", objectKind: "project" },
  pm_doc: { source: "pm", objectKind: "doc" },
  meeting_recording: { source: "system", objectKind: "meeting_recording" },
};
const ENTITY_TYPES = Object.keys(ENTITY_MAP);

interface ActivityRow {
  id: string;
  actor_id: string | null;
  verb: string;
  target_entity_type: string;
  target_entity_id: string | null;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

/** Best-effort title fallback when `activities.metadata` didn't carry one (most non-"created"
 *  verbs don't) — same lookup tables the live consumer uses for the same reason. NULL-tolerant: a
 *  row the lookup can't find (already hard-deleted) still backfills, just with title=null. */
async function fallbackTitle(tenantId: string, entityType: string, entityId: string): Promise<string | null> {
  if (entityType === "pm_task") {
    const r = await withTenants([tenantId], (c) => c.query<{ title: string }>(`SELECT title FROM pm_tasks WHERE id = $1`, [entityId]));
    return r.rows[0]?.title ?? null;
  }
  if (entityType === "pm_project") {
    const r = await withTenants([tenantId], (c) => c.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [entityId]));
    return r.rows[0]?.name ?? null;
  }
  if (entityType === "meeting_recording") {
    const r = await withTenants([tenantId], (c) => c.query<{ title: string | null }>(`SELECT title FROM meeting_recordings WHERE id = $1`, [entityId]));
    return r.rows[0]?.title ?? null;
  }
  if (entityType === "pm_doc") {
    const r = await withTenants([tenantId], (c) => c.query<{ title: string }>(`SELECT title FROM pm_docs WHERE id = $1`, [entityId]));
    return r.rows[0]?.title ?? null;
  }
  return null;
}

async function docProjectId(tenantId: string, docId: string): Promise<string | undefined> {
  const r = await withTenants([tenantId], (c) => c.query<{ project_id: string }>(`SELECT project_id FROM pm_docs WHERE id = $1`, [docId]));
  return r.rows[0]?.project_id;
}

async function hintPayload(tenantId: string, entityType: string, entityId: string): Promise<Record<string, unknown>> {
  if (entityType === "pm_task") return { taskId: entityId };
  if (entityType === "pm_project") return { projectId: entityId };
  if (entityType === "pm_doc") {
    const projectId = await docProjectId(tenantId, entityId);
    return { docId: entityId, ...(projectId ? { projectId } : {}) };
  }
  return {};
}

/** Fold the actor id into the payload if known, matching work-activity-consumer.ts's TR-31
 *  pattern: the linker's rule (a) reads payload.actorId to mint exact person links. If the
 *  actor is unknown (activities.actor_id is NULL — system/service actors), the payload carries
 *  no actorId hint, and no person link is created. Never guessed or inferred. */
function mergeActorIntoPayload(payload: Record<string, unknown>, actorUserId: string | null): Record<string, unknown> {
  return actorUserId ? { ...payload, actorId: actorUserId } : payload;
}

/** Backfills one company's history; returns how many NEW work_activity rows this pass inserted
 *  (a rerun over already-backfilled rows reports 0 — every row dedupes via `deduped: true`). */
async function backfillTenant(tenantId: string): Promise<number> {
  const rows = await withTenants([tenantId], (c) =>
    c.query<ActivityRow>(
      `SELECT id, actor_id, verb, target_entity_type, target_entity_id, metadata, occurred_at
       FROM activities
       WHERE target_entity_type = ANY($1::text[]) AND target_entity_id IS NOT NULL
       ORDER BY occurred_at ASC`,
      [ENTITY_TYPES],
    ),
  );

  let inserted = 0;
  for (const row of rows.rows) {
    const mapping = ENTITY_MAP[row.target_entity_type];
    if (!mapping) continue; // defensive; ANY($1) already filters to ENTITY_TYPES
    const entityId = row.target_entity_id!;
    const metaTitle = typeof row.metadata?.title === "string" ? (row.metadata.title as string) : null;
    const title = metaTitle ?? (await fallbackTitle(tenantId, row.target_entity_type, entityId));

    // TR-33: fold the propagated actor into the ingest payload (matching work-activity-consumer.ts's
    // dispatchWorkActivity) — ingestWorkActivity hands `payload` straight to the linker (deriveLinks),
    // whose rule (a) reads payload.actorId to mint an EXACT person link. If actor_id is unknown
    // (NULL — system/service actors), no actorId hint is added and no person link is created.
    const hintPayloadResult = await hintPayload(tenantId, row.target_entity_type, entityId);
    const payload = mergeActorIntoPayload(hintPayloadResult, row.actor_id);

    const input: WorkActivityIngestInput = {
      source: mapping.source,
      sourceRef: row.id,
      actorUserId: row.actor_id,
      verb: row.verb,
      objectKind: mapping.objectKind,
      objectRef: entityId,
      title,
      payload,
      occurredAt: row.occurred_at,
    };
    const result = await ingestWorkActivity(tenantId, input);
    if (!result.deduped) inserted++;
  }
  return inserted;
}

/** Runs once across every company. Tenants are enumerated via `withGlobal` reading the platform's
 *  own `companies` table (the same non-RLS global-table pattern core.controller.ts's D12 rollups
 *  list and relay.ts's poller already use — never client input), then each tenant's actual
 *  activities/work_activity read+write runs through its OWN single-element `withTenants([tenantId],
 *  ...)` leg (A1 lint clean, no new allowlist entry — one tenant's RLS scope per call, exactly the
 *  house convention). */
export async function runWorkActivityBackfill(): Promise<{ tenants: number; inserted: number }> {
  const companies = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`));
  let inserted = 0;
  for (const { id } of companies.rows) {
    inserted += await backfillTenant(id);
  }
  return { tenants: companies.rows.length, inserted };
}
