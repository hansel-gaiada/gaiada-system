// M5-L1d — a site's form definitions, Zone B control plane:
//
//   PUT /control/v1/tenants/:tenantSlug/sites/:siteId/forms/:formKey   forms.define      (MEDIUM / webdesk:operate)
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/forms            forms.def.list     (read)
//   GET /control/v1/tenants/:tenantSlug/sites/:siteId/forms/:formKey   forms.def.get      (read)
//
// Gated like schema.apply and the other non-editorial writes: ControlAuthGuard (L1 mTLS + L2 token) ->
// CommandAuthorizationGuard (L3 scope) -> the handler, which validates the body here. The guards run first, so a
// refused caller is refused whatever its body: validation can never pre-empt authorisation. forms.define needs an
// Idempotency-Key and answers 200 with `{ form, created, consentNoticeChanged, replayed }`.
//
// The form's key is the ROUTE parameter, so a body naming one is refused (the command hash merges params and body;
// a body `key` would make it ambiguous). The body is `{ schema, notify?, retentionDays, consentNoticeVersion }`
// (form-definition.ts), the shape of webdesk/sites/gaiada-com/forms/*.json minus its `key`.
import { Body, Controller, Get, Headers, HttpCode, Param, Put, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { ControlProblemFilter, problems } from "../content/content-problem";
import { FormDefsService, parseOrRefuse } from "./form-defs.service";

function idempotencyKey(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 200) {
    throw problems.invalidRequest("the Idempotency-Key header is required (8..200 chars) on forms.define");
  }
  return raw;
}

@Controller("control/v1/tenants/:tenantSlug/sites/:siteId/forms")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
@UseFilters(ControlProblemFilter)
export class FormDefsController {
  constructor(private readonly defs: FormDefsService) {}

  @Put(":formKey")
  @HttpCode(200)
  @Command("forms.define")
  async define(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("formKey") formKey: string,
    @Headers("idempotency-key") idem: string | undefined,
    @Body() raw: unknown,
  ) {
    const { principal } = requireControlContext(req);
    const key = idempotencyKey(idem);
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      for (const reserved of ["key", "tenantSlug", "siteId", "formKey"]) {
        if (reserved in raw) throw problems.invalidRequest(`the body may not contain "${reserved}": it is a route parameter`);
      }
    }
    const { tenant } = await this.defs.resolveTenantSite(tenantSlug, siteId);
    const def = parseOrRefuse(formKey, raw);
    return this.defs.define({ tenant: { id: tenant.id, slug: tenant.slug }, siteId, actor: principal.subject, idempotencyKey: key }, def);
  }

  @Get()
  @Command("forms.def.list")
  async list(@Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string) {
    const { tenant } = await this.defs.resolveTenantSite(tenantSlug, siteId);
    return this.defs.list(tenant.id, siteId);
  }

  @Get(":formKey")
  @Command("forms.def.get")
  async get(@Param("tenantSlug") tenantSlug: string, @Param("siteId") siteId: string, @Param("formKey") formKey: string) {
    const { tenant } = await this.defs.resolveTenantSite(tenantSlug, siteId);
    return this.defs.get(tenant.id, siteId, formKey);
  }
}
