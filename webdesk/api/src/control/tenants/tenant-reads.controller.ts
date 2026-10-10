// WSK-51 — GET /control/v1/tenants?companyRef=<uuid>   tenant.list (write-plane design §4)
//
// Same guards as every control read: L1/L2 (ControlAuthGuard) then L3 `webdesk:read`
// (CommandAuthorizationGuard). No editorial assertion, no audit row. `companyRef` is required and
// must be a uuid (400 otherwise): see tenant-reads.service.ts for why an absent filter is an error.
import { Controller, Get, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { ControlProblemFilter, problems } from "../content/content-problem";
import { TenantReadsService } from "./tenant-reads.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
@UseFilters(ControlProblemFilter)
export class TenantReadsController {
  constructor(private readonly tenants: TenantReadsService) {}

  @Get()
  @Command("tenant.list")
  async list(@Query() raw: Record<string, unknown>) {
    for (const k of Object.keys(raw ?? {})) {
      if (k !== "companyRef") throw problems.invalidRequest(`unknown query parameter "${k}" (allowed: companyRef)`);
    }
    const companyRef = raw?.companyRef;
    if (typeof companyRef !== "string" || !UUID_RE.test(companyRef)) {
      throw problems.invalidRequest("companyRef is required and must be a company id (uuid), given once");
    }
    return this.tenants.list(companyRef.toLowerCase());
  }
}
