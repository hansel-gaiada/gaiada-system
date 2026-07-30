import cron from "node-cron";
import { config } from "./config";
import { loadGroups, monitoredGroups, managementGroupId, groupName, groupCategory, groupOptIn, isIgnored } from "./groups";
import { getGroupChatIds, getMessages } from "./store";
import { summarizeChat } from "./summarize";
import { loadLastRun, saveLastRun, claimSlot } from "./schedule-state";
import { computeWindow, type Slot } from "./window";
import { postToGroupsEnabled } from "./safety/post-toggle";
import { recordDigestRun, type DigestTrigger } from "./digest-history";
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
  opts: { idempotent?: boolean; trigger?: DigestTrigger } = {},
): Promise<DigestResult> {
  // 5a.8: the cron path claims (slot, day) so a double-fire runs at most once/day.
  // Manual/admin/test calls default to non-idempotent (always run).
  if (opts.idempotent) {
    const dayKey = new Date(now).toISOString().slice(0, 10);
    if (!(await claimSlot(slot, dayKey))) return { slot, perGroup: [], skipped: true };
  }
  // 1b: only the cron path passes idempotent:true, so that's the reliable "scheduled" signal;
  // everything else (the admin POST /run-digests/:slot route, tests) is "manual" unless the
  // caller says otherwise.
  const trigger: DigestTrigger = opts.trigger ?? (opts.idempotent ? "scheduled" : "manual");
  const registryActive = loadGroups() !== null;
  const win = computeWindow(await loadLastRun(slot), now);
  // 1a: the ignore list drops a group from digests in BOTH modes, same as the ingestion gate.
  const chatIds = (registryActive ? monitoredGroups().map((g) => g.id) : await getGroupChatIds()).filter(
    (id) => !isIgnored(id),
  );
  const perGroup: { chatId: string; digest: string }[] = [];

  let delivered = 0;
  let failed = 0;
  let managementDelivered = false;
  let firstError: string | undefined;

  for (const chatId of chatIds) {
    const msgs = (await getMessages(chatId, win.start)).filter((m) => m.ts <= win.end && !m.fromBot);
    if (msgs.length === 0) continue;
    let digest: string;
    try {
      digest = await summarizeChat(msgs);
    } catch (err) {
      digest = `[digest unavailable: ${(err as Error).message}]`;
      firstError ??= (err as Error).message;
    }
    perGroup.push({ chatId, digest });
    const postBack = registryActive ? groupOptIn(chatId) : postToGroupsEnabled();
    if (postBack) {
      try {
        await gw.sendText(chatId, `*Digest — ${slot}*\n\n${digest}`);
        delivered++;
      } catch (err) {
        failed++;
        firstError ??= (err as Error).message;
        console.warn(`[digest] send to ${chatId} failed: ${(err as Error).message}`);
      }
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
    try {
      await gw.sendText(mgmt, `*Work Digest — ${slot}*\n\n${combined}`);
      delivered++;
      managementDelivered = true;
    } catch (err) {
      failed++;
      firstError ??= (err as Error).message;
      console.warn(`[digest] send to management ${mgmt} failed: ${(err as Error).message}`);
    }
  }

  await saveLastRun(slot, win.end);
  // 1b: one history entry per run — counts/status only, never message text or digest body.
  recordDigestRun({
    ts: now,
    slot,
    trigger,
    groupsCovered: perGroup.length,
    delivered,
    failed,
    managementDelivered,
    ...(firstError ? { error: firstError } : {}),
  });
  return { slot, perGroup };
}

/** Wire the 12:00 and 18:00 cron jobs in the configured timezone (GMT+8). Cron runs
 *  are idempotent per slot/day (survives double-fire and multiple instances). */
export function startScheduler(gw: WhatsAppGateway): void {
  const timezone = config.scheduleTimezone;
  cron.schedule("0 12 * * *", () => void runDigests(gw, "noon", Date.now(), { idempotent: true }), { timezone });
  cron.schedule("0 18 * * *", () => void runDigests(gw, "evening", Date.now(), { idempotent: true }), { timezone });
}

// Per-slot in-flight guard for the async admin trigger (POST /admin/digests/run/:slot). A real
// run takes ~90s (11 groups, each summarized through the AI gateway) — long enough that an
// operator double-clicking "Run now", or a second admin call landing mid-run, would otherwise
// kick off a second sweep of the same slot and double-post every group + the management group.
// In-memory only (single-process concern; resets on restart, which is fine — nothing is ever
// left "stuck" in flight across a restart since the Set starts empty).
const inFlightSlots = new Set<Slot>();

/** True while an async-triggered run of this slot has started but not yet settled (success or
 *  failure). Exported for the /admin/digests/run/:slot route's 409 check. */
export function isDigestRunInFlight(slot: Slot): boolean {
  return inFlightSlots.has(slot);
}

/**
 * Fire-and-forget wrapper around runDigests for the async admin trigger. Never awaits the run
 * (returns {started:true} the instant it kicks the run off) and never lets it reject unhandled:
 * runDigests already swallows per-group/per-send failures into its own history record, but
 * anything that escapes runDigests itself (e.g. a failure before the loop even starts) is caught
 * here and recorded to digest history's `error` field instead — an uncaught rejection in a
 * detached (un-awaited) promise would crash the whole bot process.
 *
 * Returns {started:false} without starting anything if this slot already has a run in flight
 * (see inFlightSlots above) — the caller (server.ts) turns that into a 409.
 */
export function startDigestRun(gw: WhatsAppGateway, slot: Slot): { started: boolean } {
  if (inFlightSlots.has(slot)) return { started: false };
  inFlightSlots.add(slot);
  void runDigests(gw, slot, Date.now(), { trigger: "manual" })
    .catch((err) => {
      recordDigestRun({
        ts: Date.now(),
        slot,
        trigger: "manual",
        groupsCovered: 0,
        delivered: 0,
        failed: 0,
        managementDelivered: false,
        error: err instanceof Error ? err.message : "digest run failed",
      });
    })
    .finally(() => {
      inFlightSlots.delete(slot);
    });
  return { started: true };
}

/** Test-only: clear the in-flight guard so tests don't leak state into each other, mirroring
 *  resetDigestHistoryCache()'s role for digest-history.ts. */
export function resetDigestRunGuardForTest(): void {
  inFlightSlots.clear();
}
