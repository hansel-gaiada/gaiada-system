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
import { ContributorRoute } from "../../auth/contributor-route";
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
import { webdeskEditorial } from "./webdesk-editorial.service";
import { webdeskCalendar } from "./webdesk-calendar.service";
import { webdeskAssist } from "./webdesk-assist.service";
import { webdeskWritersDashboard } from "./webdesk-writers-dashboard.service";
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

// M5-W1d (design §3.1 items 5 and 7): the routes marked `@ContributorRoute()` below are the ONLY ones in this controller a
// freelance contributor (`users.kind = 'contributor'`) reaches, at assurance high; every other route here answers it 403
// `contributor_route_forbidden` in AuthGuard before the handler runs. The marked set mirrors WebDesk's CONTRIBUTOR_COMMANDS
// (content read/create/update/restore, preview, and the editorial submit/withdraw/comment/requestChanges/seoSignoff family)
// plus the reads its editor needs. Cerbos still decides every one of them on the contributor's own grants and the
// contributor DENYs. NOT marked, on purpose: forms, media usage and every media write (upload stays closed until the W1q
// quarantine exists), assist, publish requests, unpublish, delete, approve, assign, the editorial policy, the calendar
// and the writers' dashboard. The full list is pinned by src/auth/contributor-route.test.ts.
@Controller("api/:tenantId/modules/webdev/content")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
@UseFilters(WebdeskProblemFilter)
export class WebdeskContentController {
  // ── reads ──────────────────────────────────────────────────────────────────────────────────────
  @Get("sites")
  @ContributorRoute()
  async listSites(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Res() reply: FastifyReply) {
    const gate = await authorizeSites(req.principal, tenantId);
    send(reply, await webdeskContent.listSites(gate));
  }

