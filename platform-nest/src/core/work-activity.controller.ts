// P1-04 — work-activity CORE model: a normalized activity/evidence surface every module's real
// work lands on (pm task moves, pipeline stage advances, github/drive edits, claude/agent actions,
// manual entries), auto-linked to pm_task/project/person/department via the pure engine in
// work-activity-linker.ts. Deliberately NOT under `activities` or `audit` — those names are the
// existing flat audit table (core.controller.ts's GET :tenantId/activity), untouched here.
//
// SCOPE OF THIS TICKET (P1-04): schema + this ingest/read API + the pure linker + the Cerbos
// policy. The outbox CONSUMER that drives ingestion automatically off pm/pipeline/etc. events, and
// the historical backfill, are P1-05 (a separate ticket) — this controller is the synchronous
// surface that ticket plugs into; it is fully usable standalone (a caller — a human, a script, or
// P1-05's consumer — POSTs one activity at a time) in the meantime.
//
// Read = member (whole team references the evidence trail); ingest = admin/service principal
// (mirrors resource_rollup_recompute.yaml's company_admin-only "create" tier — this is a
// system-of-record write, not an everyday staff action, matching the "admin/service principal"
// gate the ticket locks).
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize } from "./http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { deriveLinks, scanUuids, type LinkerContext, type WorkActivityLink } from "./work-activity-linker";

const SOURCES = new Set(["pm", "pipeline", "github", "google_drive", "claude", "manual", "system"]);

interface IngestBody {
  source?: string;
  sourceRef?: string;
  actorUserId?: string;
  actorExternal?: string;
  verb?: string;
  objectKind?: string;
  objectRef?: string;
  title?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
  /** Optional extra free text to uuid-scan for auto-linking, beyond title (e.g. a description). */
  text?: string;
}

