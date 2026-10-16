// DW-5c (docs/FRONTEND-BFF-CONTRACT.md §32) — requests between departments: `api/:tenantId/requests`.
// Plan: docs/plans/2026-10-13-department-workspaces.md §7.2 and §7.3 (ruling DW-D14: Creatives supplies the assets, and
// Web Dev handles anything that needs a software engineer).
//
// A request is the ASK; the work stays where each receiver already works:
//   * `kind: 'assets'`      -> a PM task owned by the receiving department (`assignee.kind = 'department'`) in that
//                              department's intake project, created through the PM module's own `createPmTaskInTx`.
//   * `kind: 'engineering'` -> a Web Dev change request with `source = 'internal'`, in Web Dev › Requests beside client
//                              maintenance, going through today's triage.
// `work_requests` carries the ask and its own lifecycle (open, delivered, declined, cancelled); progress inside it is read
// live from the work item and never copied. The module's rules, validation and SQL are in work-requests.service.ts; this
// file is routes only.
//
// ── EVERY HANDLER FOLLOWS ONE ORDER (the DW-5a order) ────────────────────────────────────────────
//   (1) read what Cerbos must see from the DB (the requester, the PM task's assignees, the receiving unit's ancestry:
//       never from the body), (2) AUTHORIZE, (3) only then validate the body (so validation never pre-empts a 403),
//   (4) ONE `withTenants` transaction with the outbox event in it, (5) activity and notifications after the commit.
// Authorization (an HTTP call to Cerbos) is never done inside a transaction, so no row lock is held across a network round trip.
//
// ── THE DELIBERATE WIDENING (§32.2) ──────────────────────────────────────────────────────────────
// `webdev_change_request` `create` stays manager-only and a department assignee needs `manage` on PM, yet any MEMBER can
// ask. That is confined to this file: the change request is written here (`source = 'internal'`), and the asset task is
// created here with its department assignee. Neither is reachable by a body field on any other route.
//
// ── LOCK ORDER ───────────────────────────────────────────────────────────────────────────────────
// Change-request advisory lock first, the ask row second, the PM task row last. `syncWorkRequestFromChangeRequest` runs
// inside a change-request transaction that already holds the first; the engineering cancel below takes them in the same order.
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, NotFoundException,
  Param, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { notifyBestEffort } from "./client-notify";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { isModuleEnabled } from "../modules/registry";
import { closePmTaskInTx, createPmTaskInTx, normalizePmTaskInput } from "../modules/pm/pm.controller";
import { isUuidShaped } from "./dept-resolution";
import { lockChangeRequest } from "./webdev-cr-lock";
import type { Resource } from "../rbac/cerbos";
import * as svc from "./work-requests.service";

const resource = (tenantId: string, extra: Partial<Resource> = {}): Resource => ({ kind: "work_request", tenantId, ...extra });
const notFound = () => new svc.WorkRequestRuleError(404, "request_not_found", "request not found");

/** WorkRequestRuleError -> the HTTP exception carrying the contract's machine code in `reason` (and `detail` / `field`). */
function httpFromRule(e: svc.WorkRequestRuleError): HttpException {
  const body = { message: e.message, reason: e.reason, ...(e.field ? { field: e.field } : {}), ...(e.detail ? { detail: e.detail } : {}) };
  if (e.httpStatus === 400) return new BadRequestException(body);
  if (e.httpStatus === 404) return new NotFoundException(body);
  return new ConflictException(body);
}
async function mapRules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof svc.WorkRequestRuleError) throw httpFromRule(e);
    throw e;
  }
}

