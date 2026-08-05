// MAIL-04 — the sender worker (design §7.7). Chained-setTimeout sweep (same idiom as
// events/graph-bridge.ts's startGraphBridgeLoop — no cron dependency, no extra package), claim
// with `FOR UPDATE SKIP LOCKED` so two platform instances never double-send the same row, backoff
// with a 5-attempt cap, auth-stream-first ordering (a stuck notify-stream queue must never starve
// password resets).
import { withMailContext } from "../db";
import { isSuppressed } from "./suppressions";
import { renderTemplate } from "./templates";
import { resolveAdapter } from "./provider";
import { stripHeaderInjection } from "./sanitize";
import { config } from "../config";
import { recordSent, recordFailed, recordSuppressed, recordSendDuration } from "./metrics";
import type { ClaimedMail, MailStream, OutboundMail } from "./types";

export const MAIL_MAX_ATTEMPTS = 5;

/** `min(2^attempts, 60)` minutes, per design §7.7. `attemptsAfter` is the count AFTER this failure
 *  is recorded (1-indexed) — exported so a unit test can pin the exact schedule without driving a
 *  real failing send five times. */
export function backoffMinutes(attemptsAfter: number): number {
  return Math.min(2 ** attemptsAfter, 60);
}

/** Claims up to `limit` due rows and marks them `sending`, inside one transaction — the
 *  `FOR UPDATE SKIP LOCKED` is what makes two concurrent callers (two workers, or two platform
 *  instances) partition a shared due-set with no row claimed twice. Auth-stream rows sort first
 *  (`ORDER BY (stream = 'auth') DESC, next_attempt_at ASC`) so a backlog on the notify stream can
 *  never delay a password-reset mail sitting in the same batch window.
 *
 *  `withMailContext` already runs `fn` inside its own BEGIN/COMMIT (MAIL-22, so the mail-context GUC
 *  it sets survives for the whole call) — this used to open a SECOND, nested transaction of its own
 *  before that wrapper existed; now the claim+update below simply runs inside the one transaction
 *  `withMailContext` already provides, and a thrown error rolls that same transaction back. */
export async function claimDueMail(limit = 20): Promise<ClaimedMail[]> {
  return withMailContext(async (c) => {
    const { rows } = await c.query<ClaimedMail>(
      `SELECT id, stream, to_email, template_key, payload, subject, entity_type, entity_id, reply_token, attempts
         FROM mail_log
        WHERE status = 'queued' AND next_attempt_at <= now()
        ORDER BY (stream = 'auth') DESC, next_attempt_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [limit],
    );
    if (rows.length > 0) {
      await c.query(`UPDATE mail_log SET status = 'sending', updated_at = now() WHERE id = ANY($1::uuid[])`, [
        rows.map((r) => r.id),
      ]);
    }
    return rows;
  });
}

async function markSuppressedRow(id: string): Promise<void> {
  await withMailContext((c) =>
    c.query(`UPDATE mail_log SET status = 'suppressed', updated_at = now() WHERE id = $1`, [id]),
  );
}

async function markSent(id: string, provider: string, providerMessageId: string | undefined): Promise<void> {
  await withMailContext((c) =>
    c.query(
      `UPDATE mail_log
          SET status = 'sent', provider = $2, provider_message_id = $3,
              provider_accepted_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id, provider, providerMessageId ?? null],
    ),
  );
}

async function markFailedOrRetry(id: string, attemptsBefore: number, errorMessage: string): Promise<void> {
  const attemptsAfter = attemptsBefore + 1;
  if (attemptsAfter >= MAIL_MAX_ATTEMPTS) {
    await withMailContext((c) =>
      c.query(
        `UPDATE mail_log SET status = 'failed', attempts = $2, last_error = $3, updated_at = now() WHERE id = $1`,
        [id, attemptsAfter, errorMessage.slice(0, 2000)],
      ),
    );
    return;
  }
  const minutes = backoffMinutes(attemptsAfter);
  await withMailContext((c) =>
    c.query(
      `UPDATE mail_log
          SET status = 'queued', attempts = $2, last_error = $3,
              next_attempt_at = now() + ($4 || ' minutes')::interval, updated_at = now()
        WHERE id = $1`,
      [id, attemptsAfter, errorMessage.slice(0, 2000), String(minutes)],
    ),
  );
}

/** Processes exactly one already-claimed row: suppression re-check (§7.7: "per row: suppression
 *  re-check → adapter send"), then render + send, then persist the outcome. Never throws — every
 *  failure path (suppressed, send error) is captured and turned into a row update, so one bad row
 *  in a batch can never abort the rest of the batch. */
export async function processClaimedMail(row: ClaimedMail): Promise<"sent" | "suppressed" | "failed" | "retry"> {
  const suppressedNow = await withMailContext((c) => isSuppressed(c, row.to_email, row.stream));
  if (suppressedNow) {
    await markSuppressedRow(row.id);
    recordSuppressed(row.stream);
    return "suppressed";
  }

  const rendered = renderTemplate(row.template_key, row.payload);
  const adapter = resolveAdapter(row.stream as MailStream);
  const mail: OutboundMail = {
    stream: row.stream,
    to: { email: row.to_email },
    replyTo: row.reply_token ? { email: `reply+${row.reply_token}@${config.mail.replyDomain}` } : undefined,
    subject: stripHeaderInjection(rendered.subject),
    html: rendered.html,
    text: rendered.text,
  };

  const startedAt = Date.now();
  try {
    const result = await adapter.send(mail);
    recordSendDuration(row.stream, Date.now() - startedAt);
    await markSent(row.id, adapter.name, result.providerMessageId);
    recordSent(row.stream);
    return "sent";
  } catch (err) {
    recordSendDuration(row.stream, Date.now() - startedAt);
    recordFailed(row.stream);
    const attemptsAfter = row.attempts + 1;
    await markFailedOrRetry(row.id, row.attempts, (err as Error).message ?? String(err));
    return attemptsAfter >= MAIL_MAX_ATTEMPTS ? "failed" : "retry";
  }
}

/** One sweep: claim, then process sequentially (SMTP connections are cheap to reuse one-at-a-time
 *  at this volume — design §7.2 puts real-world traffic at "a handful per day" — so there is no
 *  need for intra-batch concurrency, which would only complicate the auth-first ordering). Returns
 *  the number of rows claimed, for tests/observability. */
export async function sendDueMailOnce(limit = 20): Promise<number> {
  const claimed = await claimDueMail(limit);
  for (const row of claimed) {
    // eslint-disable-next-line no-await-in-loop
    await processClaimedMail(row);
  }
  return claimed.length;
}

/** Chained-setTimeout sweeper (same idiom as events/graph-bridge.ts's startGraphBridgeLoop). Only
 *  ever started by main.ts when `config.mail.enabled` — see that file's own gate — so this
 *  function itself does not re-check the flag; a caller that starts it unconditionally would be
 *  the bug, not this function silently no-op'ing. */
export function startMailSenderLoop(intervalMs = config.mail.senderIntervalMs): { stop: () => void } {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await sendDueMailOnce();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[mail-sender] sweep failed:", (err as Error).message);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
    },
  };
}
