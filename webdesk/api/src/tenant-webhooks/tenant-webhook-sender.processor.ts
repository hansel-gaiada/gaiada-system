// WSK-37 — the BullMQ worker that actually opens the outbound connection. This is where every
// egress control the ticket demands is enforced, ON EVERY ATTEMPT (not once at registration):
//   - SSRF guard (ssrf-guard.ts) on the target URL AND on every redirect hop
//   - HTTPS-only (enforced again here, defence in depth beyond the DTO/DB CHECK)
//   - a capped number of redirects, each independently re-validated
//   - a per-attempt timeout (AbortController)
//   - a payload-size cap (also enforced at enqueue time — see the dispatcher — but re-checked
//     here too, since this is the file that actually writes bytes to a socket)
//   - HMAC-SHA256 signing with the SAME algorithm WSK-12's Zone A bridge uses
//     (zoneb-event-signature.ts, reused verbatim, per the ticket's own instruction not to write a
//     second signer), but with THIS tenant's own webhook secret rather than WEBDESK_EVENT_SECRET.
// Retry + exponential backoff is BullMQ's own job-options mechanism (the dispatcher's
// `attempts`/`backoff` on `queue.add`) — same division of responsibility as
// mail-sender.processor.ts's own header describes for the mail queue.
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { computeSignatureHex, formatSignatureHeader } from "../events/zoneb-event-signature";
import { checkSsrfSafe } from "./ssrf-guard";
import { decryptWebhookSecret } from "./webhook-secret";
import { tenantWebhooksConfig } from "./tenant-webhooks.config";
import { redisConnectionOptions } from "../queue/redis-connection";
import { TenantWebhooksRepository } from "./tenant-webhooks.repository";
import type { TenantWebhookJobData } from "./tenant-webhook-job";

export type DeliveryOutcome =
  | { delivered: true; responseStatus: number }
  | { delivered: false; reason: string; responseStatus: number | null };

/**
 * Performs ONE HTTP delivery attempt, following redirects manually so each hop gets its own SSRF
 * check — `fetch`'s built-in redirect-follow would connect to the `Location` target BEFORE this
 * code ever sees it, which is exactly the gap that lets a same-origin-looking URL 302 into a
 * private address after the original target passed validation. Exported standalone (not a private
 * method) so it is unit-testable without BullMQ or a database — see test/tenant-webhooks-ssrf.spec.ts.
 */
export async function attemptDelivery(
  targetUrl: string,
  secret: string,
  envelopeJson: string,
): Promise<DeliveryOutcome> {
  let currentUrl = targetUrl;

  for (let hop = 0; hop <= tenantWebhooksConfig.maxRedirects; hop++) {
    const check = await checkSsrfSafe(currentUrl);
    if (!check.ok) {
      return { delivered: false, reason: `refused target: ${check.reason}`, responseStatus: null };
    }

    if (Buffer.byteLength(envelopeJson, "utf8") > tenantWebhooksConfig.maxPayloadBytes) {
      return { delivered: false, reason: "payload exceeds size cap", responseStatus: null };
    }

    const timestampMs = Date.now().toString();
    const signatureHex = computeSignatureHex(secret, timestampMs, envelopeJson);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tenantWebhooksConfig.requestTimeoutMs);
    try {
      const res = await fetch(currentUrl, {
        method: "POST",
        redirect: "manual", // THE point — see this function's own header.
        headers: {
          "Content-Type": "application/json",
          "X-Webdesk-Timestamp": timestampMs,
          "X-Webdesk-Signature": formatSignatureHeader(signatureHex),
        },
        body: envelopeJson,
        signal: controller.signal,
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          return { delivered: false, reason: `redirect (${res.status}) with no Location header`, responseStatus: res.status };
        }
        if (hop === tenantWebhooksConfig.maxRedirects) {
          return { delivered: false, reason: "too many redirects", responseStatus: res.status };
        }
        // Resolve a relative Location against the current URL, then loop — the NEXT iteration's
        // checkSsrfSafe() call validates this new target before anything connects to it.
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        return { delivered: true, responseStatus: res.status };
      }
      return { delivered: false, reason: `endpoint returned HTTP ${res.status}`, responseStatus: res.status };
    } catch (err) {
      const reason = controller.signal.aborted ? "request timed out" : String(err);
      return { delivered: false, reason, responseStatus: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  // Unreachable in practice (the loop always returns), but keeps the return type total.
  return { delivered: false, reason: "too many redirects", responseStatus: null };
}

@Injectable()
export class TenantWebhookSenderProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TenantWebhookSenderProcessor.name);
  private worker?: Worker<TenantWebhookJobData>;

  constructor(private readonly repo: TenantWebhooksRepository) {}

  onModuleInit(): void {
    this.worker = new Worker<TenantWebhookJobData>(
      tenantWebhooksConfig.queueName,
      (job) => this.process(job),
      { connection: redisConnectionOptions() as never, concurrency: 4 },
    );

    // Same "only mark terminal once BullMQ has exhausted every attempt" rule as
    // mail-sender.processor.ts's own `failed` handler — a mid-retry failure is not the final word.
    this.worker.on("failed", (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < maxAttempts) return;
      this.repo
        .markDeliveryOutcome(job.data.tenantId, job.data.deliveryId, {
          status: "failed",
          attemptCount: job.attemptsMade,
          responseStatus: null,
          lastError: String(err?.message ?? err ?? "unknown error"),
        })
        .catch((e) => this.logger.error(`failed to record terminal failure for ${job.data.deliveryId}`, e));
    });
  }

  private async process(job: Job<TenantWebhookJobData>): Promise<void> {
    const { tenantId, webhookId, deliveryId, envelopeJson } = job.data;

    const webhook = await this.repo.findById(tenantId, webhookId);
    if (!webhook || !webhook.enabled) {
      // Disabled/deleted between enqueue and processing — terminal, not a retryable failure.
      await this.repo.markDeliveryOutcome(tenantId, deliveryId, {
        status: "failed",
        attemptCount: job.attemptsMade,
        responseStatus: null,
        lastError: "webhook disabled or removed before delivery",
      });
      return;
    }

    const secret = decryptWebhookSecret(webhook.secret_ciphertext);
    const outcome = await attemptDelivery(webhook.target_url, secret, envelopeJson);

    if (outcome.delivered) {
      await this.repo.markDeliveryOutcome(tenantId, deliveryId, {
        status: "sent",
        attemptCount: job.attemptsMade + 1,
        responseStatus: outcome.responseStatus,
        lastError: null,
      });
      return;
    }

    // Not delivered on this attempt. Record the running attempt count so a client-facing delivery
    // log reflects reality even while retries are still pending, then re-throw so BullMQ applies
    // its own retry/backoff — the `failed` handler above is what marks it terminally 'failed'.
    await this.repo.bumpAttempt(tenantId, deliveryId, job.attemptsMade + 1).catch(() => {});
    throw new Error(outcome.reason);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
