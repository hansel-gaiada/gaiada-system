// See ../lifecycle/lifecycle.controller.ts's header — same loud warning applies to every route
// in this file. Every command here is HIGH-impact (design §07: "key.mint/rotate/revoke ...
// always WS4, every principal class") — CommandAuthorizationGuard refuses any call missing a
// WS4 assertion before this controller's own handlers ever run.
import { Body, Controller, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { KeysCommandService } from "./keys-command.service";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { assertIdempotencyKey, assertScope, assertUuid } from "../dto";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class KeysController {
  constructor(private readonly keys: KeysCommandService) {}

  @Post(":tenantSlug/keys")
  @Command("key.mint")
  async mint(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { envId?: string; scope?: string },
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    const envId = assertUuid(body?.envId, "envId");
    const scope = assertScope(body?.scope);
    return this.keys.mint({ tenantSlug, envId, scope, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }

  @Post(":tenantSlug/keys/:apiKeyId/rotate")
  @Command("key.rotate")
  async rotate(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("apiKeyId") apiKeyId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    assertUuid(apiKeyId, "apiKeyId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.keys.rotate({ tenantSlug, apiKeyId, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }

  @Post(":tenantSlug/keys/:apiKeyId/revoke")
  @Command("key.revoke")
  async revoke(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("apiKeyId") apiKeyId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    assertUuid(apiKeyId, "apiKeyId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.keys.revoke({ tenantSlug, apiKeyId, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }
}
