// Retrying outbound send. Today's sends are fire-and-forget .catch(log) — a transient
// WAHA/Telegram blip silently drops the reply. This wraps a send with bounded
// exponential backoff and returns an auditable result instead of throwing.
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
  for (let i = 1; i <= attempts; i++) {
    try {
      await gw.sendText(chatId, text);
      return { ok: true, attempts: i };
    } catch (err) {
      lastErr = (err as Error).message;
      if (i < attempts) await sleep(baseDelayMs * 2 ** (i - 1));
    }
  }
  return { ok: false, attempts, error: lastErr };
}
