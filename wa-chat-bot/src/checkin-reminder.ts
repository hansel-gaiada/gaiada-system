// TR-11 — pending state for "reminder -> WA reply -> checkin.submit". A reminder send marks a
// chatId as awaiting a check-in reply; the very NEXT inbound message from that chat is treated as
// the check-in text (or a bare confirmation of the prefill) instead of being routed to the normal
// skill/Q&A pipeline. Same "pending, single-use, TTL'd" shape as actions/confirm.ts's
// PendingAction, kept as its own tiny map on purpose: a check-in reply is a different domain (no
// propose/authorize/execute gauntlet — checkin.submit is a single self-only MCP write, already
// Cerbos-gated to "only the caller's own row") and must not compete with or clobber a genuinely
// pending ACTION confirmation from the same chat.
export interface PendingCheckin {
  tenantId: string;
  /** Today's derived prefill summary, captured at reminder-send time — what a bare "OK" reply
   *  confirms, without re-fetching it (the reply itself may arrive well after the reminder). */
  prefillSummary: string;
  date: string;
}

interface StoredPendingCheckin extends PendingCheckin {
  expiresAt: number;
}

const pending = new Map<string, StoredPendingCheckin>();

export function putPendingCheckin(chatId: string, p: PendingCheckin, ttlMs: number, now: number = Date.now()): void {
  pending.set(chatId, { ...p, expiresAt: now + ttlMs });
}

export function getPendingCheckin(chatId: string, now: number = Date.now()): PendingCheckin | null {
  const p = pending.get(chatId);
  if (!p) return null;
  if (p.expiresAt <= now) {
    pending.delete(chatId);
    return null;
  }
  const { tenantId, prefillSummary, date } = p;
  return { tenantId, prefillSummary, date };
}

/** Single-use consume: returns the pending reminder iff it exists and is unexpired, and removes
 *  it so a webhook redelivery or a second reply can never double-submit the same reminder. */
export function consumePendingCheckin(chatId: string, now: number = Date.now()): PendingCheckin | null {
  const p = getPendingCheckin(chatId, now);
  if (p) pending.delete(chatId);
  return p;
}

export function resetPendingCheckins(): void {
  pending.clear();
}

/** "Confirm the prefill as-is" replies — kept generous (common short affirmatives + a thumbs-up/
 *  check emoji) because the whole point of a prefilled draft is that most days need no edit at
 *  all; a stricter list would push people toward re-typing something the bot already derived. */
const CONFIRM_RE = /^(ok|okay|k|yes|y|confirm|confirmed|done|sure|good|👍|✅)[.!]?$/i;

export function isConfirmReply(text: string): boolean {
  return CONFIRM_RE.test(text.trim());
}