interface LockedRequest {
  id: string; kind: svc.RequestKind; status: svc.RequestStatus; requested_by: string; title: string; to_unit_id: string;
  pm_task_id: string | null; change_request_id: string | null;
  // DW-10e (§60.6, §60.7): who asked, and the cross row's route and client (the event keys); the receiving company's name.
  tenant_id: string; requester_tenant_id: string; service_assignment_id: string | null; client_id: string | null;
  receiving_name: string | null;
}
/** The ask row under its lock, re-read INSIDE the transaction: the status the rules judge is the one that is committed now. */
async function lockRequest(c: PoolClient, requestId: string): Promise<LockedRequest> {
  const { rows } = await c.query<LockedRequest>(
    `SELECT id, kind, status, requested_by, title, to_unit_id, pm_task_id, change_request_id,
            tenant_id, requester_tenant_id, service_assignment_id, client_id,
            (SELECT name FROM companies WHERE id = work_requests.tenant_id) AS receiving_name
       FROM work_requests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [requestId],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

@Controller("api/:tenantId/requests")
@UseGuards(AuthGuard)
export class WorkRequestsController {
  // ═══════════════════════════════════════════════ WRITES ═══════════════════════════════════════════════

  @Post()
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, resource(tenantId), "create");
    const input = await mapRules(async () => svc.parseCreate(body));
    // §32.5: the receiving module must be on for this company (`pm` carries the asset task, `webdev` the change request).
    if (!(await isModuleEnabled(tenantId, input.kind === "assets" ? "pm" : "webdev"))) {
      throw new ConflictException({ message: `the ${input.kind === "assets" ? "pm" : "webdev"} module is not enabled for this company`, reason: "request_kind_unavailable" });
    }
    const userId = req.principal.userId as string;

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const index = await svc.loadOrgIndex(c, tenantId);
        const toUnit = svc.requireToDepartment(index, input.toUnitId);
        const toName = toUnit.name ?? input.toUnitId;
        if (input.campaignPartId) {
          const part = await c.query(
            `SELECT 1 FROM agency_campaign_parts WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND status <> 'cancelled'`,
            [input.campaignPartId, tenantId],
          );
          if (!part.rows[0]) {
            throw new svc.WorkRequestRuleError(400, "campaign_part_invalid", "campaignPartId is not a live, uncancelled part of this company", "campaignPartId");
          }
        }
        const fromUnitId = await svc.resolveFromUnit(c, tenantId, userId, index);
        const fromUnitName = fromUnitId ? index.get(fromUnitId)?.name ?? null : null;
        const who = await c.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [userId]);
        const requesterName = who.rows[0]?.name ?? "Someone";
        const id = newId();

        // The receiving department's intake project serves BOTH kinds: the asset task lives in it, and the engineering
        // change request names it as its `project_id`, so Web Dev's `pm_task` triage lands the task in
        // "<Department> · Requests" with no extra input (§32.1).
        const intake = await svc.ensureIntakeProject(c, tenantId, input.toUnitId, toName, config.originSite);
        const w = await createRequestWorkItemInTx(c, {
          tenantId, userId, kind: input.kind, toUnitId: input.toUnitId, toName, projectId: intake.projectId, clientId: null,
          title: input.title, brief: input.brief, neededBy: input.neededBy, form: input.form, requesterName, fromUnitName,
        });
        const work = w.work;
        const pmTaskId = w.pmTaskId;
        const changeRequestId = w.changeRequestId;

        await c.query(
          `INSERT INTO work_requests
             (id, tenant_id, kind, to_unit_id, from_unit_id, requested_by, title, brief, needed_by, campaign_part_id, form,
              pm_task_id, change_request_id, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11::jsonb, $12, $13, $14)`,
          [
            id, tenantId, input.kind, input.toUnitId, fromUnitId, userId, input.title, input.brief, input.neededBy,
            input.campaignPartId, JSON.stringify(input.form), pmTaskId, changeRequestId, config.originSite,
          ],
        );
        await emitEvent(c, tenantId, "work_request", id, "work_request.created", {
          requestId: id, kind: input.kind, toUnitId: input.toUnitId, fromUnitId, campaignPartId: input.campaignPartId, workId: work.id,
        });
        return { id, work, toName, intake };
      }),
    );

    await writeActivity(tenantId, userId, "created", "work_request", out.id, { kind: input.kind, toUnitId: input.toUnitId });
    if (out.intake?.created) {
      await writeActivity(tenantId, userId, "created", "project", out.intake.projectId, { name: `${out.toName} · Requests`, intakeFor: input.toUnitId });
    }
    await this.notifyReceived(tenantId, userId, out.id, input.toUnitId, out.toName, input.title);
    return { id: out.id, work: out.work };
  }

  @Post(":id/deliver")
  @HttpCode(200)
  async deliver(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const facts = await this.preRead(req, tenantId, id);
    await authorize(req.principal, factsResource(tenantId, facts), "deliver");
    await mapRules(async () => svc.requireAssets(facts.kind));
    const { assetIds } = await mapRules(async () => svc.parseDeliver(body));
    const userId = req.principal.userId as string;

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const r = await lockRequest(c, id);
        svc.requireAssets(r.kind);
        const plan = svc.planDeliver(r.status);
        const live = await c.query<{ id: string }>(
          `SELECT id FROM creative_assets WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND deleted_at IS NULL`,
          [assetIds, tenantId],
        );
        const liveIds = new Set(live.rows.map((a) => a.id.toLowerCase()));
        const invalid = assetIds.filter((a) => !liveIds.has(a));
        if (invalid.length) {
          throw new svc.WorkRequestRuleError(400, "asset_invalid", "every asset must be a live asset of this company", "assetIds", { invalid });
        }
        // Idempotent: an asset already linked stays linked, and an asset may serve more than one request.
        await c.query(
          `INSERT INTO work_request_assets (request_id, asset_id, tenant_id, added_by)
           SELECT $1::uuid, a, $3::uuid, $4::uuid FROM unnest($2::uuid[]) AS a
           ON CONFLICT (request_id, asset_id) DO NOTHING`,
          [id, assetIds, tenantId, userId],
        );
        if (plan.closes) {
          await c.query(
            `UPDATE work_requests SET status = 'delivered', closed_by = $2, closed_at = now(), updated_at = now() WHERE id = $1`,
            [id, userId],
          );
          if (r.pm_task_id) await closePmTaskInTx(c, tenantId, userId, r.pm_task_id);
        } else {
          await c.query(`UPDATE work_requests SET updated_at = now() WHERE id = $1`, [id]);
        }
        await emitEvent(c, tenantId, "work_request", id, "work_request.delivered", { requestId: id, assetIds, more: !plan.closes, ...svc.crossEventKeys(r) });
        return { requestedBy: r.requested_by, title: r.title, more: !plan.closes, requesterTenantId: r.requester_tenant_id, receivingName: r.receiving_name };
      }),
    );

    await writeActivity(tenantId, userId, out.more ? "delivered_more" : "delivered", "work_request", id, { assetIds });
    // DW-10e (§60.7): a cross request's requester is told in THEIR company, and H's mirror event is written there.
    if (out.requesterTenantId !== tenantId) await svc.emitOutboundMirror(out.requesterTenantId, id, tenantId, "delivered");
    await svc.notifyRequesterOutcome({
      requestTenantId: tenantId, requesterTenantId: out.requesterTenantId, receivingName: out.receivingName, actorId: userId,
      requestedBy: out.requestedBy, requestId: id, title: out.title, outcome: out.more ? "delivered_more" : "delivered",
    });
    return { id, status: "delivered", assetIds };
  }

  @Post(":id/decline")
  @HttpCode(200)
  async decline(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const facts = await this.preRead(req, tenantId, id);
    await authorize(req.principal, factsResource(tenantId, facts), "decline");
    await mapRules(async () => svc.requireAssets(facts.kind));
    const { reason } = await mapRules(async () => svc.parseDecline(body));
    const userId = req.principal.userId as string;

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const r = await lockRequest(c, id);
        svc.requireAssets(r.kind);
        svc.requireOpen(r.status);
        await c.query(
          `UPDATE work_requests SET status = 'declined', closed_by = $2, closed_at = now(), decline_reason = $3, updated_at = now() WHERE id = $1`,
          [id, userId, reason],
        );
        // A declined ask leaves the receiver's board: its task is closed the way a delivered one is.
        if (r.pm_task_id) await closePmTaskInTx(c, tenantId, userId, r.pm_task_id);
        await emitEvent(c, tenantId, "work_request", id, "work_request.declined", { requestId: id, via: "decline", ...svc.crossEventKeys(r) });
        return { requestedBy: r.requested_by, title: r.title, requesterTenantId: r.requester_tenant_id, receivingName: r.receiving_name };
      }),
    );

    await writeActivity(tenantId, userId, "declined", "work_request", id, {});
    // DW-10e (§60.7): as for deliver, the requester of a cross request is told in their own company.
    if (out.requesterTenantId !== tenantId) await svc.emitOutboundMirror(out.requesterTenantId, id, tenantId, "declined");
    await svc.notifyRequesterOutcome({
      requestTenantId: tenantId, requesterTenantId: out.requesterTenantId, receivingName: out.receivingName, actorId: userId,
      requestedBy: out.requestedBy, requestId: id, title: out.title, outcome: "declined", body: reason,
    });
    return { id, status: "declined" };
  }

  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const facts = await this.preRead(req, tenantId, id);
    await authorize(req.principal, factsResource(tenantId, facts), "cancel");
    // DW-10e (§60.6): the RECEIVING company never cancels a request another group company sent. A cancel tells nobody on the
    // requester's side, so the receiver declines instead (assets) or declines in triage (engineering), and the requester is
    // told. After the authorization, so the refusal is never an existence oracle; the requester cancels through
    // `POST requests/outbound/:id/cancel` under their own company.
    if (facts.requesterTenantId !== tenantId) {
      throw new ConflictException({
        message: "this request was sent by another group company; only the requesting side cancels it (decline it instead)",
        reason: "requester_side_only",
      });
    }
    const userId = req.principal.userId as string;

    const out = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        // LOCK ORDER: the change request's advisory lock BEFORE the ask row (see the header). `facts.changeRequestId` is
        // immutable on the row, so reading it before the transaction is safe.
        if (facts.changeRequestId) await lockChangeRequest(c, facts.changeRequestId);
        const r = await lockRequest(c, id);
        svc.requireOpen(r.status);
        let responsible: string | null = null;
        if (r.kind === "engineering" && r.change_request_id) {
          const cr = await c.query<{ status: string; kind: string }>(
            `SELECT status, kind FROM webdev_change_requests WHERE id = $1 AND deleted_at IS NULL`,
            [r.change_request_id],
          );
          if (cr.rows[0]) {
            // Web Dev has accepted the work once triage touched it: from then on it is theirs to decline.
            svc.requireChangeRequestNew(cr.rows[0].status);
            await c.query(
              `UPDATE webdev_change_requests SET status = 'declined', declined_reason = $2, updated_at = now()
                WHERE id = $1 AND status = 'new' AND deleted_at IS NULL`,
              [r.change_request_id, svc.CANCELLED_BY_REQUESTER],
            );
            await emitEvent(c, tenantId, "webdev_change_request", r.change_request_id, "webdev.change_request.updated", {
              status: "declined", route: null, kind: cr.rows[0].kind, actorId: userId, cancelledByRequester: true,
            });
          }
        } else if (r.pm_task_id) {
          const t = await c.query<{ responsible: string | null }>(
            `SELECT assignee->>'responsibleId' AS responsible FROM pm_tasks WHERE id = $1 AND deleted_at IS NULL`,
            [r.pm_task_id],
          );
          const rid = t.rows[0]?.responsible ?? null;
          responsible = rid && isUuidShaped(rid) ? rid : null;
          await closePmTaskInTx(c, tenantId, userId, r.pm_task_id);
        }
        await c.query(`UPDATE work_requests SET status = 'cancelled', closed_by = $2, closed_at = now(), updated_at = now() WHERE id = $1`, [id, userId]);
        await emitEvent(c, tenantId, "work_request", id, "work_request.cancelled", { requestId: id });
        return { responsible, title: r.title, toUnitId: r.to_unit_id };
      }),
    );

    await writeActivity(tenantId, userId, "cancelled", "work_request", id, {});
    // §32.7: only the PM task's responsible person, if any, is told (an engineering request has no PM task).
    if (out.responsible) {
      await notifyBestEffort(tenantId, userId, [out.responsible], "request.cancelled", {
        title: `A request was cancelled: ${out.title}`,
        href: `/departments/${out.toUnitId}/requests`, entityType: "work_request", entityId: id, severity: "info",
      });
    }
    return { id, status: "cancelled" };
  }

  // ═══════════════════════════════════════════════ READS ═══════════════════════════════════════════════
  // Every read is gated by `read`. Unit names come from the org blob (a unit gone from the tree reads `name: null`,
  // `unitMissing: true`).

  @Get()
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    await authorize(req.principal, resource(tenantId), "read");
    const q = await mapRules(async () => svc.parseListQuery(query ?? {}));
    return mapRules(() =>
      withTenants([tenantId], async (c) => {
        const index = await svc.loadOrgIndex(c, tenantId);
        if (q.unitId) svc.requireFilterDepartment(index, q.unitId);
        return svc.listRequests(c, q, req.principal.userId as string, index);
      }),
    );
  }

  // Declared BEFORE `:id`, so "summary" is never read as a request id.
  @Get("summary")
  async summary(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("unitId") unitIdQ?: string) {
    await authorize(req.principal, resource(tenantId), "read");
    const unitId = typeof unitIdQ === "string" && unitIdQ.trim() ? unitIdQ.trim() : null;
    return mapRules(() =>
      withTenants([tenantId], async (c) => {
        if (!unitId) throw new svc.WorkRequestRuleError(400, "unit_invalid", "unitId (a department) is required", "unitId");
        svc.requireFilterDepartment(await svc.loadOrgIndex(c, tenantId), unitId);
        return svc.requestSummary(c, unitId);
      }),
    );
  }

  @Get(":id")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, resource(tenantId, { id }), "read");
    return mapRules(() =>
      withTenants([tenantId], async (c) => {
        const row = await svc.getRequest(c, tenantId, id, await svc.loadOrgIndex(c, tenantId));
        if (!row) throw notFound();
        return row;
      }),
    );
  }

  // ═══════════════════════════════════════════════ helpers ═══════════════════════════════════════════════

  /** The request and the three attributes Cerbos must see, read BEFORE the decision, never from a body. A request that is
   *  absent, deleted or another tenant's is 404; a caller who may not even READ requests is refused 403 first, so the 404 is
   *  never an existence oracle for someone outside the tenant. */
  private async preRead(req: FastifyRequest, tenantId: string, id: string): Promise<svc.AuthFacts> {
    const facts = await withTenants([tenantId], (c) => svc.loadAuthFacts(c, tenantId, id));
    if (!facts) {
      await authorize(req.principal, resource(tenantId), "read");
      throw httpFromRule(notFound());
    }
    return facts;
  }

  /** §32.7 `request.received`: the receiving department's heads. Best-effort: a failure here never fails the write, and with
   *  no head nobody is told (the board still shows the request). */
  private async notifyReceived(tenantId: string, actorId: string, requestId: string, toUnitId: string, toName: string, title: string): Promise<void> {
    try {
      const heads = await withTenants([tenantId], (c) => svc.loadUnitHeads(c, tenantId, toUnitId));
      if (!heads.length) return;
      await notifyBestEffort(tenantId, actorId, heads, "request.received", {
        title: `New request for ${toName}: ${title}`,
        href: `/departments/${toUnitId}/requests`, entityType: "work_request", entityId: requestId, severity: "info",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[work-requests] request.received notification failed (request=${requestId}):`, (err as Error)?.message ?? err);
    }
  }
}

