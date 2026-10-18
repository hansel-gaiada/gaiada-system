// DW-10e-2 (docs/FRONTEND-BFF-CONTRACT.md §60.5; PERMISSION-CONTRACT §49; rulings DW-D35, DW-D39, DW-D40, DW-D41) — requests
// across group companies, the SENDER's routes: `api/:tenantId/requests/routes` and `api/:tenantId/requests/outbound…`, where
// `:tenantId` is the REQUESTING company H. The request itself lives in the receiving company P (§60.1 decision 1); P's people
// keep working it through §32's routes under P's URL, unchanged. Rules, parsing and SQL are in work-requests-outbound.service.ts.
//
// ── TWO INDEPENDENT WALLS (§60.1 decision 3) ──────────────────────────────────────────────────────────────────────────────
//   * WHO: Cerbos, on H only — `send_across` to send, §36's `read` to read (narrowed by `read_across`, DW-D40, and by H's own
//     lead seats, DW-D43: see `outboundReadScope`), §36's `cancel` to cancel. No rule, attribute or `inTenant` condition changed; the route and the
//     client never reach Cerbos.
//   * WHERE: the ROUTE (an active service assignment with a routing key, target = H), resolved here, and re-checked by the
//     database's `work_requests_route_guard` (PD060 route, PD062 client) when the row is written.
//
// ── EVERY HANDLER FOLLOWS ONE ORDER (the DW-5a order, §60.5 "Refusals, in the order they are checked") ──────────────────
//   (1) AUTHORIZE on H (403 before any body, route or id is looked at; an absent id is still 403 to a caller who may not read
//       H's requests, so a 404 is never an existence oracle), (2) only then validate, (3) resolve the route / the visible row,
//   (4) ONE `withTenants` transaction over ONE company for the write, with the outbox event in it, (5) side effects after the
//   commit, each stamped in its RECIPIENT's company (§60.7). Authorization is never done inside a transaction.
//
// ── TENANCY (§60.4, D5) ───────────────────────────────────────────────────────────────────────────────────────────────────
// Every statement runs in exactly ONE company's scope: H's (the route, H's tree, H's activity, events and notifications) or P's
// (the row, its work, its client, P's tree, P's activity, events and notifications). Never a two-company tenant set, never
// `crossRoot`. P's rows are read with `SENDER_SCOPE` (`r.tenant_id = P AND r.requester_tenant_id = H`).
//
// ── NEVER AN AMOUNT (§60.4, §60.6a) ──────────────────────────────────────────────────────────────────────────────────────
// No time entry, hour, rate, contract value, currency, contract id or invoice reaches a sender route. The price is a STATE.
//
// ── LOCK ORDER ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// As §32's: the change-request advisory lock first, the ask row second, the PM task row last.
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, NotFoundException,
  Param, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "./http";
import { notifyBestEffort } from "./client-notify";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { isModuleEnabled } from "../modules/registry";
import { closePmTaskInTx } from "../modules/pm/pm.controller";
import { isUuidShaped } from "./dept-resolution";
import { lockChangeRequest } from "./webdev-cr-lock";
import { storage } from "./storage";
import { dispositionHeader } from "./files.controller";
import { createRequestWorkItemInTx } from "./work-requests.controller";
import { REQUEST_ROUTE_KEYS, isRequestRouteKey, kindForRouteKey, resolveGroupClient } from "./request-routes";
import type { Resource } from "../rbac/cerbos";
import * as svc from "./work-requests.service";
import * as out from "./work-requests-outbound.service";

const resource = (tenantId: string, extra: Partial<Resource> = {}): Resource => ({ kind: "work_request", tenantId, ...extra });
const rule = (status: 400 | 404 | 409, reason: string, message: string, field?: string, detail?: Record<string, unknown>) =>
  new svc.WorkRequestRuleError(status, reason, message, field, detail);
const notFound = () => rule(404, "request_not_found", "request not found");

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

/** The route of a send, read in H's scope (`sa_select`, the target side), with both companies (`companies` has no RLS). */
interface RouteRow {
  id: string; provider_tenant_id: string; module_key: string; status: string; unit_status: string; unit_kind: string;
  unit_id: string; unit_name: string; provider_name: string; provider_deleted: boolean; same_root: boolean; requester_name: string;
}