interface WorkActivityDbRow {
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
      // A scanned uuid that is ALSO a task/project id keeps that classification (checked above,
      // first-write-wins is fine here since the three id spaces do not legitimately collide).
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

@Controller("api")
@UseGuards(AuthGuard)
export class WorkActivityController {
  @Get(":tenantId/work-activity")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("deptId") deptId?: string,
    @Query("projectId") projectId?: string,
    @Query("personId") personId?: string,
    @Query("since") since?: string,
    @Query("limit") limitQ?: string,
  ) {
    await authorize(req.principal, { kind: "work_activity", tenantId }, "read");
    const limit = Math.max(1, Math.min(Number(limitQ ?? 100) || 100, 500));

    const clauses: string[] = [];
    const args: unknown[] = [];
    if (since) clauses.push(`wa.occurred_at >= $${args.push(since)}`);
    if (deptId) {
      clauses.push(
        `EXISTS (SELECT 1 FROM work_activity_links l WHERE l.activity_id = wa.id AND l.target_kind = 'department' AND l.target_id = $${args.push(deptId)})`,
      );
    }
    if (projectId) {
      clauses.push(
        `EXISTS (SELECT 1 FROM work_activity_links l WHERE l.activity_id = wa.id AND l.target_kind = 'project' AND l.target_id = $${args.push(projectId)})`,
      );
    }
    if (personId) {
      clauses.push(
        `EXISTS (SELECT 1 FROM work_activity_links l WHERE l.activity_id = wa.id AND l.target_kind = 'person' AND l.target_id = $${args.push(personId)})`,
      );
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const rows = await withTenants([tenantId], async (c) => {
      const activities = await c.query<WorkActivityDbRow>(
        `SELECT wa.id, wa.tenant_id, wa.source, wa.source_ref, wa.actor_user_id, wa.actor_external,
                wa.verb, wa.object_kind, wa.object_ref, wa.title, wa.payload, wa.occurred_at,
                wa.origin_site, wa.created_at
         FROM work_activity wa
         ${where}
         ORDER BY wa.occurred_at DESC
         LIMIT $${args.push(limit)}`,
        args,
      );
      if (!activities.rows.length) return { activities: activities.rows, links: [] as Array<{ activity_id: string; target_kind: string; target_id: string; confidence: string; rule: string }> };
      const ids = activities.rows.map((r) => r.id);
      const links = await c.query<{ activity_id: string; target_kind: string; target_id: string; confidence: string; rule: string }>(
        `SELECT activity_id, target_kind, target_id, confidence, rule FROM work_activity_links WHERE activity_id = ANY($1::uuid[])`,
        [ids],
      );
      return { activities: activities.rows, links: links.rows };
    });

    const linksByActivity = new Map<string, Array<{ targetKind: string; targetId: string; confidence: string; rule: string }>>();
    for (const l of rows.links) {
      const arr = linksByActivity.get(l.activity_id) ?? [];
      arr.push({ targetKind: l.target_kind, targetId: l.target_id, confidence: l.confidence, rule: l.rule });
      linksByActivity.set(l.activity_id, arr);
    }
    return rows.activities.map((a) => ({
      id: a.id,
      tenantId: a.tenant_id,
      source: a.source,
      sourceRef: a.source_ref,
      actorUserId: a.actor_user_id,
      actorExternal: a.actor_external,
      verb: a.verb,
      objectKind: a.object_kind,
      objectRef: a.object_ref,
      title: a.title,
      payload: a.payload,
      occurredAt: a.occurred_at,
      originSite: a.origin_site,
      createdAt: a.created_at,
      links: linksByActivity.get(a.id) ?? [],
    }));
  }

  // Idempotent ingest — the P1-05 outbox consumer (and, meanwhile, any admin/service caller) POSTs
  // one activity at a time; a redelivery of the same (source, sourceRef) upserts in place and never
  // double-emits `work_activity.created` or double-inserts links (both keyed on their own UNIQUEs).
  @Post(":tenantId/work-activity")
  @HttpCode(201)
  async ingest(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: IngestBody) {
    const { source, sourceRef, verb, objectKind, objectRef } = body ?? {};
    if (!source || !SOURCES.has(source)) throw new BadRequestException(`source must be one of ${[...SOURCES].join(",")}`);
    if (!sourceRef) throw new BadRequestException("sourceRef required (the idempotency key)");
    if (!verb) throw new BadRequestException("verb required");
    if (!objectKind) throw new BadRequestException("objectKind required");
    if (!objectRef) throw new BadRequestException("objectRef required");
    await authorize(req.principal, { kind: "work_activity", tenantId }, "create");

    const payload = body.payload ?? {};
    const id = newId();
    const result = await withTenants([tenantId], async (c) => {
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
          id, tenantId, source, sourceRef, body.actorUserId ?? null, body.actorExternal ?? null, verb,
          objectKind, objectRef, body.title ?? null, JSON.stringify(payload), body.occurredAt ?? null,
          config.originSite,
        ],
      );
      const row = upsert.rows[0];

      const scanText = [row.title ?? "", body.text ?? ""].filter(Boolean).join(" ");
      const ctx = await buildLinkerContext(c, payload, scanText);
      const links = deriveLinks({ source, payload, text: scanText }, ctx);
      await insertLinks(c, tenantId, row.id, links);

      // Only the FIRST ingest of a (tenant,source,sourceRef) emits the domain event — a redelivery
      // that lands on an existing row is a no-op signal-wise (P1-05's consumer relies on this so a
      // stream replay never double-fires downstream automation on the same real-world event).
      if (row.inserted) {
        await emitEvent(c, tenantId, "work_activity", row.id, "work_activity.created", {
          source, verb, objectKind, objectRef,
        });
      }
      return { row, links, deduped: !row.inserted };
    });

    return {
      id: result.row.id,
      tenantId: result.row.tenant_id,
      source: result.row.source,
      sourceRef: result.row.source_ref,
      actorUserId: result.row.actor_user_id,
      actorExternal: result.row.actor_external,
      verb: result.row.verb,
      objectKind: result.row.object_kind,
      objectRef: result.row.object_ref,
      title: result.row.title,
      payload: result.row.payload,
      occurredAt: result.row.occurred_at,
      originSite: result.row.origin_site,
      createdAt: result.row.created_at,
      links: result.links,
      deduped: result.deduped,
    };
  }
}
