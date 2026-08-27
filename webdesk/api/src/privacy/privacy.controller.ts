// ============================================================================================
// LOUD WARNING (mirrors every other control/** controller's own): every route here is a Zone B
// CONTROL-PLANE command (design §03/§07/§11, WSK-D22b). Guarded by the SAME dev-mode-stub-by-
// default channel every other control-plane route uses (ControlAuthGuard) — see
// privacy.module.ts's header for exactly how this module re-provides that channel without editing
// `control/**`. NOTHING here may be reachable through the public proxy vhost until WSK-22's real
// channel is the one actually bound (already true for every other control-plane route; this module
// changes nothing about that).
//
// Route prefix is the SAME `control/v1/tenants` every other control-plane controller uses — a
// deliberate choice so the eventual merge into ControlModule (see this ticket's README section) is
// "add PrivacyController to that module's `controllers` array", not a URL change any caller has to
// track. All three commands are POST (never GET, even privacy.find): the identifier is a real
// person's PII and must never land in a URL/query string that gets logged by an intermediary.
// ============================================================================================
import { Body, Controller, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { PrivacyCommandService } from "./privacy.service";
import { ControlAuthGuard } from "../control/auth/control-auth.guard";
import { PrivacyCommandAuthorizationGuard } from "./policy/privacy-command-authorization.guard";
import { PrivacyCommand } from "./command.decorator";
import { requireControlContext, type ControlRequest } from "../control/auth/control-request";
import { assertTenantSlug, assertIdentifier, assertIdempotencyKey } from "./dto";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, PrivacyCommandAuthorizationGuard)
export class PrivacyController {
  constructor(private readonly privacy: PrivacyCommandService) {}

  @Post(":tenantSlug/privacy/find")
  @PrivacyCommand("privacy.find")
  async find(@Req() req: ControlRequest, @Param("tenantSlug") tenantSlugRaw: string, @Body() body: { identifier?: string }) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const identifier = assertIdentifier(body?.identifier);
    return this.privacy.find({ tenantSlug, identifier, actor: principal.subject, ws4ApprovalId });
  }

  @Post(":tenantSlug/privacy/export")
  @PrivacyCommand("privacy.export")
  async export(@Req() req: ControlRequest, @Param("tenantSlug") tenantSlugRaw: string, @Body() body: { identifier?: string }) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const identifier = assertIdentifier(body?.identifier);
    return this.privacy.export({ tenantSlug, identifier, actor: principal.subject, ws4ApprovalId });
  }

  @Post(":tenantSlug/privacy/erase")
  @PrivacyCommand("privacy.erase")
  async erase(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlugRaw: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { identifier?: string },
  ) {
    const { principal, ws4ApprovalId } = requireControlContext(req);
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const identifier = assertIdentifier(body?.identifier);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.privacy.erase({ tenantSlug, identifier, actor: principal.subject, idempotencyKey, ws4ApprovalId });
  }
}
