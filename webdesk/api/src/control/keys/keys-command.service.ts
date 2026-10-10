// WSK-21 — the "keys" quarter of the C-05 command set. Per the ticket brief ("delegate to WSK-05's
// existing ApiKeysService, do not reimplement hashing"), every domain operation here IS
// `ApiKeysService.mintInTx/rotateInTx/revokeInTx` (the same code mint/rotate/revoke run) — this file
// adds only the control-plane layer around it: the command envelope and a `control.key.*` audit row
// alongside ApiKeysService's own `webdesk.apiKey.*` row (two rows per call is intentional, not a
// duplicate to fix — one is the domain-service's existing lower-level record, the other is this
// ticket's own command-level record with the ws4ApprovalId context ApiKeysService has no parameter
// for).
//
// M3 T5a — all three are HIGH, and run in the shared command envelope (../command-envelope.ts):
// the `control.key.*` audit row (which CLAIMS the WS4 approval) is the first statement of ONE
// transaction, ApiKeysService's write runs on that same transaction, and the durable replay record
// is stored in it too. mint/rotate's stored response holds the plaintext key, so it is sealed
// (../idempotency/response-seal.ts). Nothing runs after commit.
import { Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ApiKeysService, type ApiKeyScope } from "../../api-keys/api-keys.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandEnvelope } from "../command-envelope";
import { sealedResponse } from "../idempotency/response-seal";

type MintedKey = Awaited<ReturnType<ApiKeysService["mint"]>>;
type RevokedKey = Awaited<ReturnType<ApiKeysService["revoke"]>>;

@Injectable()
export class KeysCommandService {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly tenants: TenantLookupService,
    private readonly envelope: CommandEnvelope,
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
    // The key's id is fixed up front: the audit row is written before the key exists.
    const apiKeyId = randomUUID();

    return this.envelope.run<MintedKey>({
      command: "key.mint",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:key.mint:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: { ...args, apiKeyId },
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => ({
        result: await this.apiKeys.mintInTx(client, { tenantId: tenant.id, envId: input.envId, scope: input.scope, actor: input.actor, id: apiKeyId }),
      }),
      seal: sealedResponse<MintedKey>(),
    });
  }

  async rotate(input: { tenantSlug: string; apiKeyId: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, apiKeyId: input.apiKeyId };

    return this.envelope.run<MintedKey>({
      command: "key.rotate",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:key.rotate:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: args,
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => ({ result: await this.apiKeys.rotateInTx(client, tenant.id, input.apiKeyId, input.actor) }),
      seal: sealedResponse<MintedKey>(),
    });
  }

  async revoke(input: { tenantSlug: string; apiKeyId: string; actor: string; idempotencyKey: string; ws4ApprovalId: string | null }) {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const args = { tenantSlug: input.tenantSlug, apiKeyId: input.apiKeyId };

    return this.envelope.run<RevokedKey>({
      command: "key.revoke",
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:key.revoke:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: args,
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async (client) => ({ result: await this.apiKeys.revokeInTx(client, tenant.id, input.apiKeyId, input.actor) }),
    });
  }
}
