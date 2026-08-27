// WSK-37 — tenant webhook registration endpoints.
//
// SECURITY NOTE, same gap ApiKeysController already flags loudly (api-keys.controller.ts's own
// header, reproduced here because it applies identically): these are Zone B CONTROL-PLANE
// commands with no caller authentication of their own yet. The real control channel (mTLS +
// offline-verified Keycloak token + Cerbos scopes + WS4 on irreversible commands, design §03) is
// WSK-21/WSK-22's — registering, rotating, or disabling a webhook is arguably itself a
// HIGH-write command (it grants a client-controlled destination a live feed of their own form
// submissions) and should get a Cerbos scope + WS4 assertion once that machinery exists. Until
// then this controller must not be reachable through the public proxy vhost, matching
// api-keys.controller.ts's own stated posture. Flagged in the ticket report, not silently assumed
// safe.
import { Body, Controller, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { TenantWebhooksService } from "./tenant-webhooks.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { assertEventKinds, assertHttpsUrl, assertOptionalBoolean, assertOptionalDescription, assertTenantSlug, assertUuid } from "./dto";

@Controller("internal/tenants/:tenantSlug/webhooks")
export class TenantWebhooksController {
  constructor(private readonly webhooks: TenantWebhooksService, private readonly tenants: TenantLookupService) {}

  private async resolveTenantId(tenantSlugRaw: unknown): Promise<string> {
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") {
      throw new NotFoundException("tenant not found");
    }
    return tenant.id;
  }

  @Post()
  async register(
    @Param("tenantSlug") tenantSlug: string,
    @Body() body: { targetUrl?: string; eventKinds?: string[]; description?: string },
  ) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    const targetUrl = assertHttpsUrl(body?.targetUrl, "targetUrl");
    const eventKinds = assertEventKinds(body?.eventKinds);
    const description = assertOptionalDescription(body?.description);
    return this.webhooks.register(tenantId, { targetUrl, eventKinds, description });
  }

  @Get()
  async list(@Param("tenantSlug") tenantSlug: string) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    return this.webhooks.list(tenantId);
  }

  @Post(":webhookId/rotate")
  async rotate(@Param("tenantSlug") tenantSlug: string, @Param("webhookId") webhookId: string) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    assertUuid(webhookId, "webhookId");
    return this.webhooks.rotateSecret(tenantId, webhookId);
  }

  @Post(":webhookId/enabled")
  async setEnabled(
    @Param("tenantSlug") tenantSlug: string,
    @Param("webhookId") webhookId: string,
    @Body() body: { enabled?: boolean },
  ) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    assertUuid(webhookId, "webhookId");
    const enabled = assertOptionalBoolean(body?.enabled, "enabled", true);
    return this.webhooks.setEnabled(tenantId, webhookId, enabled);
  }

  @Get(":webhookId/deliveries")
  async deliveries(@Param("tenantSlug") tenantSlug: string, @Param("webhookId") webhookId: string) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    assertUuid(webhookId, "webhookId");
    return this.webhooks.listDeliveries(tenantId, webhookId);
  }
}
