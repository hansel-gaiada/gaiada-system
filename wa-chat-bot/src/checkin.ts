// TR-11 — the WA half of "reminder -> reply -> checkin.submit". Mirrors actions/dispatch.ts's
// tryConfirmByReply in shape but is NOT an action proposal: checkin.submit is a single self-only
// MCP write (Cerbos already restricts it to "only the caller's own row" — see checkins.controller.
// ts / resource_checkin.yaml), so there is no propose/authorize/confirm gauntlet to run here.
//
// The bot NEVER asserts identity (D4, non-negotiable): every hub call below carries the envelope
// (provider:"whatsapp", externalId: <the chat's own id>) — exactly the same OBO pattern skills.ts's
// /projects and /know already use. The platform (via D4 + Cerbos) decides who that resolves to and
// whether the read/write is allowed; this file never claims a userId itself.
import { callHubTool, HubDeniedError } from "./hub";
import { sendWithRetry } from "./safety/outbound";
import { consumePendingCheckin, isConfirmReply, putPendingCheckin } from "./checkin-reminder";
import type { InboundMessage, WhatsAppGateway } from "./waha";

interface CheckinTodayResult {
  date: string;
  alreadySubmitted: boolean;
  draft: { summaryText: string };
}

interface CheckinSubmitResult {
  date: string;
  status: string;
}

/** Fetch today's prefill (as the RECIPIENT's own OBO envelope, never asserted) and, unless the day
 *  is already submitted, remember the pending-reply state and return the reminder text to send.
 *  Returns `null` when there is nothing to send: already submitted (never re-nag a done day — the
 *  idempotency the whole flow needs, since a redriven/retried n8n run must not double-message
 *  someone who already checked in) or when the identity can't be reached at all (HubDeniedError —
 *  the caller should treat that as "skip this one", not a hard failure of the whole notify batch). */
export async function composeCheckinReminder(tenantId: string, chatId: string, ttlMs: number): Promise<string | null> {
  const raw = await callHubTool("checkin.getToday", { tenantId }, { provider: "whatsapp", externalId: chatId });
  const draft = JSON.parse(raw) as CheckinTodayResult;
  if (draft.alreadySubmitted) return null;

  putPendingCheckin(chatId, { tenantId, prefillSummary: draft.draft.summaryText, date: draft.date }, ttlMs);
  return [
    `⏰ End-of-day check-in for ${draft.date}:`,
    "",
    draft.draft.summaryText,
    "",
    "Reply OK to confirm as-is, or send your own summary to record something different.",
  ].join("\n");
}

/** If this chat has a pending check-in reminder, treat `text` as its reply (confirm-as-is, or an
 *  edited/fresh summary), submit via the hub, and send a confirmation. Returns true iff it was
 *  consumed as a check-in reply — short-circuits the normal skill/Q&A pipeline, the same
 *  convention actions/dispatch.ts's tryConfirmByReply already uses for pending action confirms. */
export async function tryCheckinReply(gw: WhatsAppGateway, msg: InboundMessage, text: string): Promise<boolean> {
  const pending = consumePendingCheckin(msg.chatId);
  if (!pending) return false;

  const summary = isConfirmReply(text) ? pending.prefillSummary : text.trim();
  if (!summary) {
    await sendWithRetry(
      gw,
      msg.chatId,
      "That check-in reply looks empty — send a short summary of today, or reply OK to confirm the prefill.",
    );
    return true;
  }

  try {
    const raw = await callHubTool(
      "checkin.submit",
      { tenantId: pending.tenantId, summary, source: "wa" },
      { provider: "whatsapp", externalId: msg.senderId },
    );
    const result = JSON.parse(raw) as CheckinSubmitResult;
    await sendWithRetry(gw, msg.chatId, `✅ Check-in recorded for ${result.date}. Thanks!`);
  } catch (err) {
    if (err instanceof HubDeniedError) {
      await sendWithRetry(
        gw,
        msg.chatId,
        "I couldn't record that check-in for this chat identity — ask an admin to link and verify your account.",
      );
    } else {
      await sendWithRetry(gw, msg.chatId, `[check-in submit failed: ${(err as Error).message}]`);
    }
  }
  return true;
}
