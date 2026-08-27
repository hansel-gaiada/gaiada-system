// WSK-32 — see schema-draft-auth.guard.ts's header for why this route sits at the SAME
// `control/v1/tenants/...` path prefix as ../control/schema/schema.controller.ts (Caddy already
// 404s `/control/*` publicly) while living in a SEPARATE Nest module with its own guard, rather
// than being added to `ControlModule`/`SchemaController` directly.
import { Body, Controller, Param, Post, Req, UseGuards } from "@nestjs/common";
import { SchemaDraftService } from "./schema-draft.service";
// WSK-32 (coordinator edit) — gated by the REAL control channel (synccert mTLS +
// offline-JWKS-verified Keycloak client-credentials + scope check) in every environment except
// NODE_ENV=test, where ControlModule binds the dev-mode stub so WSK-21's existing suites keep
// their header contract. The actor written to the audit row is now the AUTHENTICATED subject,
// not a caller-supplied header value.
import { ControlAuthGuard } from "../control/auth/control-auth.guard";
// WSK-33 FIX — authentication alone was not enough. ControlAuthGuard proves WHO the caller is;
// CommandAuthorizationGuard is the §03 Layer-3 check that proves the caller holds the command's
// required scope. Without the @Command metadata below, that guard is structurally absent from the
// chain no matter that it is listed here, because it resolves the command name via Reflector.
import { CommandAuthorizationGuard } from "../control/policy/command-authorization.guard";
import { Command } from "../control/command.decorator";
import { requireControlContext, type ControlRequest } from "../control/auth/control-request";
import { assertUuid, assertTenantSlug, assertNonEmptyString } from "./dto";

@Controller("control/v1/tenants")
@UseGuards(ControlAuthGuard, CommandAuthorizationGuard)
export class SchemaDraftController {
  constructor(private readonly schemaDraft: SchemaDraftService) {}

  @Command("schema.aiDraft")
  @Post(":tenantSlug/sites/:siteId/collections/:collectionKey/schema/ai-draft")
  async aiDraft(
    @Req() req: ControlRequest,
    @Param("tenantSlug") tenantSlugRaw: string,
    @Param("siteId") siteId: string,
    @Param("collectionKey") collectionKeyRaw: string,
    @Body() body: { prd?: string },
  ) {
    const tenantSlug = assertTenantSlug(tenantSlugRaw);
    assertUuid(siteId, "siteId");
    const collectionKey = assertNonEmptyString(collectionKeyRaw, "collectionKey", 200);
    const prd = assertNonEmptyString(body?.prd, "prd");
    // Never `?? "unknown"`: an unattributable audit row is worse than a refused request, and
    // requireControlContext throws rather than inventing a principal.
    const actor = requireControlContext(req).principal.subject;

    return this.schemaDraft.draftFromPrd({ tenantSlug, siteId, collectionKey, prd, actor });
  }
}
