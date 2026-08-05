// MAIL-04 — suppression semantics (design §5.1, unchanged from v1). Exact lowercased address
// match only; `stream='*'` suppresses every stream, a per-stream row suppresses just that one.
import type { PoolClient } from "pg";
import { newId } from "../db";
import { normalizeEmail } from "./sanitize";
import type { MailStream } from "./types";

/** True if `email` is suppressed for `stream` — either a stream-specific row or a `stream='*'`
 *  row. Runs on whatever client the caller is already using (queue.ts's enqueue-time check and
 *  sender.ts's send-time re-check both call this inside their own transaction/connection) so the
 *  read is never a separate pool round-trip from the write that follows it. */
export async function isSuppressed(client: PoolClient, email: string, stream: MailStream): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM mail_suppressions WHERE email = $1 AND stream IN ($2, '*') LIMIT 1`,
    [normalizeEmail(email), stream],
  );
  return rows.length > 0;
}

export type SuppressionReason = "hard_bounce" | "complaint" | "manual";

/** Idempotent by `(email, stream)` UNIQUE — a repeat bounce/complaint for the same address+stream
 *  is a no-op, never a duplicate audit row (also what makes the delivery webhook idempotent). */
export async function addSuppression(
  client: PoolClient,
  email: string,
  stream: MailStream | "*",
  reason: SuppressionReason,
  detail?: { provider?: string; detail?: string },
): Promise<void> {
  await client.query(
    `INSERT INTO mail_suppressions (id, email, stream, reason, provider, detail)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email, stream) DO NOTHING`,
    [newId(), normalizeEmail(email), stream, reason, detail?.provider ?? null, detail?.detail ?? null],
  );
}
