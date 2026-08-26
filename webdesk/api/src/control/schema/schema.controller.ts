// See ../lifecycle/lifecycle.controller.ts's header — same loud warning applies to every route
// in this file (Zone B control-plane surface, dev-mode auth stub, not public-proxy-reachable
// until WSK-22).
import { Body, Controller, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { SchemaService } from "./schema.service";
import { ControlAuthGuard } from "../auth/control-auth.guard";
import { CommandAuthorizationGuard } from "../policy/command-authorization.guard";
import { Command } from "../command.decorator";
import { requireControlContext, type ControlRequest } from "../auth/control-request";
import { assertIdempotencyKey, assertNonEmptyString, assertUuid } from "../dto";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class SchemaController {
  constructor(private readonly schema: SchemaService) {}

  @Post(":tenantSlug/sites/:siteId/collections/:collectionKey/schema/propose")
  @Command("schema.propose")
  async propose(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string,
    @Body() body: { proposedSchema?: unknown },
  ) {
    const { principal } = requireControlContext(req);
    assertUuid(siteId, "siteId");
    assertNonEmptyString(collectionKey, "collectionKey", 200);
    return this.schema.proposeSchema({
      tenantSlug,
      siteId,
      collectionKey,
      proposedSchema: body?.proposedSchema,
      actor: principal.subject,
    });
  }

  @Post(":tenantSlug/sites/:siteId/collections/:collectionKey/schema/apply")
  @Command("schema.apply")
  async apply(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlug: string,
    @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKey: string,
    @Headers("idempotency-key") idempotencyKeyRaw: string | undefined,
    @Body() body: { schema?: unknown },
  ) {
    const { principal } = requireControlContext(req);
    assertUuid(siteId, "siteId");
    assertNonEmptyString(collectionKey, "collectionKey", 200);
    const idempotencyKey = assertIdempotencyKey(idempotencyKeyRaw);
    return this.schema.applySchema({
      tenantSlug,
      siteId,
      collectionKey,
      schema: body?.schema,
      actor: principal.subject,
      idempotencyKey,
    });
  }
}
