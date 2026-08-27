// WSK-25 — same `control/v1/tenants` path family as every other control-plane controller
// (ReleasesController/SchemaController/etc.) but with an explicit `/sites/:siteId/content-...`
// suffix so these routes never collide with ../control/releases/releases.controller.ts's own
// `.../environments/:envId/promote` (the box-side FE release trigger this ticket's engine calls
// INTO via FRONTEND_DEPLOY_DRIVER — a distinct, lower-level operation from the content-promotion
// engine built here; see promotion-command.service.ts's header for how the two relate).
//
// Caddy already 404s `/control/*` on the public vhost (WSK-21/22's existing rule) — same
// loud-warning posture as every sibling controller: not reachable through the public proxy until
// the real control channel is fully live end-to-end.
import { Body, Controller, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { PromotionCommandService } from "./promotion-command.service";
import { ControlAuthGuard } from "../control/auth/control-auth.guard";
import { requireControlContext, type ControlRequest } from "../control/auth/control-request";
// WSK-25 unification (owner ruling 2026-08-27) — replaces this module's own
// assertPromotionCommandAuthorized() with the SAME registry-driven Layer-3 guard every other
// control command uses, so these three routes are covered by COMMAND_REGISTRY's exhaustive type
// check. Enforcement is unchanged: export needs webdesk:read; promote/rollback need
// webdesk:promote AND always a WS4 assertion (impactClass "high").
import { CommandAuthorizationGuard } from "../control/policy/command-authorization.guard";
import { Command } from "../control/command.decorator";
import { assertUuid, assertTenantSlug, assertIdempotencyKey, assertOptionalVersion, assertContentBundle } from "./dto";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class PromotionController {
  constructor(private readonly promotion: PromotionCommandService) {}

  @Command("content.export")
  @Post(":tenantSlug/sites/:siteId/content-export")
  async exportContent(@Req() req: ControlRequest, @Param("tenantSlug") tenantSlugRaw: string, @Param("siteId") siteIdRaw: string) {
    const ctx = requireControlContext(req);
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const siteId = assertUuid(siteIdRaw, "siteId");
    return this.promotion.exportContent({ tenantSlug, siteId, actor: ctx.principal.subject });
  }

  @Command("content.promote")
  @Post(":tenantSlug/sites/:siteId/environments/:envId/content-promote")
  async promote(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlugRaw: string,
    @Param("siteId") siteIdRaw: string,
    @Param("envId") envIdRaw: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { version?: string; sourceEnvId?: string; bundle?: unknown },
  ) {
    const ctx = requireControlContext(req);
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const siteId = assertUuid(siteIdRaw, "siteId");
    const targetEnvId = assertUuid(envIdRaw, "envId");
    const version = assertOptionalVersion(body?.version);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    const bundle = body?.bundle !== undefined ? assertContentBundle(body.bundle) : undefined;

    return this.promotion.promote({
      tenantSlug,
      siteId,
      targetEnvId,
      sourceEnvId: body?.sourceEnvId ? assertUuid(body.sourceEnvId, "sourceEnvId") : null,
      version,
      bundle,
      actor: ctx.principal.subject,
      idempotencyKey,
      ws4ApprovalId: ctx.ws4ApprovalId,
    });
  }

  @Command("content.rollback")
  @Post(":tenantSlug/sites/:siteId/environments/:envId/content-rollback")
  async rollback(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlugRaw: string,
    @Param("siteId") siteIdRaw: string,
    @Param("envId") envIdRaw: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { version?: string },
  ) {
    const ctx = requireControlContext(req);
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const siteId = assertUuid(siteIdRaw, "siteId");
    const targetEnvId = assertUuid(envIdRaw, "envId");
    const version = assertOptionalVersion(body?.version);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);

    return this.promotion.rollback({
      tenantSlug,
      siteId,
      targetEnvId,
      version,
      actor: ctx.principal.subject,
      idempotencyKey,
      ws4ApprovalId: ctx.ws4ApprovalId,
    });
  }
}
