// SCP-Ki (SCP-Q24): the Social Home's reminder cards, as pure rules. In the Social skin the Home is the team's design feed only, so what the Overview's "Today" and "Notices"
// blocks used to carry (today's check-in, the unit's pinned notices) moves into the design's reminder-card slot, beside the reports due. No React and no server imports.
//   check-in      a card only when today is expected, not yet submitted and not excused (the four states of `CheckinCard`: excused, submitted and not-expected draw no card);
//   notice        a card for the first pinned CURRENT notice. There are no read receipts in the backend (BFF §57, v1), so the card stays for as long as the notice is pinned
//                 and current: reading it does not dismiss it. A refused read draws nothing (as the Overview's block did), a failed read says so, never "no notices";
//   report        one card per report `reportsDue` lists.
import type { CheckinCardData } from "./checkins-data";
import { BLOCK_NOTICES_MAX, noticeAge, noticeHref, noticeUnitLabel, pinnedFirst, type NoticeList } from "./notices";
import type { ReadResult } from "./readResult";
import type { ReportDue } from "./socialHome";

/** How many current notices the Home asks for: the same page the Overview's block read. */
export const HOME_NOTICES_LIMIT = BLOCK_NOTICES_MAX;

/** `CheckinCard`'s own test for "excused": a manager or HR has excused today. */
export const checkinIsExcused = (today: CheckinCardData["today"]): boolean => today.existing?.status === "excused";

/** True when the Home should offer today's check-in: expected, not yet submitted, not excused. */
export function checkinDue(data: CheckinCardData): boolean {
  return data.today.expected && !data.today.alreadySubmitted && !checkinIsExcused(data.today);
}

export type NoticeReminder =
  | { kind: "none" }
  | { kind: "unavailable" }
  | { kind: "card"; id: string; title: string; sub: string; href: string };

/** The Home's one pinned-notice card. `here` is the department's node id (a notice posted above it reads "From <unit>"). */
export function pinnedNoticeReminder(result: ReadResult<NoticeList>, here: string, now: number): NoticeReminder {
  if (result.kind === "forbidden") return { kind: "none" };
  if (result.kind !== "ok") return { kind: "unavailable" };
  const pinned = pinnedFirst(result.data.items.filter((n) => n.state === "current" && n.pinned));
  if (pinned.length === 0) return { kind: "none" };
  const first = pinned[0];
  const sub = [noticeUnitLabel(first, here), noticeAge(first.createdAt, now), pinned.length > 1 ? `${pinned.length - 1} more pinned` : ""].filter(Boolean).join(" · ");
  return { kind: "card", id: first.id, title: first.title, sub, href: noticeHref(first.scope, first.unitNodeId, first.id) };
}

/** "Due 20 Oct 2026", or "Was due 12 Oct 2026" once it has passed. */
export function reportDueSub(r: Pick<ReportDue, "dueIso" | "daysLeft">, formatDate: (iso: string) => string): string {
  return `${r.daysLeft < 0 ? "Was due" : "Due"} ${formatDate(r.dueIso)}`;
}
