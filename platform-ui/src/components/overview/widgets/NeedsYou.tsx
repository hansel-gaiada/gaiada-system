import type { OverviewWidgetProps } from "./index";
import { readNowQueue, unreadCompanyNames } from "@/lib/overviewQueue";
import { selectNeedsYou } from "@/lib/overviewNow";
import { decideQueueItem } from "@/app/(app)/actions";
import { NeedsYouBlock } from "./NeedsYouBlock";
import { TeamNeedsYou } from "./TeamWidgets";

// DW-3c: "Needs you", the Now band's first block. One ranked list across every company the person can reach
// (owner ruling DW-Q2: one Overview per company, and Needs you keeps every company's items, tagged), from the
// shared work queue: approvals and gates, my tasks (PM tasks with the ball or the responsibility included),
// overdue and due today, and mentions. A company that could not be read is named in a quiet note; the read
// throws, so the frame's boundary says "Unavailable", only when none could be, because an empty list would
// read as "nothing needs you".
//
// DW-3h: for a head in Team mode the same slot is "Team needs you" (`TeamNeedsYou`: what waits on the department and what is
// blocked in its projects); the person's own queue is Me mode, exactly as it was.
export async function NeedsYou(props: OverviewWidgetProps) {
  if (props.view === "team") return TeamNeedsYou(props);
  const { me } = props;
  const queue = await readNowQueue(me);
  const { all } = selectNeedsYou(queue.items);
  return <NeedsYouBlock items={all} unread={unreadCompanyNames(queue.companies)} multiCompany={queue.companies.length > 1} decide={decideQueueItem} />;
}
