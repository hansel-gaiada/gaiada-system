// PGL-10 (owner ruling PV-D47) — the client invitation email: the one client mail that MUST carry a credential.
// Contract: docs/FRONTEND-BFF-CONTRACT.md §62.5.
//
// ── THE PROBLEM ──────────────────────────────────────────────────────────────────────────────────────────
// Every other mail is queue-and-defer: `enqueueMail()` stores `(template_key, payload)` in `mail_log`, and the sender
// re-renders the body from that payload at send time, possibly minutes later and up to five times (sender.ts). An invite
// link IS the secret (it creates a login), so putting it in the payload would leave a live bearer credential in a
// queryable, admin-readable, backed-up row. The magic link (mail/magic-link/service.ts) solved this by sending INLINE
// with a redacted audit row and NO retry. An invite cannot take that trade: a client who never gets their invite is a
// support call, and a one-shot send has no second chance.
//
// ── THE DESIGN: MINT AT SEND TIME, NEVER STORE IT ───────────────────────────────────────────────────────────
// 1. The invite route creates the invite SEALED (`delivery = 'mail'`, token_hash = the hash of random bytes nobody
//    keeps) and enqueues a `client.invite` mail whose payload holds an opaque REFERENCE only: the invite id, the two
//    names and the expiry. An invite id is not a credential: a v2 token also needs the HMAC key and a 16-byte nonce
//    that exists nowhere but the outgoing message.
// 2. The sender, after its suppression re-check and immediately before the adapter call, runs `composeInviteForSend`:
//    one atomic UPDATE mints a fresh token's hash onto the invite (only if it is still a usable mail invite bound to
//    this recipient), the raw token goes into `href` IN MEMORY, the mail is rendered and handed to the adapter.
//    Nothing writes `href`, the token or the rendered body anywhere.
// 3. Send failed → `onSendFailure` re-seals the invite (the attempt's token dies) and the normal backoff retries; the
//    retry mints a NEW token. So at most one token is live per invite, and only once a send attempt has been made.
//
// What each case does:
//   retry        a new token per attempt; the previous attempt's token is dead (re-sealed, then overwritten).
//   resend       the route spends every open invite of the contact first; a queued or retrying mail for the old
//                invite then finds it spent here and is DROPPED (status 'failed', a plain reason, no send).
//   revoke       spends open invites (client-contacts.controller.ts) → the same drop.
//   accepted / expired → the same drop; a mail never carries a dead link.
//   suppressed   the sender's suppression re-check runs BEFORE this, so a suppressed row never mints.
//   preview      renders the STORED payload: no href, a placeholder sentence, never a mint (admin-mail.controller.ts).
//   hand-forwarded link: a mailed invite's token is never returned to the PM. A PM who wants a link asks for one
//                (`delivery: "link"`), which is a resend: the mailed invite is spent and the mail, if not yet sent,
//                is dropped. One live credential per contact.
//
// Logs: the only lines this path can produce are the sender's own, which carry ids and an error message. The adapter
// error message is scrubbed of the token before it is stored as `last_error` (`redact`).
import { config } from "../config";
import { mintMailInviteToken, resealMailInvite } from "../core/client-invites";
import { renderTemplate } from "./templates";
import type { ClaimedMail, RenderedMail } from "./types";

export const CLIENT_INVITE_TEMPLATE = "client.invite";

/** The ONLY keys a stored `client.invite` payload may hold. `href`, a token, a hash or anything else is refused at
 *  enqueue (`assertInvitePayloadHoldsNoCredential`). An allow-list, so a future "helpful" field cannot slip a link in. */
const STORED_PAYLOAD_KEYS: ReadonlySet<string> = new Set(["inviteId", "companyName", "clientName", "expiresAt"]);

export class InviteMailPayloadError extends Error {
  constructor(key: string) {
    super(`client.invite payload may not carry "${key}": the invite link is minted at send time and never stored`);
    this.name = "InviteMailPayloadError";
  }
}

/** Called by `enqueueMail` for every `client.invite` row, before the INSERT. Throws on any key outside the allow-list
 *  and on any value that looks like an invite token. */
export function assertInvitePayloadHoldsNoCredential(payload: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (!STORED_PAYLOAD_KEYS.has(key)) throw new InviteMailPayloadError(key);
    if (typeof value === "string" && /inv\d\./.test(value)) throw new InviteMailPayloadError(key);
  }
  if (typeof payload?.inviteId !== "string" || !payload.inviteId) throw new InviteMailPayloadError("inviteId (missing)");
}

export type ComposedInvite =
  | {
      kind: "send";
      rendered: RenderedMail;
      /** Re-seal the invite after a failed attempt, so the token that attempt carried is dead. */
      onSendFailure: () => Promise<void>;
      /** Remove the raw token from a string (an adapter error message) before it is stored or logged. */
      redact: (s: string) => string;
    }
  | { kind: "drop"; reason: string };

export const INVITE_NOT_OPEN_REASON =
  "not sent: the invitation is no longer open (accepted, revoked, replaced by a newer invitation, or expired)";

/** The send-time composer for a claimed `client.invite` row. The raw token lives in this function's locals and the
 *  returned closures only. */
export async function composeInviteForSend(row: ClaimedMail): Promise<ComposedInvite> {
  const payload = row.payload ?? {};
  const inviteId = typeof payload.inviteId === "string" ? payload.inviteId : "";
  const tenantId = row.tenant_id ?? "";
  if (!inviteId || !tenantId) return { kind: "drop", reason: "not sent: the mail row names no invitation" };

  const minted = await mintMailInviteToken(tenantId, inviteId, row.to_email);
  if (!minted) return { kind: "drop", reason: INVITE_NOT_OPEN_REASON };

  const token = minted.token;
  const rendered = renderTemplate(CLIENT_INVITE_TEMPLATE, {
    companyName: payload.companyName,
    clientName: payload.clientName,
    // The row's own expiry, not the payload's copy: the row is the authority.
    expiresAt: minted.expiresAt,
    href: `${config.mail.linkBaseUrl}/invite/${token}`,
  });
  return {
    kind: "send",
    rendered,
    onSendFailure: () => resealMailInvite(tenantId, inviteId, minted.tokenHash),
    redact: (s: string) => s.split(token).join("[redacted invite token]"),
  };
}

/** The admin preview of a stored `client.invite` row: the stored payload only, with any `href` stripped even if one
 *  were ever present. Never mints. */
export function renderInvitePreview(payload: Record<string, unknown>): RenderedMail {
  const { href: _ignored, ...stored } = payload ?? {};
  return renderTemplate(CLIENT_INVITE_TEMPLATE, stored);
}
