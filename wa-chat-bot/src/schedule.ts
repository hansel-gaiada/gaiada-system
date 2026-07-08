import cron from "node-cron";
import { config } from "./config";
import { loadGroups, monitoredGroups, managementGroupId, groupName, groupCategory, groupOptIn } from "./groups";
import { getGroupChatIds, getMessages } from "./store";
import { summarizeChat } from "./summarize";
import { loadLastRun, saveLastRun, claimSlot } from "./schedule-state";
import { computeWindow, type Slot } from "./window";
import type { WhatsAppGateway } from "./waha";

export interface DigestResult {
  slot: Slot;
  perGroup: { chatId: string; digest: string }[];
  skipped?: boolean; // true when the per-slot/day idempotency claim was already taken
}

/**
 * Summarize each monitored group for the window since the last run of this slot,
 * post each opt-in group's digest back into it, and post a combined digest —
 * grouped by category, using group names — to the management group.
 * A failing group degrades to a placeholder; it never blocks the others (no silent drop).
 */
export async function runDigests(
  gw: WhatsAppGateway,
  slot: Slot,
  now: number = Date.now(),
  opts: { idempotent?: boolean } = {},
): Promise<DigestResult> {
  // 5a.8: the cron path claims (slot, day) so a double-fire runs at most once/day.
  // Manual/admin/test calls default to non-idempotent (always run).
  if (opts.idempotent) {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    if (!(await claimSlot(slot, dayKey))) return { slot, perGroup: [], skipped: true };
  }
  const registryActive = loadGroups() !== null;
  const win = computeWindow(await loadLastRun(slot), now);
  const chatIds = registryActive ? monitoredGroups().map((g) => g.id) : await getGroupChatIds();
  const perGroup: { chatId: string; digest: string }[] = [];

  for (const chatId of chatIds) {
    const msgs = (await getMessages(chatId, win.start)).filter((m) => m.ts <= win.end && !m.fromBot);
    if (msgs.length === 0) continue;
    let digest: string;
    try {
      digest = await summarizeChat(msgs);
    } catch (err) {
      digest = `[digest unavailable: ${(err as Error).message}]`;
    }
    perGroup.push({ chatId, digest });
    const postBack = registryActive ? groupOptIn(chatId) : config.postToGroups;
    if (postBack) {
      await gw.sendText(chatId, `*Digest — ${slot}*\n\n${digest}`).catch((err: Error) => {
        console.warn(`[digest] send to ${chatId} failed: ${err.message}`);
      });
    }
  }

  const mgmt = managementGroupId();
  if (mgmt && perGroup.length > 0) {
    const byCategory = new Map<string, string[]>();
    for (const g of perGroup) {
      const cat = groupCategory(g.chatId);
      const block = `*${groupName(g.chatId)}*\n${g.digest}`;
      byCategory.set(cat, [...(byCategory.get(cat) ?? []), block]);
    }
    const combined = [...byCategory.entries()]
      .map(([cat, blocks]) => `_${cat}_\n\n${blocks.join("\n\n")}`)
      .join("\n\n———\n\n");
    await gw.sendText(mgmt, `*Work Digest — ${slot}*\n\n${combined}`).catch((err: Error) => {
      console.warn(`[digest] send to management ${mgmt} failed: ${err.message}`);
    });
  }

  await saveLastRun(slot, win.end);
  return { slot, perGroup };
}

/** Wire the 12:00 and 18:00 cron jobs in the configured timezone (GMT+8). Cron runs
 *  are idempotent per slot/day (survives double-fire and multiple instances). */
export function startScheduler(gw: WhatsAppGateway): void {
  const timezone = config.scheduleTimezone;
  cron.schedule("0 12 * * *", () => void runDigests(gw, "noon", Date.now(), { idempotent: true }), { timezone });
  cron.schedule("0 18 * * *", () => void runDigests(gw, "evening", Date.now(), { idempotent: true }), { timezone });
}
