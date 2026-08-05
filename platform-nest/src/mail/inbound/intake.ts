// MAIL-13 — the inbound pipeline: normalized provider message → `mail_messages` row (design §7.6).
//
// THE ONE SECURITY INVARIANT THIS FILE EXISTS TO ENFORCE:
//
//     The VERP `reply+<token>@` token is the ONLY match key. `from_email` is display metadata and
//     never influences routing or authorization.
//
// Read that as two concrete statements about this code: a message whose `From:` is forged but whose
// token is valid IS that thread (nothing here consults the sender), and a message from the genuine
// human with the wrong token is NOT (the token lookup misses, and the A9 drop path runs). There is
// deliberately no "well, the sender matches the recipient of the original mail, close enough"
// fallback anywhere below — that fallback is approval-adjacent forgery, since sender addresses are
// forgeable by construction (§7.5).
//
// ORDER OF OPERATIONS is also load-bearing:
//   1. token extraction + `mail_log` lookup   — cheap, and decides whether we care at all
//   2. NDR classification                     — before anything is threaded (an NDR is not a reply)
//   3. INSERT ... ON CONFLICT DO NOTHING      — idempotency decided by the DATABASE, before any
//      expensive or side-effecting work happens
//   4. sanitize + quarantine + scan           — only for a row that is genuinely new
// Putting the idempotency decision (3) before the attachment work (4) is what makes a replayed
// delivery cost nothing: no re-scan, no re-write of quarantine bytes, no second row.
import { config } from "../../config";
import { newId, withMailContext } from "../../db";
import { storage } from "../../core/storage";
import { addSuppression } from "../suppressions";
import { recordInbound, recordInboundRejected } from "../metrics";
import { sanitizeInboundHeaderText, sanitizeInboundHtml, sanitizeInboundText } from "./html-sanitize";
import { classifyNdr } from "./ndr";
import { resolveScanner, type ScanVerdict } from "./scanner";
import type { InboundOutcome, NormalizedAttachment, NormalizedInbound } from "./types";

/** `reply+<token>@<domain>`. The token charset is base64url (`queue.ts` mints 16 CSPRNG bytes →
 *  22 chars); the bound is wide so a future widening of the token length needs no change here, and
 *  the authoritative test is the exact-equality lookup against `mail_log.reply_token`. */
const VERP_LOCALPART_RE = /^reply\+([A-Za-z0-9_-]{8,128})$/;

export interface StoredAttachment {
  index: number;
  /** Storage key under the quarantine prefix, or null when nothing was stored (dropped by a cap, or
   *  discarded because it was infected). A null `fileRef` is the download endpoint's "nothing to
   *  serve" case. */
  fileRef: string | null;
  name: string;
  contentType: string;
  bytes: number;
  scanStatus: "pending" | "clean" | "infected" | "skipped";
  /** True when an intake cap dropped this attachment. The message is still threaded — a reply's TEXT
   *  must not be lost because an attachment was too big (see the cap note below). */
  rejected?: boolean;
  rejectReason?: "too_large" | "too_many";
}

export interface IngestResult {
  outcome: InboundOutcome;
  /** The `mail_messages.id` when a row was written. */
  messageId?: string;
  /** The matched `mail_log.id` — the thread this landed on. */
  mailLogId?: string;
  /** Populated for the `unmatched` path so the log line can say WHY without leaking it to the caller. */
  note?: string;
}

interface MatchedMailLog {
  id: string;
  tenant_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  to_email: string;
  status: string;
}

/** Pulls the VERP token out of the recipient list. Returns the FIRST match: a delivery carries one
 *  `reply+…` recipient in practice, and scanning in RCPT-TO-then-To-then-Cc order (set by
 *  `brevo-payload.ts`) means the envelope recipient wins over a rewritten header. */
export function extractReplyToken(recipientAddresses: string[]): { token: string; domain: string } | null {
  for (const address of recipientAddresses) {
    const at = address.lastIndexOf("@");
    if (at <= 0) continue;
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    const m = VERP_LOCALPART_RE.exec(local);
    if (m) return { token: m[1], domain };
  }
  return null;
}

async function findByReplyToken(token: string): Promise<MatchedMailLog | null> {
  const { rows } = await withMailContext((c) =>
    c.query<MatchedMailLog>(
      `SELECT id, tenant_id, entity_type, entity_id, to_email, status FROM mail_log WHERE reply_token = $1`,
      [token],
    ),
  );
  return rows[0] ?? null;
}

/** Quarantine keys live under their own prefix in the EXISTING file store (design §7.6: "a quarantine
 *  area of the existing file store"). Deliberately NOT a `files` table row: `files` is FORCE-RLS and
 *  tenant-scoped, while `mail_messages` is global with a nullable tenant (§6.1), and inbound bytes must
 *  never become an ordinary, listable attachment on an entity — they are unscanned, unauthenticated
 *  content whose only read path is the scan-gated endpoint in `../thread.controller.ts`. */
