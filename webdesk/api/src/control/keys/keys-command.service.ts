// WSK-21 — the "keys" quarter of the C-05 command set. Per the ticket brief ("delegate to WSK-05's
// existing ApiKeysService, do not reimplement hashing"), every domain operation here IS
// `ApiKeysService.mint/rotate/revoke` — this file adds only the control-plane layer around it:
// idempotency-key wrapping (ApiKeysService's own methods are NOT idempotent — mint/rotate always
// produce a fresh row) and a `control.key.*` audit row alongside ApiKeysService's own
// `webdesk.apiKey.*` row (two rows per call is intentional, not a duplicate to fix — one is the
// domain-service's existing lower-level record, the other is this ticket's own command-level
// record with the ws4ApprovalId/idempotencyKey/impact-class context ApiKeysService has no
// parameter for).
import { Injectable, NotFoundException } from "@nestjs/common";
import { ApiKeysService, type ApiKeyScope } from "../../api-keys/api-keys.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandAuditService } from "../command-audit.service";
import { IdempotencyStore } from "../idempotency/idempotency-store";

@Injectable()
export class KeysCommandService {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly tenants: TenantLookupService,
    private readonly commandAudit: CommandAuditService,
    private readonly idempotency: IdempotencyStore,
    private readonly auditHash: AuditService,
  ) {}

  private async resolveActiveTenant(slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    return tenant;
  }

  async mint(input: { tenantSlug: string; envId: string; scope: ApiKeyScope; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, envId: input.envId, scope: input.scope };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:key.mint:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, () =>
      this.apiKeys.mint(tenant.id, input.envId, input.scope, input.actor),
    );

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "key.mint",
      actor: input.actor,
      args: { ...args, apiKeyId: result.id },
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { ...result, replayed };
  }

  async rotate(input: { tenantSlug: string; apiKeyId: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, apiKeyId: input.apiKeyId };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:key.rotate:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, () =>
      this.apiKeys.rotate(tenant.id, input.apiKeyId, input.actor),
    );

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "key.rotate",
      actor: input.actor,
      args,
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { ...result, replayed };
  }

  async revoke(input: { tenantSlug: string; apiKeyId: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, apiKeyId: input.apiKeyId };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:key.revoke:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, () =>
      this.apiKeys.revoke(tenant.id, input.apiKeyId, input.actor),
    );

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: "key.revoke",
      actor: input.actor,
      args,
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { ...result, replayed };
  }
}
