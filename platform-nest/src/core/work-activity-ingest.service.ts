// WSUX-15 — the SHARED ingest core, extracted verbatim out of work-activity.controller.ts's
// `ingest()` handler so two callers (the HTTP controller, which still gates every write behind
// authorize()'s admin/service-principal check, and the NEW outbox consumer / one-shot backfill in
// this same ticket, which are internal event-driven writers with no HTTP principal to authorize —
// exactly the same "internal service function, no authorize() call" shape service-reconciler.ts's
// reconcileAssignment/reconcileProvider already use for the analogous ORG-6 reconcile-consumer) can
// share one upsert+link+emit implementation instead of two copies drifting apart.
//
// Tenant-scoped: a single withTenants([tenantId], ...) leg per call (A1 lint clean, no new
// allowlist entry — same shape as the controller's own withTenants call this replaces).
// Idempotent: UNIQUE(tenant_id, source, source_ref) upserts in place on redelivery/backfill re-run;
// `work_activity.created` is emitted to the outbox ONLY on the first insert (row.inserted), so a
// consumer replay or a backfill re-run never double-fires downstream automation.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { deriveLinks, scanUuids, type LinkerContext, type WorkActivityLink } from "./work-activity-linker";

export const WORK_ACTIVITY_SOURCES = new Set(["pm", "pipeline", "github", "google_drive", "claude", "manual", "system"]);

export interface WorkActivityIngestInput {
  source: string;
  sourceRef: string;
  actorUserId?: string | null;
  actorExternal?: string | null;
  verb: string;
  objectKind: string;
  objectRef: string;
  title?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: string | null;
  /** Optional extra free text to uuid-scan for auto-linking, beyond title. */
  text?: string;
}

export interface WorkActivityDbRow {
  id: string;
  tenant_id: string;
  source: string;
  source_ref: string;
  actor_user_id: string | null;
  actor_external: string | null;
  verb: string;
  object_kind: string;
  object_ref: string;
  title: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  origin_site: string;
  created_at: string;
}

export interface WorkActivityIngestResult {
  row: WorkActivityDbRow;
  links: WorkActivityLink[];
  deduped: boolean;
}

/** Controller-boundary I/O: resolve everything the pure linker needs, scoped to this tenant's RLS
 *  session. Never guesses — only uuids/hints this tenant actually owns end up in the context. */
async function buildLinkerContext(
  client: PoolClient,
  payload: Record<string, unknown>,
  scanText: string,
): Promise<LinkerContext> {
  const candidateIds = new Set<string>(scanUuids(scanText));
  const hintTaskId = typeof payload.taskId === "string" ? payload.taskId : undefined;
  const hintProjectId = typeof payload.projectId === "string" ? payload.projectId : undefined;
  if (hintTaskId) candidateIds.add(hintTaskId);
  if (hintProjectId) candidateIds.add(hintProjectId);
  const ids = [...candidateIds].filter((id) => /^[0-9a-f-]{36}$/i.test(id));

  const knownIds: LinkerContext["knownIds"] = {};
  const taskProject: Record<string, string> = {};
  const projectDepartment: Record<string, string | null> = {};

  if (ids.length) {
    const tasks = await client.query<{ id: string; project_id: string }>(
      `SELECT id, project_id FROM pm_tasks WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    for (const r of tasks.rows) {
      knownIds[r.id] = { kind: "pm_task" };
      taskProject[r.id] = r.project_id;
    }
    const projectIds = [...new Set([...ids, ...Object.values(taskProject)])];
    const projects = await client.query<{ id: string; department_id: string | null }>(
      `SELECT id, department_id FROM projects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [projectIds],
    );
    for (const r of projects.rows) {
      knownIds[r.id] = { kind: "project" };
      projectDepartment[r.id] = r.department_id;
    }
    const people = await client.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM company_memberships WHERE user_id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [ids],
    );
    for (const r of people.rows) {
      if (!knownIds[r.user_id]) knownIds[r.user_id] = { kind: "person" };
    }
  }

  return { knownIds, taskProject, projectDepartment, actorPerson: {} };
}

async function insertLinks(client: PoolClient, tenantId: string, activityId: string, links: WorkActivityLink[]): Promise<void> {
  for (const link of links) {
    await client.query(
      `INSERT INTO work_activity_links (id, tenant_id, activity_id, target_kind, target_id, confidence, rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (activity_id, target_kind, target_id) DO NOTHING`,
      [newId(), tenantId, activityId, link.targetKind, link.targetId, link.confidence, link.rule],
    );
  }
}

/** The shared ingest core. Validation of required fields is the CALLER's job (the controller
 *  throws 400s; the consumer/backfill only ever construct well-formed input from trusted event/
 *  activities-row data, so they skip that ceremony) — this function assumes a well-formed input. */
export async function ingestWorkActivity(tenantId: string, input: WorkActivityIngestInput): Promise<WorkActivityIngestResult> {
  const { source, sourceRef, verb, objectKind, objectRef } = input;
  const payload = input.payload ?? {};
  const id = newId();

  return withTenants([tenantId], async (c) => {
    const upsert = await c.query<WorkActivityDbRow & { inserted: boolean }>(
      `INSERT INTO work_activity
         (id, tenant_id, source, source_ref, actor_user_id, actor_external, verb, object_kind,
          object_ref, title, payload, occurred_at, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, now()), $13)
       ON CONFLICT (tenant_id, source, source_ref) DO UPDATE SET
         actor_user_id = EXCLUDED.actor_user_id, actor_external = EXCLUDED.actor_external,
         verb = EXCLUDED.verb, object_kind = EXCLUDED.object_kind, object_ref = EXCLUDED.object_ref,
         title = EXCLUDED.title, payload = EXCLUDED.payload, occurred_at = EXCLUDED.occurred_at
       RETURNING id, tenant_id, source, source_ref, actor_user_id, actor_external, verb, object_kind,
                 object_ref, title, payload, occurred_at, origin_site, created_at, (xmax = 0) AS inserted`,
      [
        id, tenantId, source, sourceRef, input.actorUserId ?? null, input.actorExternal ?? null, verb,
        objectKind, objectRef, input.title ?? null, JSON.stringify(payload), input.occurredAt ?? null,
        config.originSite,
      ],
    );
    const row = upsert.rows[0];

    const scanText = [row.title ?? "", input.text ?? ""].filter(Boolean).join(" ");
    const ctx = await buildLinkerContext(c, payload, scanText);
    const links = deriveLinks({ source, payload, text: scanText }, ctx);
    await insertLinks(c, tenantId, row.id, links);

    if (row.inserted) {
      await emitEvent(c, tenantId, "work_activity", row.id, "work_activity.created", {
        source, verb, objectKind, objectRef,
      });
    }
    return { row, links, deduped: !row.inserted };
  });
}
