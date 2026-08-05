// MAIL-04 — the internal enqueue API. This is the ONLY way a row lands in `mail_log`; there is no
// "send arbitrary mail" HTTP endpoint at any privilege (design §6.1). MAIL-05 (a separate ticket)
// wires the `notify()` tap on top of this; this ticket only builds and tests the primitive itself.
import { randomBytes } from "node:crypto";
import { config } from "../config";
import { newId, withMailContext } from "../db";
import { stripHeaderInjection, isPlausibleEmail } from "./sanitize";
import { isSuppressed } from "./suppressions";
import { renderTemplate } from "./templates";
import { recordEnqueued, recordSuppressed } from "./metrics";
import type { MailStream } from "./types";

export interface EnqueueMailInput {
  stream: MailStream;
  templateKey: string;
  payload?: Record<string, unknown>;
  toEmail: string;
  tenantId?: string | null; // NULL for auth mail (design §6.1/F2 — auth mail has no tenant)
  userId?: string | null;
  notificationIds?: string[]; // the notifications rows this mail carries (A5 audit trail)
  entityType?: string | null;
  entityId?: string | null;
  /** true => mint a fresh 128-bit CSPRNG base64url `reply_token` (VERP inbound correlation,
   *  §7.6). Omit/false for mail with no reply capability (e.g. auth mail — replies to a magic
   *  link make no sense). */
  withReplyToken?: boolean;
}

export type EnqueueMailResult =
  | { skipped: true; reason: "disabled" }
  | { skipped: false; id: string; status: "queued" | "suppressed" };

function newReplyToken(): string {
  return randomBytes(16).toString("base64url"); // 128 bits, matches the DDL column comment
}

/** Writes exactly one `mail_log` row (or none, per the two documented no-op paths below).
 *
 *  1. `MAIL_ENABLED=0` (the master gate, §7.8) — returns `{skipped:true}` without touching the
 *     database at all. This is what makes "zero side effects when disabled" true in the literal
 *     sense, not just "nothing gets sent": no row, no suppression lookup, no query.
 *  2. The recipient is suppressed for this stream — a `status='suppressed'` row IS written (the
 *     audit trail design §5.1 requires), but `resolveAdapter`/the sender worker are never reached
 *     for it, so the "zero adapter calls" half of that AC holds structurally: this function never
 *     imports provider.ts at all. */
export async function enqueueMail(input: EnqueueMailInput): Promise<EnqueueMailResult> {
  if (!config.mail.enabled) return { skipped: true, reason: "disabled" };
  if (!isPlausibleEmail(input.toEmail)) {
    throw new Error(`enqueueMail: implausible recipient address ${JSON.stringify(input.toEmail)}`);
  }
  // Renders now so `mail_log.subject` is populated for the admin log list without a re-render —
  // also the earliest point an unknown template_key is caught (UnknownMailTemplateError), so a
  // typo'd key fails loudly at enqueue time rather than three retries later at send time.
  const rendered = renderTemplate(input.templateKey, input.payload ?? {});
  const subject = stripHeaderInjection(rendered.subject);
  const replyToken = input.withReplyToken ? newReplyToken() : null;

  return withMailContext(async (c) => {
    const suppressed = await isSuppressed(c, input.toEmail, input.stream);
    const id = newId();
    const status: "queued" | "suppressed" = suppressed ? "suppressed" : "queued";
    await c.query(
      `INSERT INTO mail_log (
         id, stream, tenant_id, user_id, to_email, template_key, subject, payload,
         notification_ids, entity_type, entity_id, reply_token, status, origin_site
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        input.stream,
        input.tenantId ?? null,
        input.userId ?? null,
        input.toEmail.trim(),
        input.templateKey,
        subject,
        JSON.stringify(input.payload ?? {}),
        input.notificationIds ?? [],
        input.entityType ?? null,
        input.entityId ?? null,
        replyToken,
        status,
        config.originSite,
      ],
    );
    recordEnqueued(input.stream, input.templateKey);
    if (suppressed) recordSuppressed(input.stream);
    return { skipped: false, id, status };
  });
}
