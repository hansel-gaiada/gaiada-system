// DW-6k (docs/FRONTEND-BFF-CONTRACT.md §36.5) — Figma links on PM tasks, work requests and campaign parts. Routes only: the
// rules are in rules.ts and url.ts, the persistence, cache and export in service.ts, Figma itself behind client.ts.
//
// ── THERE IS NO NEW CERBOS KIND ──────────────────────────────────────────────────────────────────
// A link is part of the work it is on, so it is authorised by THAT work's own kind, with exactly the attributes that kind's
// own routes send (the builders are reused, not re-derived):
//   * `pm_task`            `{ id }`; writes are `update` (what PATCH /pm/tasks/:id gates on).
//   * `work_request`       reads `{ id }`; writes send `factsResource(...)` (requestedBy, assigneeIds, unitAncestors read from
//                          the DB), and are allowed when EITHER `deliver` (the receiving side) OR `cancel` (the asker) is.
//   * `agency_campaign_part` reads `partResource(tenant, { id })`; writes send `{ id, ownerId, unitAncestors }` (what
//                          PATCH …/parts/:partId sends), and are `update`.
//
// ── EVERY HANDLER FOLLOWS ONE ORDER (the DW-5a order) ────────────────────────────────────────────
//   (1) AUTHORISE the target's kind at the tenant level (a plain `read`), so a caller who may not read that kind learns
//       nothing, not even whether a link or a target exists; (2) read the target from the DB (404 `target_not_found` when it is
//       absent, deleted or another tenant's: RLS hides it); (3) AUTHORISE the real action on it, with the attributes read in
//       (2); (4) only then validate the body (so validation never pre-empts a 403); (5) the work. Authorisation is never done
//       inside a transaction.
// The one thing read before (1) is the target KIND, because it names which kind to authorise; an unusable kind is answered
// 400 only after the caller has passed the tenant-level gate of the most general kind (`pm_task` read).
//
// ── ERRORS ───────────────────────────────────────────────────────────────────────────────────────
// A refusal puts its token at the START of `message` (the error filter turns `message` into `{ error }`) and repeats it in
// `reason`: `figma_not_connected`, `figma_refused`, `target_not_found`, `bad_figma_url`, and the rest listed in §36.8.
import {
  Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Put, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { AuthGuard } from "../../auth/guards";
import { can } from "../../rbac/can";
import type { Principal } from "../../rbac/principal";
import type { Resource } from "../../rbac/cerbos";
import { authorize, writeActivity } from "../http";
import { isUuidShaped } from "../dept-resolution";
import { cerbosOwnerId, connectionAction } from "../integrations.controller";
import { factsResource } from "../work-requests.controller";
import { loadAuthFacts } from "../work-requests.service";
import { partResource } from "../../modules/agency/agency.controller";
import { partUnitAncestors } from "../../modules/agency/agency-campaign-parts.service";
import {
  FigmaRuleError, TARGET_KINDS, parseExportBody, parseTargetKind, type TargetKind,
} from "./rules";
import * as svc from "./service";

function httpFrom(e: FigmaRuleError): HttpException {
  return new HttpException(
    { message: e.message, reason: e.token, ...(e.field ? { field: e.field } : {}) },
    e.httpStatus,
  );
}
/** Runs `fn`, turning a FigmaRuleError into its HTTP exception. */
async function mapRules<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof FigmaRuleError) throw httpFrom(e);
    throw e;
  }
}

/** The Cerbos kind each target kind is authorised as. */
const CERBOS_KIND: Record<TargetKind, string> = {
  pm_task: "pm_task",
  work_request: "work_request",
  campaign_part: "agency_campaign_part",
};

/** The resource a READ on the target sends: what the target's own read routes send. `id` is added only when it is usable. */
function readResourceOf(kind: TargetKind, tenantId: string, id?: string): Resource {
  if (kind === "campaign_part") return partResource(tenantId, id ? { id } : {});
  return { kind: CERBOS_KIND[kind], tenantId, ...(id ? { id } : {}) };
}

interface Target {
  id: string;
  /** The target's department (an org-node id) where it has one; the exported asset carries it. */
  departmentId: string | null;
  /** The resource a WRITE on the target sends, attributes read from the DB. */
  writeResource: Resource;
}