/** The ask row under its lock, inside P's scope, re-read with the sender predicate. */
interface LockedOutbound {
  id: string; kind: svc.RequestKind; status: svc.RequestStatus; requested_by: string; title: string; to_unit_id: string;
  pm_task_id: string | null; change_request_id: string | null;
  tenant_id: string; requester_tenant_id: string; service_assignment_id: string | null; client_id: string | null;
}

@Controller("api/:tenantId/requests")
@UseGuards(AuthGuard)
export class WorkRequestsOutboundController {
  // ═══════════════════════════════════════════════ THE ROUTES ═══════════════════════════════════════════════

  /** §60.5 `GET requests/routes`: H's active routes whose unit is active, ordered by company name, then unit name. `unit.name`
   *  is the assignment's `unit_name` (A8), so H never reads P's tree for it. With the switch off: `{enabled: false, routes: []}`. */
  @Get("routes")
  async routes(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, resource(tenantId), "read");
    if (!config.serviceAssignmentsEnabled) return { enabled: false, routes: [] };
    const { rows } = await withTenants([tenantId], (c) =>
      c.query<{ id: string; module_key: string; provider_tenant_id: string; provider_name: string; unit_name: string }>(
        `SELECT sa.id, sa.module_key, sa.provider_tenant_id, cp.name AS provider_name, sa.unit_name
           FROM service_assignments sa
           JOIN companies cp ON cp.id = sa.provider_tenant_id
           JOIN companies ch ON ch.id = sa.target_tenant_id
          WHERE sa.target_tenant_id = $1 AND sa.module_key = ANY($2::text[])
            AND sa.status = 'active' AND sa.unit_status = 'active' AND sa.unit_kind = 'department'
            AND cp.deleted_at IS NULL AND cp.root_company_id IS NOT NULL AND cp.root_company_id = ch.root_company_id
          ORDER BY cp.name, sa.unit_name, sa.id`,
        [tenantId, [...REQUEST_ROUTE_KEYS]],
      ),
    );
    return {
      enabled: true,
      routes: rows.filter((r) => isRequestRouteKey(r.module_key)).map((r) => ({
        routeId: r.id,
        kind: kindForRouteKey(r.module_key as Parameters<typeof kindForRouteKey>[0]),
        company: { id: r.provider_tenant_id, name: r.provider_name },
        unit: { name: r.unit_name },
      })),
    };
  }

  // ═══════════════════════════════════════════════ SEND ═══════════════════════════════════════════════

  /** §60.5 `POST requests/outbound`: 201 `{id, kind, receivingCompany: {id, name}}`. §60.4's six steps, in order. */
  @Post("outbound")
  @HttpCode(201)
  async send(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    // (1) WHO: `send_across` on H. First, always: no body, route or id is looked at before it.
    await authorize(req.principal, resource(tenantId), "send_across");
    // §60.2 "The switch": routing honours the shared-service layer's switch. Sends only.
    if (!config.serviceAssignmentsEnabled) {
      throw new ConflictException({ message: "requests to other group companies are switched off", reason: "request_routes_disabled" });
    }
    const input = await mapRules(async () => out.parseOutboundCreate(body));
    const userId = req.principal.userId as string;

    // (2) WHERE: the route, in H's scope. Absent, not H's, not a routing key, or a provider in another root: 404.
    const route = await withTenants([tenantId], async (c) => {
      const { rows } = await c.query<RouteRow>(
        `SELECT sa.id, sa.provider_tenant_id, sa.module_key, sa.status, sa.unit_status, sa.unit_kind, sa.unit_id, sa.unit_name,
                cp.name AS provider_name, (cp.deleted_at IS NOT NULL) AS provider_deleted,
                (cp.root_company_id IS NOT NULL AND cp.root_company_id = ch.root_company_id) AS same_root,
                ch.name AS requester_name
           FROM service_assignments sa
           JOIN companies cp ON cp.id = sa.provider_tenant_id
           JOIN companies ch ON ch.id = sa.target_tenant_id
          WHERE sa.id = $1 AND sa.target_tenant_id = $2 AND sa.module_key = ANY($3::text[])`,
        [input.routeId, tenantId, [...REQUEST_ROUTE_KEYS]],
      );
      return rows[0] ?? null;
    });
    // (3) P is the route's provider, P is not deleted, and P and H share a root.
    if (!route || !isRequestRouteKey(route.module_key) || route.provider_deleted || !route.same_root || route.provider_tenant_id === tenantId) {
      throw httpFromRule(rule(404, "route_not_found", "this is not one of your company's request routes", "routeId"));
    }
    const P = route.provider_tenant_id;
    const kind = kindForRouteKey(route.module_key);
    if (input.kind && input.kind !== kind) {
      throw httpFromRule(rule(400, "kind_invalid", `this route takes ${kind} requests`, "kind", { routeKind: kind }));
    }
    if (route.status !== "active" || route.unit_status !== "active") {
      throw httpFromRule(rule(409, "route_inactive", "this route does not take new requests", undefined, {
        status: route.status !== "active" ? route.status : route.unit_status,
      }));
    }
    if (route.unit_kind !== "department") {
      throw httpFromRule(rule(409, "route_unit_unavailable", "this route's department is no longer a department of the receiving company"));
    }
    const form = input.form ?? (await mapRules(async () => out.parseFormForKind(kind, input.rawForm)));

    // (4a) P's receiving module is on (`pm` carries the asset task, `webdev` the change request).
    const moduleKey = kind === "assets" ? "pm" : "webdev";
    if (!(await isModuleEnabled(P, moduleKey))) {
      throw new ConflictException({ message: `${route.provider_name} does not take ${kind} requests now`, reason: "request_kind_unavailable" });
    }

    // (5) The requester's department in H: §32.3's walk over H's OWN tree, in H's scope. Stored with its name, so the
    // receiving side shows it without ever reading H's tree.
    const requester = await withTenants([tenantId], async (c) => {
      const indexH = await svc.loadOrgIndex(c, tenantId);
      const unitId = await svc.resolveFromUnit(c, tenantId, userId, indexH);
      const unitName = unitId ? indexH.get(unitId)?.name ?? null : null;
      const who = await c.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [userId]);
      return { unitId, unitName: unitName === null ? null : [...unitName].slice(0, 200).join(""), name: who.rows[0]?.name ?? "Someone" };
    });

    // (4b) + (6) In P's scope, ONE transaction: the department, the client, the client requests project, then the work item and
    // the row (where the route guard checks the route and the client again).
    let written: { id: string; toUnitId: string; toName: string; work: { type: string; id: string }; intake: { projectId: string; created: boolean }; clientName: string };
    try {
      written = await mapRules(() =>
        withTenants([P], async (c) => {
          const unit = await c.query<{ node_id: string }>(`SELECT node_id FROM org_units WHERE id = $1 AND tenant_id = $2`, [route.unit_id, P]);
          const nodeId = unit.rows[0]?.node_id ?? null;
          const indexP = await svc.loadOrgIndex(c, P);
          const node = nodeId ? indexP.get(nodeId) : undefined;
          if (!nodeId || !node || node.kind !== "department") {
            throw rule(409, "route_unit_unavailable", "this route's department is no longer a department of the receiving company");
          }
          const toName = node.name ?? route.unit_name;
          const client = await resolveGroupClient(c, P, tenantId);
          if (client.status === "none") {
            throw rule(409, "group_client_missing", `${route.provider_name} has not set your company up as a client yet`);
          }
          if (client.status === "ambiguous") {
            throw rule(409, "group_client_ambiguous", `${route.provider_name} has more than one client record for your company`);
          }
          const cl = await c.query<{ name: string }>(`SELECT name FROM clients WHERE id = $1 AND tenant_id = $2`, [client.clientId, P]);
          const clientName = cl.rows[0]?.name ?? route.requester_name;
          const intake = await svc.ensureClientIntakeProject(c, P, nodeId, toName, client.clientId, clientName, config.originSite);
          const w = await createRequestWorkItemInTx(c, {
            tenantId: P, userId, kind, toUnitId: nodeId, toName, projectId: intake.projectId, clientId: client.clientId,
            title: input.title, brief: input.brief, neededBy: input.neededBy, form, requesterName: requester.name,
            fromUnitName: requester.unitName ? `${route.requester_name} · ${requester.unitName}` : route.requester_name,
          });
          const id = newId();
          await c.query(
            `INSERT INTO work_requests
               (id, tenant_id, kind, to_unit_id, from_unit_id, requested_by, title, brief, needed_by, campaign_part_id, form,
                pm_task_id, change_request_id, origin_site,
                requester_tenant_id, requester_unit_id, requester_unit_name, service_assignment_id, client_id)
             VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8::date, NULL, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
              id, P, kind, nodeId, userId, input.title, input.brief, input.neededBy, JSON.stringify(form),
              w.pmTaskId, w.changeRequestId, config.originSite,
              tenantId, requester.unitId, requester.unitName, route.id, client.clientId,
            ],
          );
          await emitEvent(c, P, "work_request", id, "work_request.created", {
            requestId: id, kind, toUnitId: nodeId, fromUnitId: null, campaignPartId: null, workId: w.work.id,
            requesterTenantId: tenantId, serviceAssignmentId: route.id, clientId: client.clientId,
          });
          return { id, toUnitId: nodeId, toName, work: w.work, intake, clientName };
        }),
      );
    } catch (e) {
      // The database's wall held: the route or the client changed between the check above and the write (§60.5).
      const code = (e as { code?: string })?.code;
      if (code === "PD060") throw new ConflictException({ message: "this route does not take new requests", reason: "route_inactive", detail: { status: "changed" } });
      if (code === "PD062") throw new ConflictException({ message: `${route.provider_name} has not set your company up as a client`, reason: "group_client_missing" });
      throw e;
    }

    // (5) Side effects, after the commit, each in its recipient's company (§60.7).
    await writeActivity(P, userId, "created", "work_request", written.id, { kind, toUnitId: written.toUnitId, requesterTenantId: tenantId });
    if (written.intake.created) {
      await writeActivity(P, userId, "created", "project", written.intake.projectId, {
        name: svc.clientIntakeProjectName(written.toName, written.clientName), intakeFor: written.toUnitId, requesterTenantId: tenantId,
      });
    }
    await writeActivity(tenantId, userId, "sent_across", "work_request", written.id, { receivingCompanyId: P });
    await svc.emitOutboundMirror(tenantId, written.id, P, "created");
    await this.notifyReceived(P, userId, written.id, written.toUnitId, written.toName, input.title, route.requester_name);
    return { id: written.id, kind, receivingCompany: { id: P, name: route.provider_name } };
  }

  // ═══════════════════════════════════════════════ READS ═══════════════════════════════════════════════
  // Every read: §36's `read` on H first, then the DW-D40/DW-D43 tier (`outboundReadScope`, directly or through
  // `findVisibleOutbound`).

  /** §60.5 `GET requests/outbound`: 200 `{scope, rows}`, newest first, at most 200 in all (each provider's read is limited to
   *  200, then the reads are merged and cut). */
  @Get("outbound")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() query: Record<string, unknown>) {
    await authorize(req.principal, resource(tenantId), "read");
    const q = await mapRules(async () => out.parseOutboundListQuery(query ?? {}));
    const indexH = await withTenants([tenantId], (c) => svc.loadOrgIndex(c, tenantId));
    if (q.unitId) await mapRules(async () => svc.requireFilterDepartment(indexH, q.unitId as string));
    const tier = await out.outboundReadScope(req.principal, tenantId);
    const filter = out.outboundFilter(q, tier, req.principal.userId as string);
    const all: out.OutboundRow[] = [];
    for (const provider of await out.loadRouteProviders(tenantId)) {
      const rows = await withTenants([provider.id], async (c) => {
        const indexP = await svc.loadOrgIndex(c, provider.id);
        return (await out.readOutboundRows(c, provider.id, tenantId, filter)).map((r) => out.shapeOutbound(r, provider, indexP, indexH));
      });
      all.push(...rows);
    }
    all.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : (a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1));
    return { scope: tier.scope, rows: all.slice(0, svc.LIST_LIMIT) };
  }

  /** §60.5 `GET requests/outbound/summary?unitId=`: 200 `{scope, sent: {open}}`. An honest reader: a number or a failure. Every
   *  open request from the department when the tier reaches it (`company`, or `unit` and the department is one the caller
   *  heads); otherwise only the caller's own. */
  @Get("outbound/summary")
  async summary(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("unitId") unitIdQ?: string) {
    await authorize(req.principal, resource(tenantId), "read");
    const unitId = typeof unitIdQ === "string" && unitIdQ.trim() ? unitIdQ.trim() : null;
    await mapRules(async () => {
      if (!unitId) throw rule(400, "unit_invalid", "unitId (a department of your company) is required", "unitId");
      svc.requireFilterDepartment(await withTenants([tenantId], (c) => svc.loadOrgIndex(c, tenantId)), unitId);
    });
    const tier = await out.outboundReadScope(req.principal, tenantId);
    const onlyBy = out.tierReachesUnit(tier, unitId) ? null : (req.principal.userId as string);
    let open = 0;
    for (const provider of await out.loadRouteProviders(tenantId)) {
      open += await withTenants([provider.id], (c) => out.countOpenFromUnit(c, provider.id, tenantId, unitId as string, onlyBy));
    }
    return { scope: tier.scope, sent: { open } };
  }

  /** §60.5 `GET requests/outbound/:id`: the sender's row, plus `brief`, `form`, `declineReason` and the delivered assets with
   *  the SENDER's download links. */
  @Get("outbound/:id")
  async detail(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const v = await this.visible(req, tenantId, id);
    const indexH = await withTenants([tenantId], (c) => svc.loadOrgIndex(c, tenantId));
    return withTenants([v.provider.id], async (c) => {
      const indexP = await svc.loadOrgIndex(c, v.provider.id);
      const assets = await c.query<{ id: string; name: string; content_type: string }>(
        `SELECT a.id, a.name, a.content_type
           FROM work_request_assets w JOIN creative_assets a ON a.id = w.asset_id AND a.tenant_id = w.tenant_id
          WHERE w.tenant_id = $1 AND w.request_id = $2 AND a.deleted_at IS NULL
          ORDER BY w.added_at, a.id`,
        [v.provider.id, v.row.id],
      );
      return {
        ...out.shapeOutbound(v.row, v.provider, indexP, indexH),
        brief: v.row.brief,
        form: v.row.form,
        declineReason: v.row.decline_reason,
        assets: assets.rows.map((a) => ({ id: a.id, name: a.name, contentType: a.content_type, href: out.outboundAssetHref(tenantId, v.row.id, a.id) })),
      };
    });
  }

  /** §60.5: the delivered asset's graded bytes, with the creative content route's headers. Only an asset linked to THIS
   *  request (`work_request_assets`); another request's asset, a deleted one or a malformed id is 404 `asset_not_found`. */
  @Get("outbound/:id/assets/:assetId/content")
  async assetContent(
    @Req() req: FastifyRequest, @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string, @Param("id") id: string, @Param("assetId") assetId: string,
  ) {
    const v = await this.visible(req, tenantId, id);
    const a = isUuidShaped(assetId)
      ? await withTenants([v.provider.id], async (c) =>
          (await c.query<{ graded_key: string; content_type: string }>(
            `SELECT a.graded_key, a.content_type
               FROM work_request_assets w JOIN creative_assets a ON a.id = w.asset_id AND a.tenant_id = w.tenant_id
              WHERE w.tenant_id = $1 AND w.request_id = $2 AND w.asset_id = $3 AND a.deleted_at IS NULL`,
            [v.provider.id, v.row.id, assetId.toLowerCase()],
          )).rows[0] ?? null)
      : null;
    if (!a || !a.graded_key) throw new NotFoundException({ message: "asset not found", reason: "asset_not_found" });
    const bytes = await storage().get(a.graded_key);
    await reply
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(a.content_type || "application/octet-stream")
      .send(bytes);
  }

  /** §60.5: the request's `work_request` files (DW-8h, §45), read-only. `url` is set on a link row. */
  @Get("outbound/:id/files")
  async files(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const v = await this.visible(req, tenantId, id);
    const { rows } = await withTenants([v.provider.id], (c) =>
      c.query<{ id: string; filename: string; content_type: string; byte_size: number; created_at: string | Date; url: string | null }>(
        `SELECT id, filename, content_type, byte_size, created_at, url FROM files
          WHERE tenant_id = $1 AND target_entity_type = 'work_request' AND target_entity_id = $2 AND deleted_at IS NULL
          ORDER BY created_at DESC, id`,
        [v.provider.id, v.row.id],
      ),
    );
    return rows.map((f) => ({
      id: f.id, filename: f.filename, contentType: f.content_type, byteSize: Number(f.byte_size),
      createdAt: f.created_at instanceof Date ? f.created_at.toISOString() : new Date(f.created_at).toISOString(), url: f.url,
    }));
  }

  /** §60.5: one file's bytes, with the files content route's headers. A link row has no bytes (404 `file_not_found`), and so
   *  does a file of another target. */
  @Get("outbound/:id/files/:fileId/content")
  async fileContent(
    @Req() req: FastifyRequest, @Res() reply: FastifyReply,
    @Param("tenantId") tenantId: string, @Param("id") id: string, @Param("fileId") fileId: string,
  ) {
    const v = await this.visible(req, tenantId, id);
    const f = isUuidShaped(fileId)
      ? await withTenants([v.provider.id], async (c) =>
          (await c.query<{ storage_key: string | null; content_type: string; filename: string }>(
            `SELECT storage_key, content_type, filename FROM files
              WHERE tenant_id = $1 AND target_entity_type = 'work_request' AND target_entity_id = $2 AND id = $3 AND deleted_at IS NULL`,
            [v.provider.id, v.row.id, fileId.toLowerCase()],
          )).rows[0] ?? null)
      : null;
    if (!f || !f.storage_key) throw new NotFoundException({ message: "file not found", reason: "file_not_found" });
    const bytes = await storage().get(f.storage_key);
    await reply
      .header("content-disposition", dispositionHeader(f.filename))
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(f.content_type || "application/octet-stream")
      .send(bytes);
  }

  // ═══════════════════════════════════════════════ CANCEL ═══════════════════════════════════════════════

  /** §60.5 `POST requests/outbound/:id/cancel`: §32.5's cancel, run in P. `read` on H; the row must be visible to the caller
   *  (else 404); then §36's `cancel` on H with the row's `id` and `requestedBy` (the requester's own rule, or H's company_admin
   *  and manager). An engineering request only while its change request is `new` and carries no live price agreement. */
  @Post("outbound/:id/cancel")
  @HttpCode(200)
  async cancel(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const v = await this.visible(req, tenantId, id);
    await authorize(req.principal, resource(tenantId, { id: v.row.id, requestedBy: v.row.requested_by }), "cancel");
    const userId = req.principal.userId as string;
    const P = v.provider.id;

    const done = await mapRules(() =>
      withTenants([P], async (c) => {
        // LOCK ORDER: the change-request lock first (`change_request_id` is immutable on the row), the ask row second.
        if (v.row.change_request_id) await lockChangeRequest(c, v.row.change_request_id);
        const locked = await c.query<LockedOutbound>(
          `SELECT r.id, r.kind, r.status, r.requested_by, r.title, r.to_unit_id, r.pm_task_id, r.change_request_id,
                  r.tenant_id, r.requester_tenant_id, r.service_assignment_id, r.client_id
             FROM work_requests r WHERE ${out.SENDER_SCOPE} AND r.id = $3 FOR UPDATE`,
          [P, tenantId, v.row.id],
        );
        const r = locked.rows[0];
        if (!r) throw notFound();
        svc.requireOpen(r.status);
        let responsible: string | null = null;
        if (r.kind === "engineering" && r.change_request_id) {
          const cr = await c.query<{ status: string; kind: string; amendment_contract_id: string | null; amendment_status: string | null }>(
            `SELECT cr.status, cr.kind, cr.amendment_contract_id, ac.status AS amendment_status
               FROM webdev_change_requests cr
               LEFT JOIN contracts ac ON ac.id = cr.amendment_contract_id AND ac.deleted_at IS NULL
              WHERE cr.id = $1 AND cr.tenant_id = $2 AND cr.deleted_at IS NULL`,
            [r.change_request_id, P],
          );
          const row = cr.rows[0];
          if (row) {
            svc.requireChangeRequestNew(row.status);
            const agreement = out.liveAgreement(row.amendment_contract_id, row.amendment_status);
            if (agreement) {
              throw rule(409, "price_agreement_open", "a price agreement for this request is open: the receiving company declines it in triage and settles the agreement", undefined, { agreement });
            }
            await c.query(
              `UPDATE webdev_change_requests SET status = 'declined', declined_reason = $2, updated_at = now()
                WHERE id = $1 AND status = 'new' AND deleted_at IS NULL`,
              [r.change_request_id, svc.CANCELLED_BY_REQUESTER],
            );
            await emitEvent(c, P, "webdev_change_request", r.change_request_id, "webdev.change_request.updated", {
              status: "declined", route: null, kind: row.kind, actorId: userId, cancelledByRequester: true,
            });
          }
        } else if (r.pm_task_id) {
          const t = await c.query<{ responsible: string | null }>(
            `SELECT assignee->>'responsibleId' AS responsible FROM pm_tasks WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
            [r.pm_task_id, P],
          );
          const rid = t.rows[0]?.responsible ?? null;
          responsible = rid && isUuidShaped(rid) ? rid : null;
          await closePmTaskInTx(c, P, userId, r.pm_task_id);
        }
        await c.query(
          `UPDATE work_requests r SET status = 'cancelled', closed_by = $4, closed_at = now(), updated_at = now()
            WHERE ${out.SENDER_SCOPE} AND r.id = $3`,
          [P, tenantId, r.id, userId],
        );
        await emitEvent(c, P, "work_request", r.id, "work_request.cancelled", { requestId: r.id, ...svc.crossEventKeys(r) });
        return { responsible, title: r.title, toUnitId: r.to_unit_id };
      }),
    );

    await writeActivity(P, userId, "cancelled", "work_request", v.row.id, { requesterTenantId: tenantId });
    await writeActivity(tenantId, userId, "cancelled", "work_request", v.row.id, { receivingCompanyId: P });
    await svc.emitOutboundMirror(tenantId, v.row.id, P, "cancelled");
    // §60.7: the PM task's responsible person, if any, in P (an engineering request has no PM task).
    if (done.responsible) {
      await notifyBestEffort(P, userId, [done.responsible], "request.cancelled", {
        title: `A request was cancelled: ${done.title}`,
        href: `/departments/${done.toUnitId}/requests`, entityType: "work_request", entityId: v.row.id, severity: "info",
      });
    }
    return { id: v.row.id, status: "cancelled" };
  }

  // ═══════════════════════════════════════════════ helpers ═══════════════════════════════════════════════

  /** Every id route's gate (§60.4): `read` on H FIRST (so an absent id is 403 to a caller who may not read H's requests, never
   *  a 404 oracle), then the row as the caller may see it (`findVisibleOutbound`: the caller's own, any with `read_across`, or
   *  one sent from a unit the caller heads), else 404 `request_not_found`, as for an absent row. */
  private async visible(req: FastifyRequest, tenantId: string, id: string): Promise<out.VisibleOutbound> {
    await authorize(req.principal, resource(tenantId, isUuidShaped(id) ? { id: id.toLowerCase() } : {}), "read");
    const v = await out.findVisibleOutbound(req.principal, tenantId, id);
    if (!v) throw httpFromRule(notFound());
    return v;
  }

  /** §60.7 `request.received`: the receiving department's heads, in P. Best-effort: a failure never fails the write, and with no
   *  head nobody is told (the board still shows the request). */
  private async notifyReceived(
    P: string, actorId: string, requestId: string, toUnitId: string, toName: string, title: string, requesterName: string,
  ): Promise<void> {
    try {
      const heads = await withTenants([P], (c) => svc.loadUnitHeads(c, P, toUnitId));
      if (!heads.length) return;
      await notifyBestEffort(P, actorId, heads, "request.received", {
        title: `New request from ${requesterName} for ${toName}: ${title}`,
        href: `/departments/${toUnitId}/requests`, entityType: "work_request", entityId: requestId, severity: "info",
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[work-requests] request.received notification failed (request=${requestId}):`, (err as Error)?.message ?? err);
    }
  }
}
