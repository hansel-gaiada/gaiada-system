// WSK-37 — registration lifecycle (register / rotate secret / enable-disable / list / delivery
// log), same shape as ../api-keys/api-keys.service.ts: every write goes through
// `db.withTenant(...)` + a transaction, and every mutating call writes an `audit_entries` row
// (design §11: "every command"). The plaintext secret exists in memory for exactly the duration
// of a register/rotate call and is returned to the caller ONCE — nothing in this file logs it.
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AuditService } from "../audit/audit.service";
import { TenantWebhooksRepository, type TenantWebhookDeliveryRow, type TenantWebhookRow } from "./tenant-webhooks.repository";
import { generateWebhookSecret, encryptWebhookSecret } from "./webhook-secret";
import { checkSsrfSafe } from "./ssrf-guard";
import type { TenantWebhookEventKind } from "./tenant-webhook-event.types";

export type RegisteredWebhook = {
  id: string;
  tenantId: string;
  targetUrl: string;
  secret: string; // plaintext — present ONLY on the object THIS call returns, never again
  enabled: boolean;
  eventKinds: TenantWebhookEventKind[];
  description: string | null;
  createdAt: string;
};

export type PublicWebhook = Omit<TenantWebhookRow, "secret_ciphertext" | "tenant_id"> & { tenantId: string };

function toPublic(row: TenantWebhookRow): PublicWebhook {
  const { secret_ciphertext: _secret, tenant_id, ...rest } = row;
  return { ...rest, tenantId: tenant_id };
}

@Injectable()
export class TenantWebhooksService {
  constructor(private readonly db: DbService, private readonly repo: TenantWebhooksRepository, private readonly audit: AuditService) {}

  async register(
    tenantId: string,
    input: { targetUrl: string; eventKinds: TenantWebhookEventKind[]; description: string | null },
  ): Promise<RegisteredWebhook> {
    // Fail fast at registration time too — this is NOT a substitute for the dispatch-time check
    // (ssrf-guard.ts's own header: DNS is not a fact you get to check once, a rebind can still
    // happen between now and the first delivery), but there is no reason to accept and store a
    // target that is ALREADY, right now, an obviously private/internal address — better a loud
    // 400 here than a registration that can only ever fail at delivery time.
    const ssrf = await checkSsrfSafe(input.targetUrl);
    if (!ssrf.ok) {
      throw new BadRequestException(`targetUrl refused: ${ssrf.reason}`);
    }

    const plaintext = generateWebhookSecret();
    const secretCiphertext = encryptWebhookSecret(plaintext);

    return this.db.withTenant(tenantId, (db) =>
      db.transaction(async (client) => {
        const row = await this.repo.insert(client, {
          tenantId,
          targetUrl: input.targetUrl,
          secretCiphertext,
          eventKinds: input.eventKinds,
          description: input.description,
        });
        await this.audit.record(client, {
          tenantId,
          actor: "control-plane",
          action: "webdesk.tenantWebhook.register",
          args: { webhookId: row.id, eventKinds: input.eventKinds.join(",") },
        });
        return {
          id: row.id,
          tenantId: row.tenant_id,
          targetUrl: row.target_url,
          secret: plaintext,
          enabled: row.enabled,
          eventKinds: row.event_kinds,
          description: row.description,
          createdAt: row.created_at,
        };
      }),
    );
  }

  async list(tenantId: string): Promise<PublicWebhook[]> {
    const rows = await this.repo.listByTenant(tenantId);
    return rows.map(toPublic);
  }

  async rotateSecret(tenantId: string, webhookId: string): Promise<RegisteredWebhook> {
    const plaintext = generateWebhookSecret();
    const secretCiphertext = encryptWebhookSecret(plaintext);

    return this.db.withTenant(tenantId, (db) =>
      db.transaction(async (client) => {
        const row = await this.repo.rotateSecret(client, tenantId, webhookId, secretCiphertext);
        if (!row) throw new NotFoundException("webhook not found for this tenant");
        await this.audit.record(client, {
          tenantId,
          actor: "control-plane",
          action: "webdesk.tenantWebhook.rotateSecret",
          args: { webhookId },
        });
        return {
          id: row.id,
          tenantId: row.tenant_id,
          targetUrl: row.target_url,
          secret: plaintext,
          enabled: row.enabled,
          eventKinds: row.event_kinds,
          description: row.description,
          createdAt: row.created_at,
        };
      }),
    );
  }

  async setEnabled(tenantId: string, webhookId: string, enabled: boolean): Promise<PublicWebhook> {
    return this.db.withTenant(tenantId, (db) =>
      db.transaction(async (client) => {
        const row = await this.repo.setEnabled(client, tenantId, webhookId, enabled);
        if (!row) throw new NotFoundException("webhook not found for this tenant");
        await this.audit.record(client, {
          tenantId,
          actor: "control-plane",
          action: enabled ? "webdesk.tenantWebhook.enable" : "webdesk.tenantWebhook.disable",
          args: { webhookId },
        });
        return toPublic(row);
      }),
    );
  }

  async listDeliveries(tenantId: string, webhookId: string): Promise<TenantWebhookDeliveryRow[]> {
    const webhook = await this.repo.findById(tenantId, webhookId);
    if (!webhook) throw new NotFoundException("webhook not found for this tenant");
    return this.repo.listDeliveries(tenantId, webhookId);
  }
}
