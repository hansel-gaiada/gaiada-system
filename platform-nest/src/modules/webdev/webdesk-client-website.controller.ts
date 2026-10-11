// WSK-49c — the client portal's WEBSITE routes: `/api/:tenantId/portal/clients/:clientId/website/...`.
// Contract: docs/FRONTEND-BFF-CONTRACT.md (the portal section, "Client website editing (WSK-49c)").
//
// ── THE ORDER IS THE SECURITY PROPERTY (the same on every handler; see webdesk-client-website.service.ts) ──────────
//   1. THE FIRST STATEMENT OF EVERY HANDLER IS THE CERBOS CHECK, as the caller, under the client-editor rules
//      (`client_website_editor` for the URL's client): a denied caller gets 403 whatever it sent, so a denial test with a
//      valid body really tests authorisation (the "validation pre-empts authz" trap). The URL's `clientId` only reaches
//      Cerbos here, which matches it against the caller's OWN server-derived grants.
//   2. then the site wall: the caller's portal scope (`resolvePortalScope`) must contain that client, and the site must be
//      LINKED to it (`webdesk_site_clients`, loaded in the request's tenant): a site that is not theirs is a uniform 404
//      `site-not-found`, whether the slug is unknown, another client's, another company's or malformed;
//   3. then the strict body, the D59/D62 pre-check, and only then the call to WebDesk, signed `ce: true`.
//
// A client NEVER reaches: delete, unpublish, schedule, schema, key, media delete (no route exists for them, and Cerbos has
// no client rule for them). This is a different surface from the staff BFF (`/modules/webdev/content`): a staff role
// presented here is denied (the client-editor rule needs the CLIENT grant), and a client grant presented there is denied.
//
// WebDesk's typed problems (422 field-not-client-editable / publish-not-client-editable, 409 version-conflict, ...) leave
// here byte-for-byte as `application/problem+json`, exactly as on the staff BFF (`WebdeskProblemFilter`).
import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { WebdeskProblemFilter } from "./webdesk-content.controller";
import { idempotencyKeyOf, type ZoneBResult } from "./webdesk-content.service";
import { webdeskClientWebsite as svc } from "./webdesk-client-website.service";

function send(reply: FastifyReply, r: ZoneBResult): void {
  void reply.status(r.status).header("content-type", "application/json; charset=utf-8").send(r.body);
}

const BASE = ":tenantId/portal/clients/:clientId/website";

