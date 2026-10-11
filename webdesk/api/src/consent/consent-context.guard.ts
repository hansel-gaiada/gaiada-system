// M5-G6 — resolves :tenantSlug to a tenant context, then the request Origin to a SITE of that tenant, and sets
// the CORS headers, exactly as forms/form-context.guard.ts does for a form. The consent endpoint has no form id,
// so the allowlist is the set of environment domains of the tenant's sites, and the matching one names the site
// the decision belongs to. Unknown or inactive tenant => 404 (no existence oracle, like the forms and media
// routes); a missing or unlisted Origin => 403 before any rate-limit bucket is touched.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { enterTenantContext } from "../db/tenant-context";
import { ConsentRepository } from "./consent.repository";
import type { WebdeskConsentRequest } from "./consent-request";

@Injectable()
export class ConsentContextGuard implements CanActivate {
  constructor(
    private readonly tenants: TenantLookupService,
    private readonly repo: ConsentRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebdeskConsentRequest>();
    const reply = context.switchToHttp().getResponse<{ header: (name: string, value: string) => void }>();
    const tenantSlug = ((request.params ?? {}) as Record<string, string>).tenantSlug;
    if (!tenantSlug) throw new NotFoundException();

    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException();
    enterTenantContext(tenant.id);

    const origin = request.headers?.origin;
    const siteId = typeof origin === "string" && origin !== "" ? await this.repo.siteIdForOrigin(tenant.id, origin) : null;
    if (!siteId || typeof origin !== "string") throw new ForbiddenException("origin not allowed for this site");

    if (typeof reply?.header === "function") {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type");
    }
    // No cookies, ever: nothing on this route sets one, and credentials are not allowed cross-origin.
    request.webdeskConsent = { tenantId: tenant.id, tenantSlug: tenant.slug, siteId };
    return true;
  }
}