function quarantineKey(messageId: string, index: number): string {
  return `mail-quarantine/${messageId}/${index}`;
}

async function processAttachments(
  messageId: string,
  attachments: NormalizedAttachment[],
): Promise<StoredAttachment[]> {
  const maxCount = config.mail.inboundMaxAttachments;
  const maxBytes = config.mail.inboundMaxAttachmentBytes;
  const scanning = config.mail.inboundScan === "clamav";
  const scanner = resolveScanner();

  const out: StoredAttachment[] = [];
  for (let index = 0; index < attachments.length; index++) {
    const att = attachments[index];
    const name = sanitizeInboundHeaderText(att.name, 255) ?? "attachment";
    const contentType = sanitizeInboundHeaderText(att.contentType, 128) ?? "application/octet-stream";

    // CAP POLICY, stated because it is an interpretation of "per-attachment + count caps" (§7.6):
    // an over-cap attachment is DROPPED and the message is still threaded, rather than the whole
    // delivery being refused. Refusing the delivery would discard a human's written reply because of
    // an attachment they may not even have meant to send, and the sender gets no bounce from us
    // either way (the provider does not relay our 4xx). The total-delivery cap
    // (`MAIL_INBOUND_MAX_BYTES`) IS a whole-message refusal — that one is a resource limit on the
    // request itself, applied before parsing.
    if (index >= maxCount) {
      out.push({ index, fileRef: null, name, contentType, bytes: att.declaredBytes, scanStatus: "skipped", rejected: true, rejectReason: "too_many" });
      recordInboundRejected("size");
      continue;
    }
    const bytes = att.content;
    const size = bytes ? bytes.byteLength : att.declaredBytes;
    if (size > maxBytes) {
      out.push({ index, fileRef: null, name, contentType, bytes: size, scanStatus: "skipped", rejected: true, rejectReason: "too_large" });
      recordInboundRejected("size");
      continue;
    }
    if (!bytes) {
      // Metadata-only attachment (real Brevo hands out a `DownloadToken` instead of bytes — see
      // brevo-payload.ts's honest-gap note). Nothing to store and nothing to scan, so it stays
      // `pending`: fail-closed, download refused, and visible in the UI as an attachment that exists
      // but cannot be served. Turning it into `skipped` would make it admin-downloadable when there
      // is nothing to download.
      out.push({ index, fileRef: null, name, contentType, bytes: size, scanStatus: "pending" });
      continue;
    }

    let scanStatus: StoredAttachment["scanStatus"];
    if (!scanning) {
      scanStatus = "skipped";
    } else {
      const verdict: ScanVerdict = await scanner.scan(bytes);
      scanStatus = verdict; // clean | infected | pending — all three are valid stored states
    }

    if (scanStatus === "infected") {
      // Known-malicious bytes are never written to disk. The row keeps the metadata so the UI (and an
      // operator) can see that something was blocked and what it claimed to be.
      out.push({ index, fileRef: null, name, contentType, bytes: size, scanStatus });
      continue;
    }
    const fileRef = quarantineKey(messageId, index);
    await storage().put(fileRef, bytes);
    out.push({ index, fileRef, name, contentType, bytes: size, scanStatus });
  }
  return out;
}

/**
 * Ingests one normalized inbound message. Never throws for untrusted-input reasons — every refusal is
 * a returned outcome, because the HTTP contract (§7.6/A9/§7.7) is "count + log + 204, never an error
 * and never a signal to the sender about whether a token exists".
 */
