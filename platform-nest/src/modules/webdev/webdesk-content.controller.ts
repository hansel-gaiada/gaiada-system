// WSK-59 — the content BFF the "Website" editor (WSK-44), the MCP hub and the M1 importer call.
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §12 WSK-59. Contract: docs/FRONTEND-BFF-CONTRACT.md §27.
//
// All under `/api/:tenantId/modules/webdev/content/`, all `@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))`.
//
// **THE FIRST STATEMENT OF EVERY HANDLER IS `authorizeSite(...)`** (M5-W1c phase 1: Cerbos, as the caller,
// module `webdev`, `webdesk_collection:read` on the route's site; `GET sites` has no site and uses
// `authorizeSites`). PHASE 2, the real action with attributes from the route and from a WebDesk read, runs inside
// the service BEFORE any body or query validation: a denied caller gets 403 whatever it sent, so a denial test
// with a valid body really tests authorization (the "validation pre-empts authz" trap). The returned
// `ContentGate` is then handed to the service, which will not run without one, and a service method that writes
// sends through an `ItemGate` only the WebDesk-read path can build. Attribute provenance: PERMISSION-CONTRACT 27.2.
//
// Zone B's typed problems (409 `version-conflict`, 422 `composition-violation`, …) leave here byte-for-byte
// as `application/problem+json` (`WebdeskProblemFilter`); the global filter would rename them to `{error}`
// and drop `issues` / `currentHeadVersion`.
//
// Publish is NOT a route that publishes: `publish-requests` files ONE approval (202 `{approvalId}`) through
// WSK-66 and never calls Zone B's publish (HIGH for every principal, WSK-D46).
import { ArgumentsHost, Body, Catch, Controller, Delete, ExceptionFilter, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  WebdeskProblem,
  authorizeSite,
  authorizeSites,
  idempotencyKeyOf,
  webdeskContent,
  type ZoneBResult,
} from "./webdesk-content.service";
import { webdeskMedia } from "./webdesk-media.service";
import { defineFormDefinition, getFormDefinition, listFormDefinitions } from "./webdesk-forms.service";

/** Writes a Zone B problem exactly as Zone B sent it. */
@Catch(WebdeskProblem)
export class WebdeskProblemFilter implements ExceptionFilter {
  catch(exception: WebdeskProblem, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    void reply.status(exception.getStatus()).header("content-type", "application/problem+json").send(exception.problem);
  }
}

function send(reply: FastifyReply, r: ZoneBResult): void {
  void reply.status(r.status).header("content-type", "application/json; charset=utf-8").send(r.body);
}

@Controller("api/:tenantId/modules/webdev/content")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
@UseFilters(WebdeskProblemFilter)
export class WebdeskContentController {
  // ── reads ──────────────────────────────────────────────────────────────────────────────────────
  @Get("sites")
  async listSites(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Res() reply: FastifyReply) {
    const gate = await authorizeSites(req.principal, tenantId);
    send(reply, await webdeskContent.listSites(gate));
  }

