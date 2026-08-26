// WSK-07 — the public serving/transform routes carry NO api key (design §11: "served cookieless")
// yet still need a tenant CONTEXT for the RLS-scoped lookup that is this ticket's actual isolation
// mechanism (media.service.ts's header). This guard resolves `:tenantSlug` the exact same way
// ApiKeyAuthGuard does (WSK-05's TenantLookupService, the one legitimate cross-tenant read) and
// enters that tenant's GUC context — but stops there; it does NOT authenticate a caller, because
// public media has no caller identity to authenticate. Never apply this guard to a route that
// serves anything from the PRIVATE `uploads` bucket.
import { CanActivate, ExecutionContext, Injectable, NotFoundException } from "@nestjs/common";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { enterTenantContext } from "../db/tenant-context";
import type { WebdeskRequest } from "../auth/webdesk-request";

@Injectable()
export class PublicTenantGuard implements CanActivate {
  constructor(private readonly tenants: TenantLookupService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebdeskRequest & { webdeskTenantId?: string }>();
    const params = (request.params ?? {}) as Record<string, string>;
    const tenantSlug = params.tenantSlug;
    if (!tenantSlug) throw new NotFoundException();

    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") {
      // Same 404 shape whether the slug is unknown or inactive — no existence oracle for tenant
      // slugs on a route that requires no credential at all.
      throw new NotFoundException();
    }

    request.webdeskTenantId = tenant.id;
    enterTenantContext(tenant.id);
    return true;
  }
}