/** The WORK ITEM of a request, written in the caller's transaction BEFORE the request row (§32.5's order; the DW-10e route
 *  guard reads it): an asset request is a PM task owned by the receiving DEPARTMENT in `projectId`; an engineering request is a
 *  Web Dev change request (`source = 'internal'`) naming `projectId` and `clientId`. Shared by §32's create (`clientId` null,
 *  the internal intake project) and §60's send (H's client record and its client requests project, DW-D41), so THE
 *  DELIBERATE WIDENING of the header stays in this one file.
 *
 *  The task is owned by the RECEIVING DEPARTMENT, with nobody responsible yet. `normalizePmTaskInput` validates an assignee only
 *  when it names a responsible person, which a department with nobody on it yet cannot, so the department assignee is set
 *  here, after the rest of the task was validated. Someone is made responsible later through PM, and the task then reaches
 *  that person's Needs you (§32 preamble). `responsibleId` is JSON null, NOT "": the assignment ledger writes it into a uuid
 *  column (pm_task_assignment_events.responsible_id), where "" is a 500, and null is the "nobody yet" shape PM's own
 *  dual-write, drift guard and readers already treat as no responsible person (`!assignee.responsibleId`). */
export async function createRequestWorkItemInTx(c: PoolClient, o: {
  tenantId: string; userId: string; kind: svc.RequestKind; toUnitId: string; toName: string; projectId: string;
  clientId: string | null; title: string; brief: string; neededBy: string | null; form: svc.RequestForm;
  requesterName: string; fromUnitName: string | null;
}): Promise<{ work: { type: "pm_task" | "change_request"; id: string }; pmTaskId: string | null; changeRequestId: string | null }> {
  if (o.kind === "assets") {
    const n = normalizePmTaskInput({
      projectId: o.projectId,
      title: o.title,
      description: svc.buildTaskDescription({ brief: o.brief, form: o.form as svc.AssetsForm, requesterName: o.requesterName, fromUnitName: o.fromUnitName }),
      dueDate: o.neededBy ?? undefined,
      priority: "normal",
    });
    n.assignee = {
      kind: "department", refId: o.toUnitId, refName: o.toName,
      responsibleId: null as unknown as string, responsibleName: null as unknown as string,
    };
    const task = await createPmTaskInTx(c, o.tenantId, o.userId, n);
    return { work: { type: "pm_task", id: task.id }, pmTaskId: task.id, changeRequestId: null };
  }
  const form = o.form as svc.EngineeringForm;
  const changeRequestId = newId();
  await c.query(
    `INSERT INTO webdev_change_requests
       (id, tenant_id, client_id, project_id, source, kind, title, body, status, requested_by, origin_site, affected_url)
     VALUES ($1, $2, $10, $9, 'internal', $3, $4, $5, 'new', $6, $7, $8)`,
    [changeRequestId, o.tenantId, form.kind, o.title, o.brief || null, o.userId, config.originSite, form.affectedUrl ?? null, o.projectId, o.clientId],
  );
  // The same event the internal-create route emits, so everything watching Web Dev intake sees this request too.
  await emitEvent(c, o.tenantId, "webdev_change_request", changeRequestId, "webdev.change_request.created", {
    source: "internal", kind: form.kind, clientId: o.clientId, projectId: o.projectId, actorId: o.userId,
  });
  return { work: { type: "change_request", id: changeRequestId }, pmTaskId: null, changeRequestId };
}

/** The Cerbos resource for an action on one request: the three attributes come from the DB read, never from the body. */
export function factsResource(tenantId: string, f: svc.AuthFacts): Resource {
  return resource(tenantId, { id: f.id, requestedBy: f.requestedBy, assigneeIds: f.assigneeIds, unitAncestors: f.unitAncestors });
}
