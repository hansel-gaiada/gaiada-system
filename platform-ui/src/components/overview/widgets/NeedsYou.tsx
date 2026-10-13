import type { OverviewWidgetProps } from "./index";
import { readNowQueue, unreadCompanyNames } from "@/lib/overviewQueue";
import { selectNeedsYou } from "@/lib/overviewNow";
import { decideQueueItem } from "@/app/(app)/actions";
import { NeedsYouBlock } from "./NeedsYouBlock";

// DW-3c: "Needs you", the Now band's first block. One ranked list across every company the person can reach
// (owner ruling DW-Q2: one Overview per company, and Needs you keeps every company's items, tagged), from the
// shared work queue: approvals and gates, my tasks (PM tasks with the ball or the responsibility included),
// overdue and due today, and mentions. A company that could not be read is named in a quiet note; the read
// throws, so the frame's boundary says "Unavailable", only when none could be, because an empty list would
// read as "nothing needs you".
export async function NeedsYou({ me }: OverviewWidgetProps) {
  const queue = await readNowQueue(me);
  const { all } = selectNeedsYou(queue.items);
  return <NeedsYouBlock items={all} unread={unreadCompanyNames(queue.companies)} multiCompany={queue.companies.length > 1} decide={decideQueueItem} />;
}
