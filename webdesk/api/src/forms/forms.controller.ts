// WSK-10 — the public route surface. `POST :formId/submit` is the ticket's endpoint; `OPTIONS
// :formId/submit` is the CORS preflight browsers send ahead of any cross-origin POST carrying a
// non-"simple" Content-Type (application/json qualifies) — both share FormContextGuard so a
// preflight is refused exactly like the real request would be for a disallowed origin, and both
// get the same Access-Control-Allow-* headers the guard sets on success.
//
// Route is `v1/t/:tenantSlug/forms/:formId/submit`, NOT the ticket brief's literal
// `v1/forms/:formId/submit` — form-lookup.service.ts's header explains why (form_defs' RLS policy
// has no cross-tenant read path at all, so the tenant must be known before form_defs can be
// queried). Flagged prominently in the ticket report as a deviation from the literal spec, forced
// by the frozen 0003_forms.sql schema.
import { Body, Controller, HttpCode, Options, Post, Req, UseGuards } from "@nestjs/common";
import { FormsService } from "./forms.service";
import { FormContextGuard } from "./form-context.guard";
import { FormRateLimitGuard } from "./form-rate-limit.guard";
import type { WebdeskFormRequest } from "./forms-request";
import type { FormSubmitBody } from "./dto";

@Controller("v1/t/:tenantSlug/forms")
export class FormsController {
  constructor(private readonly forms: FormsService) {}

  @Post(":formId/submit")
  @HttpCode(201)
  // Ordering matters: FormContextGuard resolves tenant + form + CORS FIRST (a wrong origin must
  // 403 before a rate-limit bucket is ever touched); FormRateLimitGuard runs second and needs
  // `request.webdeskForm` (see its own header).
  @UseGuards(FormContextGuard, FormRateLimitGuard)
  async submit(@Req() req: WebdeskFormRequest, @Body() body: FormSubmitBody) {
    const form = req.webdeskForm!; // guaranteed by FormContextGuard — see its own throw-or-set contract
    const result = await this.forms.submit({
      form,
      body: (body ?? {}) as Record<string, unknown>,
      remoteIp: req.ip,
      actor: `form:${form.formId}`,
    });
    return result;
  }

  @Options(":formId/submit")
  @HttpCode(204)
  @UseGuards(FormContextGuard)
  preflight(): void {
    // FormContextGuard already set every Access-Control-Allow-* header on success (or threw a 403
    // for a disallowed origin) — nothing left to do here but return an empty 204.
  }
}
