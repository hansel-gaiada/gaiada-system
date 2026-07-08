// Confirmation FSM state: pending actions awaiting a user's confirm. Keyed by (chatId,
// senderId) so a user confirms their own most-recent proposal. The token is single-use —
// consuming it removes the pending action, so a double-tap or webhook redelivery is a no-op.
export interface PendingAction {
  chatId: string;
  senderId: string;
  actionName: string;
  args: unknown;
  preview: string;
  token: string;
  expiresAt: number;
}

const pending = new Map<string, PendingAction>();

const key = (chatId: string, senderId: string) => `${chatId}|${senderId}`;

export function resetConfirm(): void {
  pending.clear();
}

/** Store a proposal, superseding any previous one from the same user in the same chat. */
export function putPending(p: Omit<PendingAction, "expiresAt">, ttlMs: number, now: number = Date.now()): void {
  pending.set(key(p.chatId, p.senderId), { ...p, expiresAt: now + ttlMs });
}

export function getPending(chatId: string, senderId: string, now: number = Date.now()): PendingAction | null {
  const p = pending.get(key(chatId, senderId));
  if (!p) return null;
  if (p.expiresAt <= now) {
    pending.delete(key(chatId, senderId));
    return null;
  }
  return p;
}

/**
 * Single-use consume: returns the pending action iff it exists, is unexpired, and the token
 * matches; removes it so it can never execute twice. A reply-confirmation ("yes"/"1") passes
 * the stored token as `token`; a button press passes the token from its payload.
 */
export function consumeToken(chatId: string, senderId: string, token: string, now: number = Date.now()): PendingAction | null {
  const p = getPending(chatId, senderId, now);
  if (!p || p.token !== token) return null;
  pending.delete(key(chatId, senderId));
  return p;
}

export function clearPending(chatId: string, senderId: string): void {
  pending.delete(key(chatId, senderId));
}
