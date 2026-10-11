// M5-L1/L2 — GET /control/v1/tenants/:tenantSlug/forms/submissions/:submissionId   forms.submission.get
//
// Same guards as every control read: ControlAuthGuard (L1 mTLS + L2 token), then CommandAuthorizationGuard
// (L3 `webdesk:read`, impact class `read` = the contract's "LOW"). No editorial assertion, no audit row.
// The contract's `siteSlug` is the tenant slug in the path (the Zone B fact's `siteSlug` carries the tenant
// slug; see forms.service.ts).
import { Controller, Get, Param, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { ControlProblemFilter, problems } from "../content/content-problem";
import { FormsReadsService } from "./forms-reads.service";

@Controller("control/v1/tenants/:tenantSlug/forms/submissions")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
@UseFilters(ControlProblemFilter)
export class FormsReadsController {
  constructor(private readonly reads: FormsReadsService) {}

  @Get(":submissionId")
  @Command("forms.submission.get")
  async get(@Param("tenantSlug") tenantSlug: string, @Param("submissionId") submissionId: string, @Query() raw: Record<string, unknown>) {
    for (const k of Object.keys(raw ?? {})) throw problems.invalidRequest(`unknown query parameter "${k}" (allowed: none)`);
    return this.reads.getSubmission(tenantSlug, submissionId);
  }
}
