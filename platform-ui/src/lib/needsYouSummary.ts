import type { QueueItem, QueueItemType } from "@/lib/queueUrgency";

// SCP-Kh (SCP-Q24): the one grey line under "Needs you" at the top of the Inbox. Pure, so the wording is tested
// on its own: it counts what waits by kind in plain words, most urgent kinds first, at most four parts.

/** The most parts the line carries; a fifth kind is left to the opened list. */
export const NEEDS_YOU_SUMMARY_PARTS = 4;

export interface NeedsYouSummary {
  /** The grey line. */
  line: string;
  /** Anything waits: the row shows its dot. */
  waiting: boolean;
}

// Approvals and gates are one kind to the reader ("to decide"). The order is the urgency order of the queue's
// own tiers, with the person's own tasks next, then replies, KPI alerts and mentions.
type Kind = "decide" | "task" | "reply" | "alert" | "mention";
const KIND_OF: Record<QueueItemType, Kind> = {
  approval: "decide", gate: "decide", task: "task", conversation: "reply", alert: "alert", mention: "mention",
};
const ORDER: Kind[] = ["decide", "task", "reply", "alert", "mention"];
const WORDS: Record<Kind, (n: number) => string> = {
  decide: (n) => `${n} to decide`,
  task: (n) => `${n} ${n === 1 ? "task" : "tasks"}`,
  reply: (n) => `${n} ${n === 1 ? "reply" : "replies"}`,
  alert: (n) => `${n} KPI ${n === 1 ? "alert" : "alerts"}`,
  mention: (n) => `${n} ${n === 1 ? "mention" : "mentions"}`,
};

/** `unread` is the companies with a source that could not be read: an empty list with one of those is not
 *  "nothing" (an empty list is a claim), so it says so instead. */
export function needsYouSummary(items: readonly QueueItem[], unread: readonly string[] = []): NeedsYouSummary {
  if (items.length === 0) {
    return { line: unread.length > 0 ? "Some sources could not be read" : "Nothing needs you right now", waiting: false };
  }
  const counts: Record<Kind, number> = { decide: 0, task: 0, reply: 0, alert: 0, mention: 0 };
  for (const i of items) counts[KIND_OF[i.type]] += 1;
  const parts = ORDER.filter((k) => counts[k] > 0).slice(0, NEEDS_YOU_SUMMARY_PARTS).map((k) => WORDS[k](counts[k]));
  return { line: parts.join(", "), waiting: true };
}