export async function ingestInbound(msg: NormalizedInbound): Promise<IngestResult> {
  const provider = msg.provider;

  // An un-keyable delivery cannot be made idempotent, so it must not be stored — a replay would
  // create a second row forever. Treated as the A9 drop (204 + counter), not an error, so a drifted
  // provider payload can never build a retry loop.
  if (!msg.providerMessageId) {
    recordInbound(provider, "unmatched");
    return { outcome: "unmatched", note: "no provider message id" };
  }

  const verp = extractReplyToken(msg.recipientAddresses);
  if (!verp) {
    recordInbound(provider, "unmatched");
    return { outcome: "unmatched", note: "no reply+<token> recipient" };
  }
  if (config.mail.replyDomain && verp.domain.toLowerCase() !== config.mail.replyDomain.toLowerCase()) {
    // NOT a rejection: the token is the match (§7.6), and a valid 128-bit token can only have come
    // from us regardless of which host it came back addressed to (forwarders and mailing lists rewrite
    // domains). Logged because a systematic mismatch means `MAIL_REPLY_DOMAIN` disagrees with the MX
    // that is actually receiving — a misconfiguration that would otherwise be invisible.
    // eslint-disable-next-line no-console
    console.warn(`[mail-inbound] reply token arrived on unexpected domain '${verp.domain}' (configured '${config.mail.replyDomain}')`);
  }

  const matched = await findByReplyToken(verp.token);
  if (!matched) {
    // A9, verbatim: "logged (counter + log line) and dropped with 204. This is a system-thread reply
    // channel, not a mailbox — there is no orphan inbox to triage in v1." The log line deliberately
    // does NOT include the presented token: it would put a (near-miss) credential-shaped value into
    // log aggregation for every scan attempt.
    recordInbound(provider, "unmatched");
    // eslint-disable-next-line no-console
    console.warn(`[mail-inbound] dropped: reply token matched no mail_log row (provider=${provider})`);
    return { outcome: "unmatched", note: "unknown token" };
  }

  const ndr = classifyNdr(msg);
  const subject = sanitizeInboundHeaderText(msg.subject);
  const { text } = sanitizeInboundText(msg.textBody);
  const html = sanitizeInboundHtml(msg.htmlBody);

  const id = newId();
  // NDR rows are threaded onto the MAIL LOG but deliberately NOT onto the entity: `entity_type`/
  // `entity_id` stay NULL so a bounce notice can never appear in the reply thread on an approval or
  // portal run surface, where it would render behind the "Email reply — sender unverified" banner and
  // read as a human comment. A bounce belongs in the admin mail log, and that is exactly where the
  // `mail_log_id` join puts it.
  const entityType = ndr.ndr ? null : matched.entity_type;
  const entityId = ndr.ndr ? null : matched.entity_id;

  const inserted = await withMailContext(async (c) => {
    const res = await c.query<{ id: string }>(
      `INSERT INTO mail_messages (
         id, mail_log_id, tenant_id, entity_type, entity_id, provider, provider_message_id,
         from_email, subject, body_text, body_html_sanitized, attachments, size_bytes, origin_site
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,$12,$13)
       ON CONFLICT (provider, provider_message_id) DO NOTHING
       RETURNING id`,
      [
        id,
        matched.id,
        matched.tenant_id,
        entityType,
        entityId,
        provider,
        msg.providerMessageId,
        // Stored purely so the UI can show "who says they sent this" behind the unverified banner.
        sanitizeInboundHeaderText(msg.fromEmail, 320) ?? "unknown@invalid",
        subject,
        text,
        html,
        msg.sizeBytes,
        config.originSite,
      ],
    );
    return res.rows[0]?.id ?? null;
  });

  if (!inserted) {
    // The UNIQUE index did its job: this exact delivery is already stored. No second row, no re-scan,
    // no re-written quarantine bytes — and still a 204, because a provider replaying a webhook is
    // normal operation, not an error.
    recordInbound(provider, "duplicate");
    return { outcome: "duplicate", mailLogId: matched.id };
  }

  if (!ndr.ndr && msg.attachments.length) {
    const stored = await processAttachments(id, msg.attachments);
    await withMailContext((c) =>
      c.query(`UPDATE mail_messages SET attachments = $2::jsonb WHERE id = $1`, [id, JSON.stringify(stored)]),
    );
  }

  if (ndr.ndr) {
    await applyNdr(matched, ndr.hard, ndr.detail);
    recordInbound(provider, "ndr");
    return { outcome: "ndr", messageId: id, mailLogId: matched.id };
  }

  recordInbound(provider, "threaded");
  return { outcome: "threaded", messageId: id, mailLogId: matched.id };
}

/** §7.6 bounce synergy + §7.7's severity rule: a permanent (5.x.x) NDR flips the row to `bounced` and
 *  suppresses the address; anything softer is recorded on the row and nothing else. `AND status <>
 *  'bounced'` makes a replayed NDR a true no-op on the log row, matching the delivery-event webhook's
 *  idempotency shape. */
async function applyNdr(matched: MatchedMailLog, hard: boolean, detail: string): Promise<void> {
  await withMailContext(async (c) => {
    if (hard) {
      await c.query(
        `UPDATE mail_log SET status = 'bounced', last_error = $2, updated_at = now()
           WHERE id = $1 AND status <> 'bounced'`,
        [matched.id, detail],
      );
      await addSuppression(c, matched.to_email, "*", "hard_bounce", { provider: "ndr", detail });
    } else {
      await c.query(
        `UPDATE mail_log SET last_error = $2, updated_at = now() WHERE id = $1 AND (last_error IS DISTINCT FROM $2)`,
        [matched.id, detail],
      );
    }
  });
}

export { quarantineKey };
