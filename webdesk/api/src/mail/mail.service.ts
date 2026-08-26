// WSK-11 — the mail service's public entry point. Every flow (notification, autoresponder, and
// any future caller) goes through `enqueueRendered` via the two named wrappers below — there is
// no lower-level "send arbitrary mail" method exposed, and NEITHER wrapper accepts a `from` or
// domain override (THE IDENTITY RULE — identity.ts). replyTo is derived internally by
// sendNotification, never accepted as an open parameter from a caller for sendAutoresponder.
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { DbService } from "../db/db.service";
import { MailTemplatesService } from "./mail-templates.service";
import { SuppressionService } from "./suppression.service";
import { MailLogRepository } from "./mail-log.repository";
import { renderTemplate, stripTags } from "./template-renderer";
import { assertNotZoneADomain, resolveFromIdentity } from "./identity";
import { mailConfig } from "./mail.config";
import { redisConnectionOptions } from "../queue/redis-connection";
import type { MailJobData } from "./mail-job";

export type SendTemplateInput = {
  tenantId: string;
  siteId: string;
  templateKey: string;
  to: { email: string; name?: string };
  variables?: Record<string, string>;
};

export type EnqueueResult = { mailLogId: string; status: "queued" | "suppressed" };

@Injectable()
export class MailService implements OnModuleDestroy {
  readonly queue: Queue<MailJobData>;

  constructor(
    private readonly db: DbService,
    private readonly templates: MailTemplatesService,
    private readonly suppressions: SuppressionService,
    private readonly mailLog: MailLogRepository,
  ) {
    this.queue = new Queue<MailJobData>(mailConfig.queueName, { connection: redisConnectionOptions() as never });
  }

  private async enqueueRendered(
    input: SendTemplateInput & { replyTo?: { email: string; name?: string } },
  ): Promise<EnqueueResult> {
    return this.db.withTenant(input.tenantId, async (db) => {
      const template = await this.templates.requireBySiteAndKey(input.siteId, input.templateKey);
      const variables = input.variables ?? {};
      const subject = renderTemplate(template.subject, variables, { escapeHtml: false }).replace(/[\r\n]/g, " ");
      const html = renderTemplate(template.body_html, variables, { escapeHtml: true });
      const text = renderTemplate(template.body_text ?? stripTags(template.body_html), variables, {
        escapeHtml: false,
      });

      // Fail-fast config check (defence-in-depth #1 — see identity.ts). The AUTHORITATIVE check
      // is the processor's own resolveFromIdentity() call at send time; this one just means a
      // misconfigured MAIL_FROM_ADDRESS is caught immediately rather than after a queue round trip.
      resolveFromIdentity();
      if (input.replyTo) assertNotZoneADomain(input.replyTo.email);

      // Suppression check #1 of 2 (ticket brief: "before every send"). This is the fast-fail —
      // it stops a suppressed address from ever occupying a queue slot at all. The AUTHORITATIVE,
      // second check runs immediately before the provider.send() call in
      // mail-sender.processor.ts, so a suppression added between enqueue and processing still
      // blocks delivery.
      const suppressed = await this.suppressions.isSuppressed(input.to.email);
      if (suppressed) {
        const mailLogId = await this.mailLog.insertSuppressed({
          tenantId: input.tenantId,
          siteId: input.siteId,
          templateId: template.id,
          toAddress: input.to.email,
          subject,
        });
        return { mailLogId, status: "suppressed" as const };
      }

      const mailLogId = await this.mailLog.insertQueued({
        tenantId: input.tenantId,
        siteId: input.siteId,
        templateId: template.id,
        toAddress: input.to.email,
        subject,
      });

      const jobData: MailJobData = {
        mailLogId,
        tenantId: input.tenantId,
        toEmail: input.to.email,
        toName: input.to.name,
        subject,
        html,
        text,
        replyTo: input.replyTo,
      };

      await this.queue.add("send", jobData, {
        jobId: mailLogId, // 1:1 with the mail_log row by construction — BullMQ-level de-dup
        attempts: mailConfig.maxAttempts,
        backoff: { type: "exponential", delay: mailConfig.backoffDelayMs },
        removeOnComplete: true,
        removeOnFail: false, // keep failed jobs inspectable (retry/backoff proof + ops triage)
      });

      return { mailLogId, status: "queued" as const };
    });
  }

  /**
   * Staff notification about a new submission. From: ours, Reply-To: the human submitter — the
   * D14 pattern verbatim ("From: is ours, Reply-To: is the human"). `submitter` is NOT a free
   * `replyTo` parameter open to any value — it is named for what it is, and still passes through
   * assertNotZoneADomain like every replyTo does.
   */
  async sendNotification(
    input: SendTemplateInput & { submitter: { email: string; name?: string } },
  ): Promise<EnqueueResult> {
    const { submitter, ...rest } = input;
    return this.enqueueRendered({ ...rest, replyTo: submitter });
  }

  /**
   * Confirmation sent TO the submitter. No Reply-To — Zone B hosts no inbound mailbox for it
   * (the Zone A mail doctrine's M13 inbound-reply mechanism is a Zone A construct only; out of
   * this ticket's scope and out of Zone B's mandate per D14/M6 — "Zone A mail does NOT route
   * through Zone B C-03" cuts both ways: Zone B does not borrow Zone A's inbound machinery either).
   */
  async sendAutoresponder(input: SendTemplateInput): Promise<EnqueueResult> {
    return this.enqueueRendered(input);
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
