// WSK-11 — mail_log writes. 0004_mail.sql's own header comment: "BullMQ worker updates
// status/sent_at/error/provider_message_id as delivery progresses, so (unlike
// audit_entries/content_versions) UPDATE stays granted. DELETE is clawed back" (`REVOKE DELETE ON
// mail_log FROM webdesk_app`). This repository is written to that contract exactly: it issues
// INSERT once per mail and UPDATE for status transitions, and it NEVER issues a DELETE against
// mail_log — proven negatively in test/mail-log-immutability.spec.ts (a raw DELETE as webdesk_app
// must fail at the grant level, independent of anything this file does or doesn't call).
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

export type MailLogStatus = "queued" | "sent" | "failed" | "suppressed";

export type MailLogEntry = {
  tenantId: string;
  siteId: string;
  templateId: string | null;
  toAddress: string;
  subject: string;
};

@Injectable()
export class MailLogRepository {
  constructor(private readonly db: DbService) {}

  async insertQueued(entry: MailLogEntry): Promise<string> {
    return this.insertWithStatus(entry, "queued");
  }

  async insertSuppressed(entry: MailLogEntry): Promise<string> {
    return this.insertWithStatus(entry, "suppressed");
  }

  private async insertWithStatus(entry: MailLogEntry, status: MailLogStatus): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO mail_log (tenant_id, site_id, template_id, to_address, subject, status)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [entry.tenantId, entry.siteId, entry.templateId, entry.toAddress, entry.subject, status],
    );
    return rows[0].id;
  }

  async markSent(id: string, providerMessageId?: string): Promise<void> {
    await this.db.query(
      `UPDATE mail_log SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1`,
      [id, providerMessageId ?? null],
    );
  }

  /** Only call once BullMQ has exhausted retries (mail-sender.processor.ts's 'failed' handler
   * checks attemptsMade >= attempts first) — calling this on every failed attempt would show
   * 'failed' in the log while a retry is still pending. */
  async markFailed(id: string, error: string): Promise<void> {
    await this.db.query(`UPDATE mail_log SET status = 'failed', error = $2 WHERE id = $1`, [id, error]);
  }

  async markSuppressed(id: string): Promise<void> {
    await this.db.query(`UPDATE mail_log SET status = 'suppressed' WHERE id = $1`, [id]);
  }

  async findById(id: string): Promise<{ id: string; status: MailLogStatus; error: string | null } | null> {
    const { rows } = await this.db.query<{ id: string; status: MailLogStatus; error: string | null }>(
      `SELECT id, status, error FROM mail_log WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }
}
