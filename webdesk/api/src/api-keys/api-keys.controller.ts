// WSK-05 — key lifecycle endpoints.
//
// SECURITY NOTE, loudly, because this is the one gap this ticket cannot close on its own: these
// are Zone B CONTROL-PLANE commands (design §03/§07 — `key.mint/rotate/revoke` is HIGH-write,
// always WS4). The real control channel (mTLS from synccert + an offline-verified Keycloak
// client-credentials token + Cerbos scopes + a WS4 assertion on irreversible commands) is WSK-21's
// (command surface) and WSK-22's (the auth layers) — neither exists yet. Until they land, this
// controller has NO caller authentication of its own; it must not be reachable through the public
// proxy vhost (webdesk/proxy/Caddyfile — WSK-01's file, not touched here) or through anything but
// a trusted internal caller (ops tooling, tests, and later WSK-21's command handler calling this
// service in-process rather than over HTTP). Flagged in the WSK-05 ticket report as a required
// follow-up, not silently assumed safe.
import { Body, Controller, Param, Post } from "@nestjs/common";
import { NotFoundException } from "@nestjs/common";
import { ApiKeysService } from "./api-keys.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { assertScope, assertTenantSlug, assertUuid } from "./dto";

@Controller("internal/tenants/:tenantSlug/api-keys")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService, private readonly tenants: TenantLookupService) {}

  private async resolveTenantId(tenantSlugRaw: unknown): Promise<string> {
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") {
      throw new NotFoundException("tenant not found");
    }
    return tenant.id;
  }

  @Post()
  async mint(@Param("tenantSlug") tenantSlug: string, @Body() body: { envId?: string; scope?: string; actor?: string }) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    const envId = assertUuid(body?.envId, "envId");
    const scope = assertScope(body?.scope);
    const actor = typeof body?.actor === "string" && body.actor.length > 0 ? body.actor : "control-plane";
    const minted = await this.apiKeys.mint(tenantId, envId, scope, actor);
    return minted;
  }

  @Post(":apiKeyId/rotate")
  async rotate(
    @Param("tenantSlug") tenantSlug: string,
    @Param("apiKeyId") apiKeyId: string,
    @Body() body: { actor?: string },
  ) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    assertUuid(apiKeyId, "apiKeyId");
    const actor = typeof body?.actor === "string" && body.actor.length > 0 ? body.actor : "control-plane";
    return this.apiKeys.rotate(tenantId, apiKeyId, actor);
  }

  @Post(":apiKeyId/revoke")
  async revoke(
    @Param("tenantSlug") tenantSlug: string,
    @Param("apiKeyId") apiKeyId: string,
    @Body() body: { actor?: string },
  ) {
    const tenantId = await this.resolveTenantId(tenantSlug);
    assertUuid(apiKeyId, "apiKeyId");
    const actor = typeof body?.actor === "string" && body.actor.length > 0 ? body.actor : "control-plane";
    return this.apiKeys.revoke(tenantId, apiKeyId, actor);
  }
}
