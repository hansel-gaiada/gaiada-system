// WSK-37 — the fan-out entry point. Whoever owns forms.service.ts wires ONE call here alongside
// its existing ZoneBEventEmitterService.emitFormReceived call (forms.service.ts step 9) — see
// this ticket's report for the exact hook line; forms/** and events/** are both out of this
// ticket's owned scope to edit directly, same posture WSK-12 itself already documented for its
// own emitter (events.module.ts's header).
//
// CROSS-TENANT ISOLATION, made structural rather than merely hoped for: `dispatchFormReceived`
// takes ONE `tenantId` and looks up ONLY that tenant's enabled webhooks
// (`findEnabledForKind`, which runs under `db.withTenant(tenantId, ...)` — RLS-scoped, plus an
// explicit `tenant_id = $1` predicate per the app-layer-scoping doctrine). There is no code path
// in this file that can read tenant B's webhook rows while dispatching tenant A's event — the
// tenant id is threaded through every query, never inferred from the payload.
import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { DbService } from "../db/db.service";
import { TenantWebhooksRepository } from "./tenant-webhooks.repository";
import { tenantWebhooksConfig } from "./tenant-webhooks.config";
import { redisConnectionOptions } from "../queue/redis-connection";
import type { TenantWebhookEnvelope, TenantWebhookFormReceivedData } from "./tenant-webhook-event.types";
import type { TenantWebhookJobData } from "./tenant-webhook-job";

@Injectable()
export class TenantWebhookDispatcherService {
  private readonly logger = new Logger(TenantWebhookDispatcherService.name);
  readonly queue: Queue<TenantWebhookJobData>;

  constructor(private readonly db: DbService, private readonly repo: TenantWebhooksRepository) {
    this.queue = new Queue<TenantWebhookJobData>(tenantWebhooksConfig.queueName, {
      connection: redisConnectionOptions() as never,
    });
  }

  /**
   * Fans a `form.received` event out to every ENABLED webhook this tenant has registered for it.
   * Fail-soft by construction (same doctrine as ZoneBEventEmitterService — "a downstream outage
   * must never break a form submission"): every per-webhook enqueue is individually try/caught so
   * one bad registration (or a Redis blip) cannot stop the others, and this method itself never
   * rejects, matching what forms.service.ts's step-9 caller already expects to `.catch()` around.
   *
   * `fields` is the tenant's OWN already-sanitized submitted-field map (never a raw DB row, never
   * another tenant's data — see tenant-webhook-event.types.ts's own header on what this
   * projection deliberately does and does not carry).
   */
  async dispatchFormReceived(
    tenantId: string,
    data: Omit<TenantWebhookFormReceivedData, "fields"> & { fields: Record<string, unknown> },
  ): Promise<void> {
    let webhooks;
    try {
      webhooks = await this.repo.findEnabledForKind(tenantId, "form.received");
    } catch (err) {
      this.logger.warn(`tenant webhook lookup failed for tenant ${tenantId}: ${String(err)}`);
      return;
    }
    if (webhooks.length === 0) return;

    for (const webhook of webhooks) {
      try {
        await this.enqueueOne(tenantId, webhook.id, "form.received", data);
      } catch (err) {
        this.logger.warn(`tenant webhook enqueue failed for webhook ${webhook.id}: ${String(err)}`);
      }
    }
  }

  private async enqueueOne(
    tenantId: string,
    webhookId: string,
    kind: "form.received",
    data: Record<string, unknown>,
  ): Promise<void> {
    const eventId = randomUUID();
    const envelope: TenantWebhookEnvelope = {
      eventId,
      kind,
      tenantId,
      occurredAt: new Date().toISOString(),
      data,
    };
    const envelopeJson = JSON.stringify(envelope);

    if (Buffer.byteLength(envelopeJson, "utf8") > tenantWebhooksConfig.maxPayloadBytes) {
      // Refuse to even enqueue an oversized payload — better a loud, immediate skip here than a
      // job the worker would refuse anyway after occupying a queue slot.
      this.logger.warn(
        `tenant webhook payload for webhook ${webhookId} exceeds ${tenantWebhooksConfig.maxPayloadBytes} bytes — not enqueued`,
      );
      return;
    }

    const delivery = await this.db.withTenant(tenantId, (db) =>
      db.transaction((client) => this.repo.insertDelivery(client, { tenantId, webhookId, eventId, kind })),
    );

    const jobData: TenantWebhookJobData = { deliveryId: delivery.id, webhookId, tenantId, eventId, envelopeJson };

    await this.queue.add("deliver", jobData, {
      jobId: delivery.id, // 1:1 with the delivery row, matching mail.service.ts's own BullMQ-level dedup
      attempts: tenantWebhooksConfig.maxAttempts,
      backoff: { type: "exponential", delay: tenantWebhooksConfig.backoffDelayMs },
      removeOnComplete: true,
      removeOnFail: false, // keep failed jobs inspectable — same reasoning as mail.service.ts
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
