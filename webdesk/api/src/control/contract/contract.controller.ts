// See ../lifecycle/lifecycle.controller.ts's header — same loud warning applies (dev-mode control
// channel; not public-proxy-reachable until WSK-22).
//
// WSK-15 — design §06's Zone B end: `GET /control/v1/tenants/:slug/contract`. Replaces the
// WSK-21-era stub (a documented 501 — "WSK-15 does not exist yet") now that the codegen pipeline
// does: this handler authenticates/authorizes/audits exactly like every other control command,
// then serves whatever `ContractReadService` finds in the artifact store, or a documented,
// RFC-9457-shaped 404 when nothing has been generated for this tenant yet — a materially
// different, more honest state than the old blanket "not implemented", now that the reason it
// used to be a 501 no longer applies.
import { Controller, Get, NotFoundException, Param, Req, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { CommandAuditService } from "../command-audit.service";
import { ContractReadService } from "../../codegen/contract-read.service";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class ContractController {
  constructor(
    private readonly tenants: TenantLookupService,
    private readonly commandAudit: CommandAuditService,
    private readonly contractRead: ContractReadService,
  ) {}

  @Get(":tenantSlug/contract")
  @Command("contract.read")
  async getContract(@Req() req: ControlRequest, @Param("tenantSlug") tenantSlug: string) {
    const { principal } = requireControlContext(req);
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");

    const contract = await this.contractRead.readLatest(tenantSlug);

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "contract.read",
      actor: principal.subject,
      args: { tenantSlug, outcome: contract ? "served" : "no-contract-generated" },
    });

    if (!contract) {
      throw new NotFoundException({
        type: "https://webdesk.gaiada.online/errors/contract-not-generated",
        title: "No contract has been generated for this tenant",
        status: 404,
        detail:
          "WSK-15's codegen pipeline exists, but no successful run has produced artifacts for this " +
          "tenant yet. Run the pipeline (webdesk/api's `codegen:run` script, or the applySchema flow " +
          "once it triggers codegen) and retry.",
        instance: `/control/v1/tenants/${tenantSlug}/contract`,
      });
    }

    return contract;
  }
}