@Controller("api")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
@UseFilters(WebdeskProblemFilter)
export class WebdeskClientWebsiteController {
  // ── reads ──────────────────────────────────────────────────────────────────────────────────────
  @Get(BASE)
  async sites(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string, @Res() reply: FastifyReply) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "read");
    send(reply, await svc.listSites(gate));
  }

  @Get(`${BASE}/sites/:tenantSlug/:siteId/collections`)
  async collections(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "read");
    send(reply, await svc.listCollections(gate, { tenantSlug, siteId }));
  }

  @Get(`${BASE}/sites/:tenantSlug/:siteId/collections/:collectionKey/items`)
  async items(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("collectionKey") collectionKey: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "read");
    send(reply, await svc.listItems(gate, { tenantSlug, siteId }, collectionKey, query));
  }

  @Get(`${BASE}/sites/:tenantSlug/:siteId/items/:itemId`)
  async item(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "read");
    send(reply, await svc.getItem(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get(`${BASE}/sites/:tenantSlug/:siteId/items/:itemId/versions`)
  async versions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "read");
    send(reply, await svc.listVersions(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get(`${BASE}/sites/:tenantSlug/:siteId/items/:itemId/versions/:n`)
  async version(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string,
    @Param("n") n: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "read");
    send(reply, await svc.getVersion(gate, { tenantSlug, siteId }, itemId, n, query));
  }

  // ── writes (immediate) ─────────────────────────────────────────────────────────────────────────
  @Post(`${BASE}/sites/:tenantSlug/:siteId/collections/:collectionKey/items`)
  async create(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("collectionKey") collectionKey: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "create");
    send(reply, await svc.createItem(gate, { tenantSlug, siteId }, collectionKey, body, idempotencyKeyOf(idem)));
  }

  @Put(`${BASE}/sites/:tenantSlug/:siteId/items/:itemId`)
  async update(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "update");
    send(reply, await svc.updateItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  @Post(`${BASE}/sites/:tenantSlug/:siteId/items/:itemId/restore`)
  async restore(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "update");
    send(reply, await svc.restoreVersion(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  /** WSK-46's preview link, authorised as the item's `update` (a link discloses the draft). */
  @Post(`${BASE}/sites/:tenantSlug/:siteId/items/:itemId/preview`)
  async preview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "update");
    send(reply, await svc.previewItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  // ── publishing (D58 / D62) ─────────────────────────────────────────────────────────────────────
  /** Files ONE approval (202): nothing is published yet. */
  @Post(`${BASE}/sites/:tenantSlug/:siteId/publish-requests`)
  @HttpCode(202)
  async requestPublish(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Body() body: unknown,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "request_publish");
    return (await svc.requestPublish(gate, { tenantSlug, siteId }, body)).body;
  }

  /** SELF-PUBLISH ONE ITEM (D58): files the request and approves it as the same person. 200 `{approvalId, status, executionStatus, ...}`. */
  @Post(`${BASE}/sites/:tenantSlug/:siteId/items/:itemId/publish`)
  @HttpCode(200)
  async publishItem(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("itemId") itemId: string, @Body() body: unknown,
  ) {
    return (await svc.publishItem(req.principal, tenantId, clientId, { tenantSlug, siteId }, itemId, body)).body;
  }

  /** The REQUESTER cancels their own pending request (`{approvalId, status:'cancelled'}`). */
  @Post(`${BASE}/sites/:tenantSlug/:siteId/publish-requests/:approvalId/withdraw`)
  @HttpCode(200)
  async withdraw(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("approvalId") approvalId: string,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "request_publish");
    return (await svc.withdrawPublishRequest(gate, { tenantSlug, siteId }, approvalId)).body;
  }

  /** This client's publish requests (every client editor's), `?status=pending|approved|rejected|cancelled|all` (default pending). */
  @Get(`${BASE}/publish-requests`)
  async publishRequests(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "read");
    send(reply, await svc.listPublishRequests(gate, query));
  }

  /** Decide AND execute a request: a single item the caller filed, or another client editor's batch (a self-approved batch is 403). */
  @Post(`${BASE}/publish-requests/:approvalId/approve`)
  @HttpCode(200)
  async approve(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("approvalId") approvalId: string,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_content_item", "request_publish");
    return (await svc.approvePublishRequest(gate, approvalId)).body;
  }

  // ── the media library (WSK-43b in client mode): read · upload token · update. No delete. ────────
  @Get(`${BASE}/sites/:tenantSlug/:siteId/media`)
  async media(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_media_asset", "read");
    send(reply, await svc.listMedia(gate, { tenantSlug, siteId }, query));
  }

  /** 201 `{uploadUrl, expiresAt, maxBytes, allowedMimes}`: `uploadUrl` carries a ONE-TIME secret, so `no-store`. */
  @Post(`${BASE}/sites/:tenantSlug/:siteId/media/upload-token`)
  async mediaUploadToken(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_media_asset", "upload");
    const r = await svc.mintUploadToken(gate, { tenantSlug, siteId }, body, idempotencyKeyOf(idem));
    void reply.header("cache-control", "no-store");
    send(reply, r);
  }

  @Patch(`${BASE}/sites/:tenantSlug/:siteId/media/:assetId`)
  async mediaUpdate(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("clientId") clientId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("assetId") assetId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await svc.gate(req.principal, tenantId, clientId, "webdesk_media_asset", "update");
    send(reply, await svc.updateMedia(gate, { tenantSlug, siteId }, assetId, body, idempotencyKeyOf(idem)));
  }
}
