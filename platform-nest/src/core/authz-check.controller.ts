// Non-mutating authorization probe (Nest port). Surfaces call this BEFORE prompting a user to
// confirm a write, so a would-be-denied caller never sees a confirmation card. Same Cerbos
// check() as the mutating routes; unresolved identity → "stepup" (prompt to link+verify).
import { BadRequestException, Body, Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { check } from "../rbac/cerbos";
import { AuthGuard } from "../auth/guards";

@Controller("api")
@UseGuards(AuthGuard)
export class AuthzCheckController {
  @Post(":tenantId/authz/check")
  @HttpCode(200)
  async probe(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Body() body: { resource?: string; action?: string; projectId?: string; id?: string },
  ) {
    const { resource, action, projectId, id } = body ?? {};
    if (!resource || !action) throw new BadRequestException("resource and action required");
    if (!req.principal.userId) return { decision: "stepup" as const };
    const decision = await check(req.principal, { kind: resource, tenantId, projectId, id }, action);
    return decision.allow ? { decision: "allow" as const } : { decision: "deny" as const, reason: decision.reason };
  }
}
