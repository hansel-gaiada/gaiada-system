// ============================================================================================
// LOUD WARNING — Zone B CONTROL-PLANE surface (design §03/§07/§08 C-05 command set). The real
// control channel (synccert mTLS + offline-verified Keycloak client-credentials token + Cerbos
// scopes + a WS4 assertion on irreversible commands) is WSK-22's build. ControlAuthGuard below
// uses a DEV-MODE STUB with NO cryptographic verification — see
// ../auth/dev-mode-control-channel-authenticator.ts. NOTHING under /control/v1/** may be
// reachable through the public proxy vhost (webdesk/proxy/Caddyfile) until WSK-22 lands. Same
// rule, same reasoning, as ../../api-keys/api-keys.controller.ts's own header comment (WSK-05).
// ============================================================================================
import { Body, Controller, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { LifecycleService } from "./lifecycle.service";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { assertIdempotencyKey, assertNonEmptyString, assertSiteKind, assertSlug, assertEnvName, assertUuid } from "../dto";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  @Post()
  @Command("tenant.provision")
  async provisionTenant(
    @Req() req: ControlRequest,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { slug?: string; companyRef?: string },
  ) {
    const { principal } = requireControlContext(req);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    const slug = assertSlug(body?.slug);
    const companyRef = assertUuid(body?.companyRef, "companyRef");
    return this.lifecycle.provisionTenant({ slug, companyRef, actor: principal.subject, idempotencyKey });
  }

  @Post(":tenantSlug/archive")
  @Command("tenant.archive")
  async archiveTenant(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.lifecycle.archiveTenant({ slug: tenantSlug, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }

  @Post(":tenantSlug/sites")
  @Command("site.provision")
  async provisionSite(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { kind?: string; name?: string },
  ) {
    const { principal } = requireControlContext(req);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    const kind = assertSiteKind(body?.kind);
    const name = assertNonEmptyString(body?.name, "name");
    return this.lifecycle.provisionSite({ tenantSlug, kind, name, actor: principal.subject, idempotencyKey });
  }

  @Post(":tenantSlug/sites/:siteId/archive")
  @Command("site.archive")
  async archiveSite(@Req() req: ControlRequest, @Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string) {
    const { principal } = requireControlContext(req);
    assertUuid(siteId, "siteId");
    return this.lifecycle.archiveSite({ tenantSlug, siteId, actor: principal.subject });
  }

  @Post(":tenantSlug/sites/:siteId/environments")
  @Command("environment.provision")
  async provisionEnvironment(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { name?: string; domain?: string },
  ) {
    const { principal } = requireControlContext(req);
    assertUuid(siteId, "siteId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    const name = assertEnvName(body?.name);
    return this.lifecycle.provisionEnvironment({
      tenantSlug,
      siteId,
      name,
      domain: typeof body?.domain === "string" && body.domain.length > 0 ? body.domain : null,
      actor: principal.subject,
      idempotencyKey,
    });
  }

  @Post(":tenantSlug/environments/:envId/archive")
  @Command("environment.archive")
  async archiveEnvironment(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("envId") envId: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    assertUuid(envId, "envId");
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.lifecycle.archiveEnvironment({ tenantSlug, envId, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }
}