async function readTarget(c: PoolClient, tenantId: string, kind: TargetKind, id: string): Promise<Target | null> {
  if (kind === "pm_task") {
    const r = await c.query<{ department_id: string | null }>(
      `SELECT p.department_id FROM pm_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = $1 AND t.deleted_at IS NULL`,
      [id],
    );
    if (!r.rows[0]) return null;
    return { id, departmentId: r.rows[0].department_id, writeResource: { kind: "pm_task", tenantId, id } };
  }
  if (kind === "work_request") {
    const facts = await loadAuthFacts(c, tenantId, id);
    if (!facts) return null;
    return { id, departmentId: facts.toUnitId, writeResource: factsResource(tenantId, facts) };
  }
  const r = await c.query<{ unit_id: string; owner_id: string | null }>(
    `SELECT unit_id, owner_id FROM agency_campaign_parts WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  if (!r.rows[0]) return null;
  const ancestors = await partUnitAncestors(c, tenantId, r.rows[0].unit_id);
  return {
    id, departmentId: r.rows[0].unit_id,
    writeResource: partResource(tenantId, { id, ownerId: r.rows[0].owner_id ?? undefined, unitAncestors: ancestors }),
  };
}

/** The target, or 404 `target_not_found`: absent, deleted, another tenant's (RLS) or an id that cannot be one. */
async function requireTarget(tenantId: string, kind: TargetKind, id: string | null): Promise<Target> {
  if (!id || !isUuidShaped(id)) throw svc.targetNotFound();
  const t = await withTenants([tenantId], (c) => readTarget(c, tenantId, kind, id));
  if (!t) throw svc.targetNotFound();
  return t;
}

/** The write check on a target (§36.5). `work_request` allows either `deliver` (the receiving side) or `cancel` (the asker):
 *  two questions through `can()`, which answers without throwing, then the ONE authoritative `authorize()` on the action
 *  that passed (it audits, enforces the session and the act-for intersection). When neither passes it asks `deliver`, so the
 *  refusal is the standard audited 403. */
async function authorizeWrite(principal: Principal, kind: TargetKind, target: Target): Promise<void> {
  if (kind !== "work_request") return authorize(principal, target.writeResource, "update");
  // `can()` sets the Cerbos kind itself from the catalog entry, so the full resource is passed as it is.
  let action = "deliver";
  if (!(await can(principal, "core.work_request.deliver", target.writeResource))) {
    if (await can(principal, "core.work_request.cancel", target.writeResource)) action = "cancel";
  }
  return authorize(principal, target.writeResource, action);
}

/** `kind` from a body or query value, or null when it is not one of the three. */
const tryKind = (raw: unknown): TargetKind | null =>
  typeof raw === "string" && (TARGET_KINDS as readonly string[]).includes(raw) ? (raw as TargetKind) : null;
const idOf = (raw: unknown): string | null => (typeof raw === "string" && isUuidShaped(raw.trim()) ? raw.trim().toLowerCase() : null);

@Controller("api")
@UseGuards(AuthGuard)
export class FigmaController {
  // ═══════════════════════════════════════════════ LINKS ═══════════════════════════════════════════════

  /** The target's links, each refreshed first when its cache is older than ten minutes. `read` on the target. */
  @Get(":tenantId/figma-links")
  async list(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Query("targetKind") targetKindQ?: unknown, @Query("targetId") targetIdQ?: unknown,
  ) {
    const kind = tryKind(targetKindQ);
    const targetId = idOf(targetIdQ);
    await authorize(req.principal, readResourceOf(kind ?? "pm_task", tenantId, kind && targetId ? targetId : undefined), "read");
    return mapRules(async () => {
      const k = parseTargetKind(targetKindQ);
      await requireTarget(tenantId, k, targetId);
      return svc.listLinks(tenantId, k, targetId as string);
    });
  }

  /** `{ targetKind, targetId, url }`. The write check on the target. 409 `link_exists` for the same file and frame twice. */
  @Post(":tenantId/figma-links")
  @HttpCode(201)
  async create(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const kind = tryKind(b.targetKind);
    const targetId = idOf(b.targetId);
    await authorize(req.principal, readResourceOf(kind ?? "pm_task", tenantId, kind && targetId ? targetId : undefined), "read");
    const k = await mapRules(async () => parseTargetKind(b.targetKind));
    const target = await mapRules(() => requireTarget(tenantId, k, targetId));
    await authorizeWrite(req.principal, k, target);
    const userId = req.principal.userId as string;
    const view = await mapRules(() => svc.createLink(tenantId, { kind: k, targetId: target.id, url: b.url, userId }));
    await writeActivity(tenantId, userId, "created", "figma_link", view.id, { targetKind: k, targetId: target.id, fileKey: view.fileKey });
    return view;
  }

  @Delete(":tenantId/figma-links/:id")
  async remove(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const { link, kind } = await this.writeContext(req, tenantId, id);
    const gone = await svc.deleteLink(tenantId, link.id);
    if (!gone) throw httpFrom(svc.linkNotFound());
    await writeActivity(tenantId, req.principal.userId, "deleted", "figma_link", link.id, { targetKind: kind, targetId: link.target_id });
    return { id: link.id, deleted: true };
  }

  /** A small PNG of the design, proxied from Figma and never stored. `read` on the target. */
  @Get(":tenantId/figma-links/:id/thumbnail")
  async thumbnail(@Req() req: FastifyRequest, @Res() reply: FastifyReply, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    const link = await this.readContext(req, tenantId, id);
    const img = await mapRules(() => svc.fetchThumbnail(tenantId, link));
    await reply
      .header("cache-control", "private, max-age=600")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .type(img.contentType)
      .send(img.bytes);
  }

  /** `{ format: "png" | "svg" | "pdf", scale?: 1 | 2 | 3 }`. The write check on the target AND `file` · `create`. */
  @Post(":tenantId/figma-links/:id/export")
  @HttpCode(201)
  async exportLink(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string, @Body() body: unknown) {
    const { link, target, kind } = await this.writeContext(req, tenantId, id);
    await authorize(req.principal, { kind: "file", tenantId }, "create");
    const input = await mapRules(async () => parseExportBody(body));
    const userId = req.principal.userId as string;
    const out = await mapRules(() => svc.exportLink(tenantId, userId, link, input, target.departmentId));
    await writeActivity(tenantId, userId, "exported", "figma_link", link.id, {
      targetKind: kind, targetId: link.target_id, assetId: out.id, versionNo: out.versionNo, format: input.format,
    });
    return {
      linkId: out.linkId, assetId: out.id, assetGroupId: out.assetGroupId, versionNo: out.versionNo,
      name: out.name, contentType: out.contentType, byteSize: out.gradedByteSize,
    };
  }

  // ═══════════════════════════════════════════════ THE COMPANY'S CONNECTION (§36.1) ═══════════════════════════════════════════════

  /** Whether the company has a Figma token linked, and of which kind. Never the token. Anyone who may read PM tasks. */
  @Get(":tenantId/integrations/figma")
  async connectionStatus(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "pm_task", tenantId }, "read");
    return svc.figmaConnectionStatus(tenantId);
  }

  /** `{ token, tokenType?: "pat" | "oauth" }`: seals the token in the company's vault row. `company.manage`, the same tier
   *  the generic connections API asks for a company row (`integration_connection` · `manage`). */
  @Put(":tenantId/integrations/figma")
  async connect(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    const me = req.principal.userId ?? "";
    const owner = cerbosOwnerId("company", tenantId);
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: owner }, connectionAction("create", owner, me));
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const out = await mapRules(() => svc.connectFigma(tenantId, b.token, b.tokenType, me || null));
    // Never the token: only that it was set, and of which kind.
    await writeActivity(tenantId, me || null, "connected", "integration_connection", null, { provider: svc.FIGMA_PROVIDER, tokenType: out.tokenType });
    return out;
  }

  @Delete(":tenantId/integrations/figma")
  async disconnect(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    const me = req.principal.userId ?? "";
    const owner = cerbosOwnerId("company", tenantId);
    await authorize(req.principal, { kind: "integration_connection", tenantId, ownerId: owner }, connectionAction("delete", owner, me));
    const disconnected = await svc.disconnectFigma(tenantId);
    if (disconnected) await writeActivity(tenantId, me || null, "disconnected", "integration_connection", null, { provider: svc.FIGMA_PROVIDER });
    return { disconnected };
  }

  // ═══════════════════════════════════════════════ helpers ═══════════════════════════════════════════════

  /** The link, authorised for a READ on its target: the tenant-level gate first, then the target must still exist. A missing
   *  link answers 404 only after the most general read gate (`pm_task`), so the 404 is not an existence oracle. */
  private async readContext(req: FastifyRequest, tenantId: string, id: string): Promise<svc.LinkRow> {
    const link = await svc.getLink(tenantId, id);
    if (!link) {
      await authorize(req.principal, readResourceOf("pm_task", tenantId), "read");
      throw httpFrom(svc.linkNotFound());
    }
    await authorize(req.principal, readResourceOf(link.target_kind, tenantId, link.target_id), "read");
    await mapRules(() => requireTarget(tenantId, link.target_kind, link.target_id));
    return link;
  }

  /** The link, its target and the WRITE check on it (§36.5). */
  private async writeContext(req: FastifyRequest, tenantId: string, id: string) {
    const link = await svc.getLink(tenantId, id);
    if (!link) {
      await authorize(req.principal, readResourceOf("pm_task", tenantId), "read");
      throw httpFrom(svc.linkNotFound());
    }
    await authorize(req.principal, readResourceOf(link.target_kind, tenantId), "read");
    const target = await mapRules(() => requireTarget(tenantId, link.target_kind, link.target_id));
    await authorizeWrite(req.principal, link.target_kind, target);
    return { link, target, kind: link.target_kind };
  }
}
