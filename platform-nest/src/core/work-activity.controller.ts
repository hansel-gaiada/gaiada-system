// P1-04 — work-activity CORE model: a normalized activity/evidence surface every module's real
// work lands on (pm task moves, pipeline stage advances, github/drive edits, claude/agent actions,
// manual entries), auto-linked to pm_task/project/person/department via the pure engine in
// work-activity-linker.ts. Deliberately NOT under `activities` or `audit` — those names are the
// existing flat audit table (core.controller.ts's GET :tenantId/activity), untouched here.
//
// SCOPE OF THIS TICKET (P1-04): schema + this ingest/read API + the pure linker + the Cerbos
// policy. WSUX-15 (ex-P1-05, a separate ticket) built the outbox CONSUMER that drives ingestion
// automatically off pm/pipeline/meeting events, plus the historical backfill — both call the
// `ingestWorkActivity` core below (extracted out of this controller's own `ingest()` body so the
// synchronous HTTP surface and the event-driven writers share one upsert+link+emit implementation;
// see work-activity-ingest.service.ts's header). This controller's request/response CONTRACT is
// unchanged by that extraction.
//
// Read = member (whole team references the evidence trail); ingest = admin/service principal
// (mirrors resource_rollup_recompute.yaml's company_admin-only "create" tier — this is a
// system-of-record write, not an everyday staff action, matching the "admin/service principal"
// gate the ticket locks).
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import {
  ingestWorkActivity,
  relinkZeroLinkActivities,
  WORK_ACTIVITY_SOURCES as SOURCES,
  type WorkActivityDbRow,
} from "./work-activity-ingest.service";

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

  // WD-26: open pm_tasks with no linked work_activity in the last N days (default 5, 1..90). Feeds
  // the wd-stale-nag flow (nag the assignee at N days; also notify the project owner at 2N —
  // computed by the caller off the returned daysStale, so this stays a pure read). Read-tier
  // mirrors the base feed (member+) since it derives from the same work_activity/work_activity_links
  // surface, just re-shaped around pm_tasks.
  @Get(":tenantId/work-activity/stale-tasks")
  async staleTasks(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("days") daysQ?: string) {
    await authorize(req.principal, { kind: "work_activity", tenantId }, "read");
    const days = Math.max(1, Math.min(Number(daysQ ?? 5) || 5, 90));

    const rows = await withTenants([tenantId], (c) =>
      c.query<{
        task_id: string;
        title: string;
        project_id: string;
        project_name: string;
        assignee_user_id: string | null;
        assignee_name: string | null;
        project_owner_user_id: string | null;
        project_owner_name: string | null;
        reference_at: string;
      }>(
        `SELECT t.id AS task_id, t.title, t.project_id, p.name AS project_name,
                t.assignee->>'responsibleId' AS assignee_user_id, t.assignee->>'responsibleName' AS assignee_name,
                pm.owner->>'responsibleId' AS project_owner_user_id, pm.owner->>'responsibleName' AS project_owner_name,
                COALESCE(la.last_activity, t.created_at) AS reference_at
         FROM pm_tasks t
         JOIN projects p ON p.id = t.project_id AND p.deleted_at IS NULL
         LEFT JOIN pm_project_meta pm ON pm.tenant_id = t.tenant_id AND pm.project_id = t.project_id
         LEFT JOIN LATERAL (
           SELECT MAX(wa.occurred_at) AS last_activity
           FROM work_activity_links l
           JOIN work_activity wa ON wa.id = l.activity_id
           WHERE l.target_kind = 'pm_task' AND l.target_id = t.id::text
         ) la ON true
         WHERE t.tenant_id = $1 AND t.deleted_at IS NULL AND t.status <> 'done'
           AND COALESCE(la.last_activity, t.created_at) < now() - make_interval(days => $2::int)
         ORDER BY reference_at ASC
         LIMIT 200`,
        [tenantId, days],
      ),
    );

    const now = Date.now();
    return rows.rows.map((r) => ({
      taskId: r.task_id,
      title: r.title,
      projectId: r.project_id,
      projectName: r.project_name,
      assigneeUserId: r.assignee_user_id,
      assigneeName: r.assignee_name,
      projectOwnerUserId: r.project_owner_user_id,
      projectOwnerName: r.project_owner_name,
      daysStale: Math.floor((now - new Date(r.reference_at).getTime()) / 86_400_000),
    }));
  }

  // WD-26 deterministic relink sweep (LD-16): admin/service-only (same "create" tier as ingest —
  // this mutates work_activity_links). Idempotent: only rows with zero links are ever selected.
  @Post(":tenantId/work-activity/relink")
  @HttpCode(200)
  async relink(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("limit") limitQ?: string) {
    await authorize(req.principal, { kind: "work_activity", tenantId }, "create");
    const limit = Math.max(1, Math.min(Number(limitQ ?? 100) || 100, 500));
    return relinkZeroLinkActivities(tenantId, limit);
  }

  // Idempotent ingest — the WSUX-15 outbox consumer + one-shot backfill (and, meanwhile, any admin/
  // service caller) POST one activity at a time; a redelivery of the same (source, sourceRef)
  // upserts in place and never double-emits `work_activity.created` or double-inserts links (both
  // keyed on their own UNIQUEs) — see ingestWorkActivity in work-activity-ingest.service.ts, the
  // shared core this handler now delegates to (this handler stays the validation + authz boundary).
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

    const result = await ingestWorkActivity(tenantId, {
      source, sourceRef, verb, objectKind, objectRef,
      actorUserId: body.actorUserId, actorExternal: body.actorExternal,
      title: body.title, payload: body.payload, occurredAt: body.occurredAt, text: body.text,
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
