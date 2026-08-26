// WSK-10 — resolves :tenantSlug -> tenant context (same mechanism as media/public-tenant.guard.ts,
// reused via TenantLookupService, WSK-05), then resolves :formId's form_defs row UNDER that
// context (form-lookup.service.ts's header explains why tenant context must come first), then
// enforces the per-tenant CORS origin allowlist (§11 AC: "wrong origin 403"). On success it also
// sets the CORS response headers for the ACTUAL request (not just preflight) — see forms.module.ts
// for the paired OPTIONS preflight route that reuses this same guard.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { FormLookupService } from "./form-lookup.service";
import { enterTenantContext } from "../db/tenant-context";
import type { WebdeskFormRequest } from "./forms-request";

function normalizeOrigin(originOrDomain: string): string {
  return originOrDomain.trim().toLowerCase().replace(/\/+$/, "");
}

/** Builds the set of Origin header values a domain legitimately produces — both schemes, since
 *  `environments.domain` (the allowlist source) carries no scheme of its own and this ticket has
 *  no signal for which a given environment actually terminates TLS with. */
function originsForDomain(domain: string): string[] {
  const host = normalizeOrigin(domain);
  return [`https://${host}`, `http://${host}`];
}

@Injectable()
export class FormContextGuard implements CanActivate {
  constructor(private readonly tenants: TenantLookupService, private readonly forms: FormLookupService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WebdeskFormRequest>();
    const reply = context.switchToHttp().getResponse<{ header: (name: string, value: string) => void }>();
    const params = (request.params ?? {}) as Record<string, string>;
    const tenantSlug = params.tenantSlug;
    const formId = params.formId;

    if (!tenantSlug || !formId) throw new NotFoundException();

    // Same no-existence-oracle discipline as media's PublicTenantGuard: unknown/inactive tenant
    // slug and unknown form id both 404, indistinguishably from each other or from a wrong-tenant
    // form id below.
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException();

    enterTenantContext(tenant.id);

    const form = await this.forms.byId(formId);
    if (!form) throw new NotFoundException();

    // Belt-and-suspenders app-layer check (WSK-D16 doctrine: "a GUC gap must degrade to a wrong
    // app-layer filter, never a silent cross-tenant read") — redundant with RLS under normal
    // operation, since `form.byId` could not have returned a row for a different tenant in the
    // first place once the GUC is set correctly.
    if (form.tenant_id !== tenant.id) throw new NotFoundException();

    const allowedDomains = await this.forms.allowedDomainsForSite(form.site_id);
    const allowedOrigins = new Set(allowedDomains.flatMap(originsForDomain));

    const origin = request.headers?.origin;
    if (!origin || typeof origin !== "string" || !allowedOrigins.has(normalizeOrigin(origin))) {
      // §11 AC: "strict per-tenant CORS origin allowlist" — missing Origin refuses exactly like a
      // mismatched one. No existence oracle here either: this 403 carries no hint about which
      // origins WOULD have been accepted.
      throw new ForbiddenException("origin not allowed for this form");
    }

    if (typeof reply?.header === "function") {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type");
    }

    request.webdeskForm = {
      formId: form.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      siteId: form.site_id,
      key: form.key,
      schema: (form.schema ?? {}) as Record<string, unknown>,
      notify: (form.notify ?? {}) as Record<string, unknown>,
      retentionDays: form.retention_days,
      consentNoticeVersion: form.consent_notice_version,
    };
    return true;
  }
}
