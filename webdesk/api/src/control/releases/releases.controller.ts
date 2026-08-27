// See ../lifecycle/lifecycle.controller.ts's header — same loud warning applies to every route
// in this file. deploy/triggerRebuild are medium-write; promote/rollback are HIGH (design §07) —
// CommandAuthorizationGuard enforces the WS4-assertion requirement per command, not per
// controller. Every response is `{ jobId, replayed }` — poll `GET .../jobs/:jobId`
// (../jobs/jobs.controller.ts) for progress; none of these calls block on the actual release work.
import { Body, Controller, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ReleasesCommandService } from "./releases-command.service";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { assertIdempotencyKey, assertUuid } from "../dto";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class ReleasesController {
  constructor(private readonly releases: ReleasesCommandService) {}

  @Post(":tenantSlug/environments/:envId/deploy")
  @Command("release.deploy")
  async deploy(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("envId") envId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { version?: string },
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    assertUuid(envId, "envId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.releases.deploy({ tenantSlug, envId, version: body?.version, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }

  @Post(":tenantSlug/environments/:envId/promote")
  @Command("release.promote")
  async promote(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("envId") envId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { version?: string },
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    assertUuid(envId, "envId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.releases.promote({ tenantSlug, envId, version: body?.version, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }

  @Post(":tenantSlug/environments/:envId/rollback")
  @Command("release.rollback")
  async rollback(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("envId") envId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { version?: string },
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    assertUuid(envId, "envId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.releases.rollback({ tenantSlug, envId, version: body?.version, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }

  @Post(":tenantSlug/environments/:envId/rebuild")
  @Command("release.triggerRebuild")
  async triggerRebuild(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("envId") envId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    assertUuid(envId, "envId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.releases.triggerRebuild({ tenantSlug, envId, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }
}
