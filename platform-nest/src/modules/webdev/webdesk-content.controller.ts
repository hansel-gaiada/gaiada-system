// WSK-59 — the content BFF the "Website" editor (WSK-44), the MCP hub and the M1 importer call.
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §12 WSK-59. Contract: docs/FRONTEND-BFF-CONTRACT.md §27.
//
// All under `/api/:tenantId/modules/webdev/content/`, all `@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))`.
//
// **THE FIRST STATEMENT OF EVERY HANDLER IS `authorizeContent(...)`** (Cerbos, as the caller, module
// `webdev`), before any body or query validation: a denied caller gets 403 whatever it sent, so a denial
// test with a valid body really tests authorization (the "validation pre-empts authz" trap). The returned
// `ContentGate` is then handed to the service, which will not run without one.
//
// Zone B's typed problems (409 `version-conflict`, 422 `composition-violation`, …) leave here byte-for-byte
// as `application/problem+json` (`WebdeskProblemFilter`); the global filter would rename them to `{error}`
// and drop `issues` / `currentHeadVersion`.
//
// Publish is NOT a route that publishes: `publish-requests` files ONE approval (202 `{approvalId}`) through
// WSK-66 and never calls Zone B's publish (HIGH for every principal, WSK-D46).
import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  WebdeskProblem,
  authorizeContent,
  idempotencyKeyOf,
  webdeskContent,
  type ZoneBResult,
} from "./webdesk-content.service";

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
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_collection", "read");
    send(reply, await webdeskContent.listSites(gate));
  }

  @Get("sites/:tenantSlug/:siteId/collections")
  async listCollections(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_collection", "read");
    send(reply, await webdeskContent.listCollections(gate, { tenantSlug, siteId }));
  }

  @Get("sites/:tenantSlug/:siteId/collections/:collectionKey/items")
  async listItems(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.listItems(gate, { tenantSlug, siteId }, collectionKey, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId")
  async getItem(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.getItem(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId/versions")
  async listVersions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.listVersions(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId/versions/:n")
  async getVersion(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Param("n") n: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.getVersion(gate, { tenantSlug, siteId }, itemId, n, query));
  }

  @Get("sites/:tenantSlug/:siteId/media")
  async listMedia(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.listMedia(gate, { tenantSlug, siteId }, query));
  }

  // ── writes (immediate; the editorial assertion is signed server-side as the caller) ─────────────
  @Post("sites/:tenantSlug/:siteId/collections/:collectionKey/items")
  async create(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "create");
    send(reply, await webdeskContent.createItem(gate, { tenantSlug, siteId }, collectionKey, body, idempotencyKeyOf(idem)));
  }

  @Put("sites/:tenantSlug/:siteId/items/:itemId")
  async update(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "update");
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
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "update");
    send(reply, await webdeskContent.updateItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/restore")
  async restore(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "update");
    send(reply, await webdeskContent.restoreVersion(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  /** Files ONE approval. 202, never 200: nothing is published yet. */
  @Post("sites/:tenantSlug/:siteId/publish-requests")
  @HttpCode(202)
  async publishRequests(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Body() body: unknown,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "request_publish");
    return (await webdeskContent.requestPublish(gate, { tenantSlug, siteId }, body)).body;
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/unpublish")
  async unpublish(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "unpublish");
    send(reply, await webdeskContent.unpublish(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/delete")
  async remove(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeContent(req.principal, tenantId, "webdesk_content_item", "delete");
    send(reply, await webdeskContent.deleteItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }
}
