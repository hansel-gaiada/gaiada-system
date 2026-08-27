// WSK-37 — DB access for tenant_webhooks / tenant_webhook_deliveries. Every method takes an
// already tenant-scoped `DbService`/`PoolClient` (via `db.withTenant(...)`, same discipline as
// ../api-keys/api-keys.service.ts) — RLS is the authoritative isolation, but every query below
// still carries an explicit `tenant_id = $N` predicate per the app-layer-scoping doctrine
// (WSK-D16/§12): a GUC gap must degrade to a wrong app-layer filter, not a silent cross-tenant
// read.
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import type { TenantWebhookEventKind } from "./tenant-webhook-event.types";

export type TenantWebhookRow = {
  id: string;
  tenant_id: string;
  target_url: string;
  secret_ciphertext: string;
  enabled: boolean;
  event_kinds: TenantWebhookEventKind[];
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type TenantWebhookDeliveryRow = {
  id: string;
  tenant_id: string;
  webhook_id: string;
  event_id: string;
  kind: string;
  status: "pending" | "sent" | "failed";
  attempt_count: number;
  response_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
};

@Injectable()
export class TenantWebhooksRepository {
  constructor(private readonly db: DbService) {}

  async insert(
    client: PoolClient,
    input: {
      tenantId: string;
      targetUrl: string;
      secretCiphertext: string;
      eventKinds: TenantWebhookEventKind[];
      description: string | null;
    },
  ): Promise<TenantWebhookRow> {
    const { rows } = await client.query<TenantWebhookRow>(
      `INSERT INTO tenant_webhooks (tenant_id, target_url, secret_ciphertext, event_kinds, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.tenantId, input.targetUrl, input.secretCiphertext, input.eventKinds, input.description],
    );
    return rows[0];
  }

  async listByTenant(tenantId: string): Promise<TenantWebhookRow[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<TenantWebhookRow>(
        `SELECT * FROM tenant_webhooks WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId],
      );
      return rows;
    });
  }

  async findById(tenantId: string, webhookId: string): Promise<TenantWebhookRow | null> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<TenantWebhookRow>(
        `SELECT * FROM tenant_webhooks WHERE id = $1 AND tenant_id = $2`,
        [webhookId, tenantId],
      );
      return rows[0] ?? null;
    });
  }

  /** Every ENABLED webhook for a tenant subscribed to `kind` — the dispatcher's fan-out set. */
  async findEnabledForKind(tenantId: string, kind: TenantWebhookEventKind): Promise<TenantWebhookRow[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<TenantWebhookRow>(
        `SELECT * FROM tenant_webhooks
          WHERE tenant_id = $1 AND enabled = true AND $2 = ANY(event_kinds)`,
        [tenantId, kind],
      );
      return rows;
    });
  }

  async setEnabled(client: PoolClient, tenantId: string, webhookId: string, enabled: boolean): Promise<TenantWebhookRow | null> {
    const { rows } = await client.query<TenantWebhookRow>(
      `UPDATE tenant_webhooks SET enabled = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [enabled, webhookId, tenantId],
    );
    return rows[0] ?? null;
  }

  async rotateSecret(client: PoolClient, tenantId: string, webhookId: string, secretCiphertext: string): Promise<TenantWebhookRow | null> {
    const { rows } = await client.query<TenantWebhookRow>(
      `UPDATE tenant_webhooks SET secret_ciphertext = $1, updated_at = now()
        WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [secretCiphertext, webhookId, tenantId],
    );
    return rows[0] ?? null;
  }

  async insertDelivery(
    client: PoolClient,
    input: { tenantId: string; webhookId: string; eventId: string; kind: string },
  ): Promise<TenantWebhookDeliveryRow> {
    const { rows } = await client.query<TenantWebhookDeliveryRow>(
      `INSERT INTO tenant_webhook_deliveries (tenant_id, webhook_id, event_id, kind)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.tenantId, input.webhookId, input.eventId, input.kind],
    );
    return rows[0];
  }

  async markDeliveryOutcome(
    tenantId: string,
    deliveryId: string,
    outcome: { status: "sent" | "failed"; attemptCount: number; responseStatus: number | null; lastError: string | null },
  ): Promise<void> {
    await this.db.withTenant(tenantId, (db) =>
      db.query(
        `UPDATE tenant_webhook_deliveries
            SET status = $1, attempt_count = $2, response_status = $3, last_error = $4,
                delivered_at = CASE WHEN $1 = 'sent' THEN now() ELSE delivered_at END
          WHERE id = $5 AND tenant_id = $6`,
        [outcome.status, outcome.attemptCount, outcome.responseStatus, outcome.lastError, deliveryId, tenantId],
      ),
    );
  }

  async bumpAttempt(tenantId: string, deliveryId: string, attemptCount: number): Promise<void> {
    await this.db.withTenant(tenantId, (db) =>
      db.query(`UPDATE tenant_webhook_deliveries SET attempt_count = $1 WHERE id = $2 AND tenant_id = $3`, [
        attemptCount,
        deliveryId,
        tenantId,
      ]),
    );
  }

  async listDeliveries(tenantId: string, webhookId: string, limit = 50): Promise<TenantWebhookDeliveryRow[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<TenantWebhookDeliveryRow>(
        `SELECT * FROM tenant_webhook_deliveries
          WHERE tenant_id = $1 AND webhook_id = $2
          ORDER BY created_at DESC LIMIT $3`,
        [tenantId, webhookId, limit],
      );
      return rows;
    });
  }

  async findDeliveryById(tenantId: string, deliveryId: string): Promise<TenantWebhookDeliveryRow | null> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<TenantWebhookDeliveryRow>(
        `SELECT * FROM tenant_webhook_deliveries WHERE id = $1 AND tenant_id = $2`,
        [deliveryId, tenantId],
      );
      return rows[0] ?? null;
    });
  }
}
