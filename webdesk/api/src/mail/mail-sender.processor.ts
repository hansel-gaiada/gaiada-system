// WSK-11 — the BullMQ worker. Consumes jobs from the queue mail.service.ts writes to, re-checks
// suppression AUTHORITATIVELY immediately before send, resolves the From: identity fresh (never
// from job data — see identity.ts / mail-job.ts headers), calls the provider adapter, and writes
// the terminal mail_log status. Retry + exponential backoff is BullMQ's own job-options mechanism
// (mail.service.ts's `attempts`/`backoff` on `queue.add`); this file's only retry-adjacent logic
// is deciding WHEN a failure is terminal (attemptsMade >= attempts) versus still-retrying, so
// mail_log doesn't show 'failed' while a retry is still pending.
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import { DbService } from "../db/db.service";
import { MailLogRepository } from "./mail-log.repository";
import { SuppressionService } from "./suppression.service";
import { resolveFromIdentity } from "./identity";
import { createMailProvider } from "./provider";
import type { MailProviderAdapter } from "./provider/mail-provider";
import { mailConfig } from "./mail.config";
import { redisConnectionOptions } from "../queue/redis-connection";
import type { MailJobData } from "./mail-job";

@Injectable()
export class MailSenderProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailSenderProcessor.name);
  private readonly provider: MailProviderAdapter;
  private worker?: Worker<MailJobData>;

  constructor(
    private readonly db: DbService,
    private readonly mailLog: MailLogRepository,
    private readonly suppressions: SuppressionService,
  ) {
    this.provider = createMailProvider();
  }

  onModuleInit(): void {
    this.worker = new Worker<MailJobData>(
      mailConfig.queueName,
      (job) => this.process(job),
      { connection: redisConnectionOptions() as never, concurrency: 1 },
    );

    // Only mark mail_log 'failed' once BullMQ has exhausted every attempt — the 'failed' event
    // also fires after each individual failed attempt while retries remain, and marking the log
    // terminal at that point would misreport a mail that is still going to be retried.
    this.worker.on("failed", (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < maxAttempts) return; // still retrying — not terminal yet
      this.db
        .withTenant(job.data.tenantId, () =>
          this.mailLog.markFailed(job.data.mailLogId, String(err?.message ?? err ?? "unknown error")),
        )
        .catch((e) => this.logger.error(`failed to record terminal failure for ${job.data.mailLogId}`, e));
    });
  }

  private async process(job: Job<MailJobData>): Promise<void> {
    const data = job.data;
    await this.db.withTenant(data.tenantId, async () => {
      // Suppression check #2 of 2 — THE AUTHORITATIVE gate ("before every send"). A suppression
      // inserted after enqueue but before this job ran must still block delivery.
      const suppressed = await this.suppressions.isSuppressed(data.toEmail);
      if (suppressed) {
        await this.mailLog.markSuppressed(data.mailLogId);
        return; // terminal, and NOT a throw — a suppression is not a delivery failure, so BullMQ
        // must not retry it.
      }

      // THE ONLY source of a From: header, resolved fresh on every send — never from job data.
      const identity = resolveFromIdentity();

      const result = await this.provider.send({
        to: { email: data.toEmail, name: data.toName },
        from: { address: identity.fromAddress, name: identity.fromName },
        replyTo: data.replyTo,
        subject: data.subject,
        html: data.html,
        text: data.text,
      });
      await this.mailLog.markSent(data.mailLogId, result.providerMessageId);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