  @Get("sites/:tenantSlug/:siteId/collections")
  @ContributorRoute()
  async listCollections(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "read");
    send(reply, await webdeskContent.listCollections(gate, { tenantSlug, siteId }));
  }

  @Get("sites/:tenantSlug/:siteId/collections/:collectionKey/items")
  @ContributorRoute()
  async listItems(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.listItems(gate, { tenantSlug, siteId }, collectionKey, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId")
  @ContributorRoute()
  async getItem(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.getItem(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId/versions")
  @ContributorRoute()
  async listVersions(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskContent.listVersions(gate, { tenantSlug, siteId }, itemId, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId/versions/:n")
  @ContributorRoute()
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
  @ContributorRoute()
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
  @ContributorRoute()
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
  @ContributorRoute()
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
  @ContributorRoute()
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
  @ContributorRoute()
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
  @ContributorRoute()
  async preview(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "update");
    send(reply, await webdeskContent.previewItem(gate, { tenantSlug, siteId }, itemId, body, idempotencyKeyOf(idem)));
  }

  /**
   * M5-W6: AI assist. Suggestions for one item through ai-gateway-go; WRITES NOTHING (a human applies a suggestion and saves it
   * through `content.update`). Authorised as the item's `update`, so a writer may ask only on an item they may edit. 200 on success
   * (a POST that creates nothing), and a typed 422 / 429 / 503 / 502 otherwise (webdesk-assist.service.ts).
   */
  @Post("sites/:tenantSlug/:siteId/items/:itemId/assist")
  @HttpCode(200)
  async assist(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "update");
    send(reply, await webdeskAssist.assist(gate, { tenantSlug, siteId }, itemId, body));
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

  // ── M5-W2d: the writers' room review flow (docs/plans/2026-10-11-m5-writers-room-design.md §4.3) ─────────────
  // Same two phases as every route above: `authorizeSite` first, then (in `webdesk-editorial.service.ts`) the item is read from
  // WebDesk and the REAL action is checked with its attributes BEFORE the body is validated; then the signed command is forwarded.
  // submit/withdraw -> `submit`; request-changes -> `request_changes`; seo-signoff -> `seo_signoff`; approve -> `approve` (maker != checker:
  // the creator of the submitted version, from WebDesk's read); assign -> `assign`; comments -> `comment`; editorial-policy ->
  // `webdesk_collection:manage_editorial`. The static `editorial/…` paths cannot collide with `items/:itemId`.

  @Get("sites/:tenantSlug/:siteId/editorial/board")
  @ContributorRoute()
  async editorialBoard(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskEditorial.board(gate, { tenantSlug, siteId }, query));
  }

  // M5-W5: the calendar and workflow board — the review board joined with scheduled publish dates, pending publish requests and briefs.
  // Same gate as the board (`authorizeSite` first; the service filters every row by Cerbos before it joins anything to it).
  @Get("sites/:tenantSlug/:siteId/editorial/calendar")
  async editorialCalendar(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskCalendar.calendar(gate, { tenantSlug, siteId }, query));
  }

  @Get("sites/:tenantSlug/:siteId/items/:itemId/editorial")
  @ContributorRoute()
  async editorialHistory(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Query() query: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    send(reply, await webdeskEditorial.history(gate, { tenantSlug, siteId }, itemId, query));
  }

  // ── M5-W8: the writer dashboard. Phase 1 here; the service asks the real question (Cerbos per collection and language, or one
  // company-level read) before the query is looked at. A read of counts only: a lead is never a name, an address or an id.
  @Get("sites/:tenantSlug/:siteId/writers/dashboard")
  async writersDashboard(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Query() query: unknown,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "read");
    return webdeskWritersDashboard.read(gate, { tenantSlug, siteId }, query);
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/submit")
  @ContributorRoute()
  @HttpCode(200)
  async editorialSubmit(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "submit");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "submit", body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/withdraw")
  @ContributorRoute()
  @HttpCode(200)
  async editorialWithdraw(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "submit");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "withdraw", body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/request-changes")
  @ContributorRoute()
  @HttpCode(200)
  async editorialRequestChanges(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "request_changes");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "requestChanges", body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/seo-signoff")
  @ContributorRoute()
  @HttpCode(200)
  async editorialSeoSignoff(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "seo_signoff");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "seoSignoff", body, idempotencyKeyOf(idem)));
  }

  /** Phase 1 is the site-level read only: an attribute-free `approve` is denied for everyone (no creator is known yet), so the item decides. */
  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/approve")
  @HttpCode(200)
  async editorialApprove(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "read");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "approve", body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/assign")
  @HttpCode(200)
  async editorialAssign(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "assign");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "assign", body, idempotencyKeyOf(idem)));
  }

  /** 201 (WebDesk's status, passed through). */
  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/comments")
  @ContributorRoute()
  async editorialComment(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "comment");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "comment", body, idempotencyKeyOf(idem)));
  }

  @Post("sites/:tenantSlug/:siteId/items/:itemId/editorial/comments/:commentId/resolve")
  @ContributorRoute()
  @HttpCode(200)
  async editorialCommentResolve(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("itemId") itemId: string, @Param("commentId") commentId: string,
    @Headers("idempotency-key") idem: string | undefined, @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_content_item", "comment");
    send(reply, await webdeskEditorial.itemCommand(gate, { tenantSlug, siteId }, itemId, "commentResolve", body, idempotencyKeyOf(idem), commentId));
  }

  @Put("sites/:tenantSlug/:siteId/collections/:collectionKey/editorial-policy")
  async editorialPolicy(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "manage_editorial");
    send(reply, await webdeskEditorial.setPolicy(gate, { tenantSlug, siteId }, collectionKey, body, idempotencyKeyOf(idem)));
  }

  /** The MCP hub's method union has no PUT, so `webdesk.editorial.setPolicy` calls this alias: same path, same body, same semantics. */
  @Patch("sites/:tenantSlug/:siteId/collections/:collectionKey/editorial-policy")
  async editorialPolicyPatch(
    @Req() req: FastifyRequest, @Param("tenantId") tenantId: string,
    @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string, @Headers("idempotency-key") idem: string | undefined,
    @Body() body: unknown, @Res() reply: FastifyReply,
  ) {
    const gate = await authorizeSite(req.principal, tenantId, siteId, "webdesk_collection", "manage_editorial");
    send(reply, await webdeskEditorial.setPolicy(gate, { tenantSlug, siteId }, collectionKey, body, idempotencyKeyOf(idem)));
  }
}
