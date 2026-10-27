// SCP-2 — the client's approval page for the Social Media content pipeline (FRONTEND-BFF-CONTRACT §63.9). Routes under
// `api/:tenantId/portal/social`, behind AuthGuard, gated by Cerbos `portal` and narrowed by `resolvePortalScope`.
//
//   GET  posts?tab=to_review|approved|grid&clientId=&month=&cursor=&limit=   portal · read           {items, nextCursor, counts}
//   GET  stories                                                             portal · read           {items}
//   GET  posts/:postId                                                       portal · read           PortalSocialPost
//   POST posts/:postId/decide                                                portal · approve_post   {decisionId, postId, state, undoUntil}
//   POST posts/approve-all                                                   portal · approve_post   {results, undoUntil}
//   POST decisions/:decisionId/undo                                          portal · approve_post   {decisionId, postId, state}
//
// A thin controller, as `social-client-review-portal.controller.ts` is (the portal is core: its controllers stay in
// `src/core/`; the DOMAIN logic is `modules/social/pipeline/portal-read.ts` and `portal-actions.ts`). The order of checks on
// every route: Cerbos `portal`, then `resolvePortalScope`, then the post's visibility (a post that is not the caller's to see is
// 404, never 403), then the body (400 `{field}`). The per-variant routes of `social-client-review-portal.controller.ts` stay as
// they are: they list only Composer posts and refuse a pipeline post's review with 409 `decide_per_post`.
//
// Nothing here is staff-only: no internal status, holder, check, copy log, suggestion or team comment is ever selected
// (portal-read.ts says how).
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import { resolvePortalScope } from "./portal-scope";
import { ScpRouteError } from "../modules/social/pipeline/pipeline-effects";
import { portalApproveAll, portalDecide, portalUndo } from "../modules/social/pipeline/portal-actions";
import { listPortalPosts, listPortalStories, parseListQuery, readPortalPost } from "../modules/social/pipeline/portal-read";

const SOCIAL = { modules: ["social"] };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("api/:tenantId/portal/social")
@UseGuards(AuthGuard)
export class SocialPipelinePortalController {
  @Get("posts")
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() q: Record<string, unknown>) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      return listPortalPosts(c, tenantId, scope.clientIds, parseListQuery(q ?? {}));
    }, SOCIAL);
  }

  @Get("stories")
  async stories(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query() q: Record<string, unknown>) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    return withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      const raw = q?.clientId;
      const clientId = typeof raw === "string" && raw !== "" ? raw : undefined;
      if (clientId !== undefined && !UUID_RE.test(clientId)) throw new ScpRouteError(400, "invalid_field", { field: "clientId" });
      return listPortalStories(c, tenantId, scope.clientIds, clientId);
    }, SOCIAL);
  }

  // `approve-all` and `decide` never collide: the first is a literal segment under `posts`, the second sits under `posts/:postId`.
  @Post("posts/approve-all")
  @HttpCode(200)
  async approveAll(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    return portalApproveAll(req.principal, tenantId, body);
  }

  @Get("posts/:postId")
  async one(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string) {
    await authorize(req.principal, { kind: "portal", tenantId }, "read");
    const post = await withTenants([tenantId], async (c) => {
      const scope = await resolvePortalScope(c, req.principal);
      return readPortalPost(c, tenantId, scope.clientIds, postId);
    }, SOCIAL);
    if (!post) throw new ScpRouteError(404, "post_not_found");
    return post;
  }

  @Post("posts/:postId/decide")
  @HttpCode(200)
  async decide(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("postId") postId: string, @Body() body: unknown) {
    return portalDecide(req.principal, tenantId, postId, body);
  }

  @Post("decisions/:decisionId/undo")
  @HttpCode(200)
  async undo(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("decisionId") decisionId: string) {
    return portalUndo(req.principal, tenantId, decisionId);
  }
}