  @Get("sites/:tenantSlug/:siteId/collections")
  async listCollections(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "read");
    send(reply, await webdeskContent.listCollections(gate, { tenantSlug, siteId }));
  }

  @Get("sites/:tenantSlug/:siteId/collections/:collectionKey/items")
  async listItems(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.listItems(gate, { tenantSlug, siteId }, collectionKey, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId")
  async getItem(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.getItem(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId/versions")
  async listVersions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.listVersions(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId/versions/:n")
  async getVersion(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Param("n") n: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.getVersion(gate, { tenantSlug, siteId }, itemId, n, query));
  }

  // ── form definitions (M5-L1d): Cerbos `webdesk_collection` (`read` / `apply_schema`), no new kind ───────────────
  // The write is WebDesk's `forms.define` (MEDIUM): an upsert of one public form's definition by (site, key). WebDesk's
  // typed 409 `consent-version-unchanged` and 422 `form-definition-invalid` (with `issues`) pass through untouched.

  @Get("sites/:tenantSlug/:siteId/forms")
  async listForms(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "read");
    send(reply, await listFormDefinitions(gate, { tenantSlug, siteId }));
  }

  @Get("sites/:tenantSlug/:siteId/forms/:formKey")
  async getForm(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("formKey") formKey: string, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "read");
    send(reply, await getFormDefinition(gate, { tenantSlug, siteId }, formKey));
  }

  @Put("sites/:tenantSlug/:siteId/forms/:formKey")
  async defineForm(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("formKey") formKey: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "apply_schema");
    send(reply, await defineFormDefinition(gate, { tenantSlug, siteId }, formKey, body, idempotencyKeyOf(idem)));
  }

  /** The MCP hub's method union has no PUT, so `webdesk.forms.define` calls this alias: same path, same body, same semantics. */
  @Patch("sites/:tenantSlug/:siteId/forms/:formKey")
  async defineFormPatch(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("formKey") formKey: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "apply_schema");
    send(reply, await defineFormDefinition(gate, { tenantSlug, siteId }, formKey, body, idempotencyKeyOf(idem)));
  }

  // ── the media library (WSK-43b): its own Cerbos kind, `webdesk_media_asset` ──────────────────────
  // Authorised against `webdesk_media_asset` (read / upload / update / delete), NOT `webdesk_content_item`.
  // Zone B's problems, `media-in-use` and its using items included, leave here untouched.

  @Get("sites/:tenantSlug/:siteId/media")
  async listMedia(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_media_asset", "read");
    send(reply, await webdeskMedia.list(gate, { tenantSlug, siteId }, query));
  }

  @Get("sites/:tenantSlug/:siteId/media/:assetId/usage")
  async mediaUsage(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("assetId") assetId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_media_asset", "read");
    send(reply, await webdeskMedia.usage(gate, { tenantSlug, siteId }, assetId, query));
  }

  /** 201 `{uploadUrl, expiresAt, maxBytes, allowedMimes}`: `uploadUrl` carries a ONE-TIME secret, so `no-store`. */
  @Post("sites/:tenantSlug/:siteId/media/upload-token")
  async mediaUploadToken(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_media_asset", "upload");
    const r = await webdeskMedia.mintUploadToken(gate, { tenantSlug, siteId }, body, idempotencyKeyOf(idem));
    void reply.header("cache-control", "no-store");
    send(reply, r);
  }

  @Patch("sites/:tenantSlug/:siteId/media/:assetId")
  async mediaUpdate(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("assetId") assetId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_media_asset", "update");
    send(reply, await webdeskMedia.update(gate, { tenantSlug, siteId }, assetId, body, idempotencyKeyOf(idem)));
  }

  /** Soft delete. 409 `media-in-use` (listing the items that use the asset) while any content references it. */
  @Delete("sites/:tenantSlug/:siteId/media/:assetId")
  async mediaDelete(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("assetId") assetId: string, @Headers("idempotency-key") idem: string | undefined,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_media_asset", "delete");
    send(reply, await webdeskMedia.delete(gate, { tenantSlug, siteId }, assetId, query, idempotencyKeyOf(idem)));
  }

  // ── writes (immediate; the editorial assertion is signed server-side as the caller) ─────────────
  @Post("sites/:tenantSlug/:siteId/collections/:collectionKey/items")
  async create(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "create");
    send(reply, await webdeskContent.createItem(gate, { tenantSlug, siteId }, collectionKey, body, idempotencyKeyOf(idem)));
  }

  @Put("sites/:tenantSlug/:siteId/items/:itemId")
  async update(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "update");
    send(reply, await webdeskContent.updateItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  /** The MCP hub's method union has no PUT, so `webdesk.content.update` calls this alias: same path, same body, same semantics. */
  @Patch("sites/:tenantSlug/:siteId/items/:itemId")
  async updatePatch(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "update");
    send(reply, await webdeskContent.updateItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/restore")
  async restore(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "update");
    send(reply, await webdeskContent.restoreVersion(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  /** WSK-46: mint a one-time preview link to a DRAFT. Authorised as the item's `update` (a link discloses the draft). */
  @Post("sites/:tenantSlug/:siteId/items/:itemId/preview")
  async preview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "update");
    send(reply, await webdeskContent.previewItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  /** Files ONE approval. 202, never 200: nothing is published yet. */
  @Post("sites/:tenantSlug/:siteId/publish-requests")
  @HttpCode(202)
  async publishRequests(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Body() body: unknown,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "request_publish");
    return (await webdeskContent.requestPublish(gate, { tenantSlug, siteId }, body)).body;
  }

  /** The caller's OWN publish/schedule approvals for this site (WSK-44b): the editor's "pending request after reload". */
  @Get("sites/:tenantSlug/:siteId/publish-requests")
  async listPublishRequests(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "request_publish");
    send(reply, await webdeskContent.listOwnPublishRequests(gate, { tenantSlug, siteId }, query));
  }

  /** The REQUESTER cancels their own pending publish approval (status `cancelled`). */
  @Post("sites/:tenantSlug/:siteId/publish-requests/:approvalId/withdraw")
  @HttpCode(200)
  async withdraw(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("approvalId") approvalId: string,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "request_publish");
    return (await webdeskContent.withdrawPublishRequest(gate, { tenantSlug, siteId }, approvalId)).body;
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/unpublish")
  async unpublish(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "unpublish");
    send(reply, await webdeskContent.unpublish(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/delete")
  async remove(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "delete");
    send(reply, await webdeskContent.deleteItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }
}
