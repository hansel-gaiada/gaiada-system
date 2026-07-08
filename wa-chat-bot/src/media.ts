// Media worker (Tasks 2.2 + 2.6): drains pending media rows — download from WAHA,
// extract text via the Gateway (/media), SCRUB, persist. Bytes live only in memory for
// the duration of one job; only the reference + derived text are stored. Every failure
// is recorded on the row (observable), and one bad row never stops the batch.
import { config } from "./config";
import { scrub } from "./scrub";
import { extractMediaText } from "./extract";
import { isTelegramFileRef, downloadTelegramFile } from "./telegram";
import { getPendingMedia, updateMedia } from "./store";

async function download(ref: string): Promise<Buffer> {
  // Telegram media (5a.7): resolve the file_id via the Bot API (getFile + download).
  if (isTelegramFileRef(ref)) return downloadTelegramFile(ref);
  // WAHA (or any direct URL): plain fetch with the WAHA api key.
  const res = await fetch(ref, {
    headers: { ...(config.wahaApiKey ? { "X-Api-Key": config.wahaApiKey } : {}) },
  });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

import type { StoredMessage } from "./store";

/** Settle ONE pending media row: download -> extract -> SCRUB -> persist. */
export async function processMediaRow(row: StoredMessage): Promise<void> {
  {
    if (!row.mediaRef) {
      await updateMedia(row.waMessageId, {
        status: "failed",
        text: "[media received — file not served by WAHA (check WHATSAPP_DOWNLOAD_MEDIA / engine media config)]",
      });
      return;
    }
    try {
      const bytes = await download(row.mediaRef);
      if (bytes.length > config.mediaMaxBytes) {
        await updateMedia(row.waMessageId, {
          status: "failed",
          text: `[media too large to process (${bytes.length} bytes)]`,
        });
        return;
      }
      const raw = await extractMediaText(bytes, row.mediaMime ?? "application/octet-stream");
      // Day-one guarantee: media-derived text is scrubbed BEFORE it is persisted.
      const { clean } = scrub(raw);
      await updateMedia(row.waMessageId, { status: "done", text: clean });
    } catch (err) {
      await updateMedia(row.waMessageId, {
        status: "failed",
        text: `[media processing failed: ${(err as Error).message}]`,
      });
    }
  }
}

/** Process up to `limit` pending media rows. Returns how many rows were settled. */
export async function processPendingMedia(limit = 5): Promise<number> {
  const rows = await getPendingMedia(limit);
  for (const row of rows) await processMediaRow(row);
  return rows.length;
}

/** Poll loop. Primary processor in dev (no Redis); slow RECONCILER when the BullMQ
 *  queue is active — catches rows whose enqueue or job was lost. Reentrancy-guarded. */
export function startMediaWorker(intervalSeconds: number = config.mediaPollSeconds): NodeJS.Timeout {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processPendingMedia();
    } catch (err) {
      console.warn(`[media] worker pass failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }, intervalSeconds * 1000);
}
