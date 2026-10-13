// The Overview's Now band, as pure rules (DW-3c, docs/plans/2026-10-13-department-workspaces.md §3.3): which
// queue items "Needs you" shows and in what order, and which of them are due today. No React and no server
// imports, so the blocks stay thin and every rule here is a plain unit test.
//
// Nothing here is a security boundary: the queue is already narrowed by the server, and a decide is
// authorised server-side per origin.
import { rankByUrgency, urgencyBand, type QueueItem } from "@/lib/queueUrgency";

/** The block shows this many rows; the rest wait behind "Show all" (the whole queue stays reachable). */
export const NEEDS_YOU_LIMIT = 6;

export interface NeedsYou {
  /** Every item, ranked by urgency, each id once. */
  all: QueueItem[];
  /** The first `limit` of them: what the block draws until "Show all" is pressed. */
  top: QueueItem[];
  total: number;
}

/** Ranks the queue by its own urgency and cuts the top rows. An id is kept once: the queue namespaces every
 *  id by source and company, so a repeat means the same piece of work arrived twice (the person's ball tasks
 *  are already in the queue, and a caller that adds them again must not double a row). */
export function selectNeedsYou(items: readonly QueueItem[], limit: number = NEEDS_YOU_LIMIT, now: Date = new Date()): NeedsYou {
  const seen = new Set<string>();
  const once: QueueItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    once.push(item);
  }
  const all = rankByUrgency(once, now);
  return { all, top: all.slice(0, Math.max(0, limit)), total: all.length };
}

/** What falls due today: the queue's own "today" band (a dated task, never an approval, which has no due
 *  date and ranks as "now"), so the two blocks agree on what "today" means. */
export function dueTodayItems(items: readonly QueueItem[], now: Date = new Date()): QueueItem[] {
  return rankByUrgency(items.filter((i) => urgencyBand(i, now) === "today"), now);
}
