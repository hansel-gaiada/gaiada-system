// M5-V3-a -- POST /control/v1/tenants/:tenantSlug/consent/status   consent.status
//
// A control READ that happens to be a POST (up to 100 ids do not fit a query string, and consent ids stay out of
// URLs and access logs). Same guards as every control read: ControlAuthGuard (L1 mTLS + L2 token), then
// CommandAuthorizationGuard (L3 `webdesk:read`, impact class `read`). The guards run BEFORE the body is parsed, so a
// scopeless caller is refused (403) whatever it sent: validation never pre-empts authorization. No Idempotency-Key
// (it changes nothing), no editorial assertion, no audit row.
import { Body, Controller, HttpCode, Param, Post, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { ControlProblemFilter } from "../content/content-problem";
import { ConsentStatusService } from "./consent-status.service";

@Controller("control/v1/tenants/:tenantSlug/consent")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
@UseFilters(ControlProblemFilter)
export class ConsentStatusController {
  constructor(private readonly consent: ConsentStatusService) {}

  @Post("status")
  @HttpCode(200)
  @Command("consent.status")
  async status(@Param("tenantSlug") tenantSlug: string, @Body() raw: unknown) {
    return this.consent.status(tenantSlug, raw);
  }
}
