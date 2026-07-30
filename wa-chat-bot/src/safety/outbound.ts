// Retrying outbound send. Today's sends are fire-and-forget .catch(log) — a transient
// WAHA/Telegram blip silently drops the reply. This wraps a send with bounded
// exponential backoff and returns an auditable result instead of throwing.
//
// Also records every successfully-sent text into the loop-guard's echo-detection history
// (safety/loop-guard.ts). This is the universal choke point for that: bot.ts's Q&A/skill
// replies AND actions/dispatch.ts's propose/confirm/clarify replies all flow through here
// regardless of which gateway instance is passed in (SurfaceRouter for WhatsApp, or a raw
// TelegramGateway for the Telegram webhook/poller — see the hardening report on that split).
import { OUTBOUND_CEILING_ERROR } from "./outbound-ceiling";
import { recordOutboundText } from "./loop-guard";
import type { WhatsAppGateway } from "../waha";

export async function sendWithRetry(
  gw: WhatsAppGateway,
  chatId: string,
  text: string,
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: boolean; attempts: number; error?: string }> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastErr = "";
  let tried = 0;
  for (let i = 1; i <= attempts; i++) {
    tried = i;
    try {
      await gw.sendText(chatId, text);
      recordOutboundText(chatId, text);
      return { ok: true, attempts: i };
    } catch (err) {
      lastErr = (err as Error).message;
      // A halt/ceiling block is a policy decision, not a transient network blip — retrying
      // just burns attempts against a brake that won't lift in milliseconds. Fail fast so the
      // caller's failure-handling (schedule.ts's per-chat catch, the caller's console.warn)
      // fires immediately instead of after 1.5s of pointless backoff.
      if (lastErr === OUTBOUND_CEILING_ERROR) break;
      if (i < attempts) await sleep(baseDelayMs * 2 ** (i - 1));
    }
  }
  return { ok: false, attempts: tried, error: lastErr };
}
