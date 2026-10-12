// See ../lifecycle/lifecycle.controller.ts's header: the same warning applies (Zone B control plane, not
// reachable through the public proxy vhost).
//
// M6-P4r-b -- the re-run / backfill command for the live contract codegen. See
// contract-regenerate.service.ts for what it does and when to use it.
import { Controller, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { assertIdempotencyKey, assertNonEmptyString } from "../dto";
import { ContractRegenerateService } from "./contract-regenerate.service";

@Controller("control/v1")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class ContractRegenerateController {
  constructor(private readonly regenerate: ContractRegenerateService) {}

  @Post("tenants/:tenantSlug/contract/regenerate")
  @Command("contract.regenerate")
  async one(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
  ) {
    const { principal } = requireControlContext(req);
    assertNonEmptyString(tenantSlug, "tenantSlug", 200);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.regenerate.regenerate({ tenantSlug, actor: principal.subject, idempotencyKey });
  }

  @Post("contract/regenerate")
  @Command("contract.regenerate")
  async all(@Req() req: ControlRequest, @Headers("idempotency-key") idempotencyKeyRaw: string | undefined) {
    const { principal } = requireControlContext(req);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.regenerate.regenerate({ actor: principal.subject, idempotencyKey });
  }
}
