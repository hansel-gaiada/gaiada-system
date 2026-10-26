// M5-W1d — freelance contributor routes (owner ruling WSK-D84; design docs/plans/2026-10-11-m5-writers-room-design.md §3.1,
// §8; FRONTEND-BFF-CONTRACT §27 "Freelance contributors"):
//
//   GET  /api/:tenantId/modules/webdev/editorial/contributors                every engagement of this company
//   POST /api/:tenantId/modules/webdev/editorial/contributors/invite         invite (pre-creates the contributor + anchor)
//   POST /api/:tenantId/modules/webdev/editorial/contributors/:userId/end    end (revoke grants, bump session, disable login)
//   POST /api/editorial-invites/accept                                       PUBLIC: redeem the single-use token (body)
//
// Who may (the three staff routes): Cerbos `webdesk_collection` · `manage_editorial` on {tenantId, module: webdev}, the
// publisher tier that already grants the writers' room roles (company_admin, owner, webdev_manager, platform_admin; design
// §2.6). No new action, no new kind. A scoped editor, a writer, webdev_staff, a manager, a member, a client and a contributor
// are all denied. THE FIRST STATEMENT OF EVERY STAFF HANDLER IS THE CERBOS CHECK, so a denied caller gets 403 whatever it
// sent (the "validation pre-empts authz" trap). None of these routes carries `@ContributorRoute()`: a contributor reaches
// none of them (AuthGuard's fence answers 403 `contributor_route_forbidden` first).
//
// The accept route is its OWN controller with NO AuthGuard, for the reason ClientInviteAcceptController gives: the person has
// no account yet, and a guard is applied per controller. The token travels in the BODY (a ~170-character token 404s as a
// path segment past Fastify's maxParamLength of 100, and a URL is logged where a body is not). The design's
// `POST /api/editorial-invites/:token/accept` is therefore `POST /api/editorial-invites/accept` with `{ token }`.
import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize } from "../../core/http";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import {
  acceptContributorInvite, endContributor, inviteContributor, listContributors, parseContributorInviteBody,
} from "./editorial-contributors.service";

const resource = (tenantId: string) => ({ kind: "webdesk_collection", tenantId, module: "webdev" });

@Controller("api/:tenantId/modules/webdev/editorial/contributors")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
export class EditorialContributorsController {
  @Get()
  async list(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, resource(tenantId), "manage_editorial");
    return listContributors(tenantId);
  }

  @Post("invite")
  @HttpCode(201)
  async invite(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, resource(tenantId), "manage_editorial");
    return inviteContributor(req.principal, tenantId, parseContributorInviteBody(body));
  }

  @Post(":userId/end")
  @HttpCode(200)
  async end(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("userId") userId: string) {
    await authorize(req.principal, resource(tenantId), "manage_editorial");
    return endContributor(req.principal, tenantId, userId);
  }
}

@Controller("api")
export class EditorialContributorAcceptController {
  @Post("editorial-invites/accept")
  @HttpCode(200)
  async accept(@Body() body: unknown) {
    return acceptContributorInvite(body);
  }
}
