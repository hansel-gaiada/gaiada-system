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
//
// M6-P4j (WSK-D81) -- `GET .../contract/:contractVersion/artifacts/:artifact`: the artifact BYTES, over this same
// control channel. The presigned URLs in `getContract`'s body name this estate's internal object store, which the
// ERP (a separate daemon, airlocked) can neither reach nor should; so the bytes cross only here. It is the same
// read capability as `getContract` (`contract.read`: same scope, same guards, same audit command), not a new command.
import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { CommandAuditService } from "../command-audit.service";
import {
  ContractArtifactTooLargeError,
  CONTRACT_ARTIFACT_NAMES,
  ContractReadService,
  isContractArtifactName,
} from "../../codegen/contract-read.service";

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

  @Get(":tenantSlug/contract/:contractVersion/artifacts/:artifact")
  @Command("contract.read")
  async getContractArtifact(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("contractVersion") contractVersion: string,
    @Param("artifact") artifact: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { principal } = requireControlContext(req);
    const instance = `/control/v1/tenants/${tenantSlug}/contract/${contractVersion}/artifacts/${artifact}`;
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");

    if (!isContractArtifactName(artifact)) {
      throw new BadRequestException({
        type: "https://webdesk.gaiada.online/errors/unknown-contract-artifact",
        title: "Unknown contract artifact",
        status: 400,
        detail: `artifact must be one of: ${CONTRACT_ARTIFACT_NAMES.join(", ")}`,
        instance,
      });
    }

    let served: Awaited<ReturnType<ContractReadService["readArtifact"]>>;
    try {
      served = await this.contractRead.readArtifact(tenantSlug, contractVersion, artifact);
    } catch (err) {
      if (!(err instanceof ContractArtifactTooLargeError)) throw err;
      await this.audit(tenant.id, principal.subject, tenantSlug, contractVersion, artifact, "too-large");
      throw new InternalServerErrorException({
        type: "https://webdesk.gaiada.online/errors/contract-artifact-too-large",
        title: "Contract artifact exceeds the control-channel size cap",
        status: 500,
        detail: err.message,
        instance,
      });
    }

    await this.audit(tenant.id, principal.subject, tenantSlug, contractVersion, artifact, served ? "served" : "not-found");
    if (!served) {
      throw new NotFoundException({
        type: "https://webdesk.gaiada.online/errors/contract-artifact-not-found",
        title: "No such contract artifact",
        status: 404,
        detail: `tenant '${tenantSlug}' has no '${artifact}' artifact for contract version '${contractVersion}'`,
        instance,
      });
    }

    reply.header("content-type", served.contentType);
    reply.header("content-length", String(served.body.length));
    return served.body;
  }

  private audit(tenantId: string, actor: string, tenantSlug: string, contractVersion: string, artifact: string, outcome: string) {
    return this.commandAudit.recordTenant({
      tenantId,
      command: "contract.read",
      actor,
      args: { tenantSlug, contractVersion, artifact, outcome },
    });
  }
}
