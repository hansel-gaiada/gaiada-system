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
// ask. That is confined to this module: the change request is written by `createRequestWorkItemInTx` (work-requests.service.ts,
// `source = 'internal'`), and the asset task is created there with its department assignee. Neither is reachable by a body
// field on any other route.
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
import { withTenants } from "../db";
import { authorize, writeActivity } from "./http";
import { notifyBestEffort } from "./client-notify";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { isModuleEnabled } from "../modules/registry";
import { closePmTaskInTx } from "../modules/pm/pm.controller";
import { isUuidShaped } from "./dept-resolution";
import { lockChangeRequest } from "./webdev-cr-lock";
import type { Resource } from "../rbac/cerbos";
import * as svc from "./work-requests.service";
import { socialPostsOfRequest } from "../modules/social/pipeline/request-social-posts";

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
      // The creation itself (the validated INSERT, its work item and its event) is `svc.createWorkRequestInTx`, shared with the
      // social pipeline's client-month request.
      withTenants([tenantId], (c) => svc.createWorkRequestInTx(c, tenantId, userId, input)),
    );

    await writeActivity(tenantId, userId, "created", "work_request", out.id, { kind: input.kind, toUnitId: input.toUnitId });
    if (out.intake?.created) {
      await writeActivity(tenantId, userId, "created", "project", out.intake.projectId, { name: `${out.toName} · Requests`, intakeFor: input.toUnitId });
    }
    await svc.notifyRequestReceived(tenantId, userId, out.id, input.toUnitId, out.toName, input.title);
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
    const row = await mapRules(() =>
      withTenants([tenantId], async (c) => {
        const found = await svc.getRequest(c, tenantId, id, await svc.loadOrgIndex(c, tenantId));
        if (!found) throw notFound();
        return found;
      }),
    );
    // SCP-1h (§63.6.6): the social posts that joined this request (additive; [] for a request no post joined). Read under the
    // social module scope in a transaction of its own, never inside the request read above.
    return { ...row, socialPosts: await socialPostsOfRequest(tenantId, id) };
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
}

/** The Cerbos resource for an action on one request: the three attributes come from the DB read, never from the body. */
export function factsResource(tenantId: string, f: svc.AuthFacts): Resource {
  return resource(tenantId, { id: f.id, requestedBy: f.requestedBy, assigneeIds: f.assigneeIds, unitAncestors: f.unitAncestors });
}
