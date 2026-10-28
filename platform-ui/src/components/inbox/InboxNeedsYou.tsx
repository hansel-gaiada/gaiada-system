import type { Me } from "@/lib/platform";
import type { QueueItem } from "@/lib/queueUrgency";
import { readNowQueue, unreadCompanyNames } from "@/lib/overviewQueue";
import { selectNeedsYou } from "@/lib/overviewNow";
import { needsYouSummary } from "@/lib/needsYouSummary";
import { decideQueueItem } from "@/app/(app)/actions";
import { acknowledgeKpiAlert } from "@/lib/deptKpiAlertActions";
import { NeedsYouBlock } from "@/components/overview/widgets/NeedsYouBlock";
import { NeedsYouRow } from "./NeedsYouRow";

// SCP-Kh (SCP-Q24): the Overview's "Needs you" read, as the first row of the Inbox. The same read as the
// Overview block (`readNowQueue` → `selectNeedsYou` → `NeedsYouBlock`), so the two agree.

/** A read that never rejects, so the page can start it early and hand the promise on without an unhandled
 *  rejection; a failure is a value the row says out loud, never an empty queue. */
export type InboxQueueRead =
  | { ok: true; items: QueueItem[]; unread: string[]; multiCompany: boolean }
  | { ok: false };

export function readInboxQueue(me: Me): Promise<InboxQueueRead> {
  return readNowQueue(me).then(
    (queue): InboxQueueRead => ({
      ok: true,
      items: selectNeedsYou(queue.items).all,
      unread: unreadCompanyNames(queue.companies),
      multiCompany: queue.companies.length > 1,
    }),
    (): InboxQueueRead => ({ ok: false }),
  );
}

/** Awaits the page's early read inside a `<Suspense>`, so the notifications never wait for the queue. */
export async function InboxNeedsYou({ read }: { read: Promise<InboxQueueRead> }) {
  const r = await read;
  if (!r.ok) return <NeedsYouRow line="Needs you is unavailable right now" expandable={false} />;
  // The dot and the line count ALL items, not the visible top.
  const { line, waiting } = needsYouSummary(r.items, r.unread);
  return (
    <NeedsYouRow line={line} waiting={waiting}>
      {/* The row is the queue's title, so the block draws none of its own (no "Needs you" twice). */}
      <NeedsYouBlock items={r.items} unread={r.unread} multiCompany={r.multiCompany} decide={decideQueueItem} acknowledge={acknowledgeKpiAlert} titled={false} />
    </NeedsYouRow>
  );
}

/** What shows while the queue is still being read. */
export function InboxNeedsYouPending() {
  return <NeedsYouRow line="Reading your queue…" expandable={false} />;
}
