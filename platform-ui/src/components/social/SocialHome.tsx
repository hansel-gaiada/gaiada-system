// SCP-1d (plan §6.2, §6.4; BFF §63.7): the Social Media Home's reads, made together on the server. Five reads, started at once (`Promise.all`), none of which depends on
// another and none of which is made per card or per client:
//   GET feed?view=your_turn&limit=50        the "Your turn" cards (the server decides each card's `nextAction` with ONE checkMany; at most 3 queries and 2 Cerbos calls a page)
//   GET waiting                              "Waiting on others", grouped by holder. Chosen over `feed?view=waiting` because it already carries the holder's label, the client
//                                            link (`clientId`) and the last follow-up, which the feed's card does not, so the section needs no second read
//   GET tasks/mine?scope=<company>           the caller's open tasks (the My tasks page's own read)
//   GET allocation?mine=1                    the caller's clients with `thisCycle`; also the reports' due days
//   GET cycles?month=<this month>            every client's health, for the story rings (one read, not one per client)
// Every reader answers a `ReadResult` and never throws, so one failed read leaves its own section saying so and the rest of the page whole.
import { getAllocation } from "@/lib/socialAllocation-data";
import { getCycleTable } from "@/lib/socialCycles-data";
import { getMyOpenTasks, getYourTurn } from "@/lib/socialHome-data";
import { getWaiting } from "@/lib/socialMessages-data";
import { todayIsoInDisplayZone } from "@/lib/format";
import { SocialHomeView } from "./SocialHomeView";

export async function SocialHome({ userId, tenantId, deptId, noQueue = false }: { userId: string; tenantId: string; deptId: string; noQueue?: boolean }) {
  const todayIso = todayIsoInDisplayZone();
  const [turn, waiting, tasks, accounts, cycles] = await Promise.all([
    getYourTurn(userId, tenantId),
    getWaiting(userId, tenantId),
    getMyOpenTasks(userId, tenantId),
    getAllocation(userId, tenantId, { mine: true }),
    getCycleTable(userId, tenantId, todayIso.slice(0, 7)),
  ]);
  return <SocialHomeView reads={{ turn, waiting, tasks, accounts, cycles }} deptId={deptId} userId={userId} noQueue={noQueue} todayIso={todayIso} nowIso={new Date().toISOString()} />;
}
