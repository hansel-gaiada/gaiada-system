// SCP-1d (plan §6.2, §6.4; BFF §63.7): the Social Media Home's reads, made together on the server. Seven reads, started at once (`Promise.all`), none of which depends on
// another and none of which is made per card or per client:
//   GET feed?view=your_turn&limit=50        the "Your turn" cards (the server decides each card's `nextAction` with ONE checkMany; at most 3 queries and 2 Cerbos calls a page)
//   GET waiting                              "Waiting on others", grouped by holder. Chosen over `feed?view=waiting` because it already carries the holder's label, the client
//                                            link (`clientId`) and the last follow-up, which the feed's card does not, so the section needs no second read
//   GET tasks/mine?scope=<company>           the caller's open tasks (the My tasks page's own read)
//   GET allocation?mine=1                    the caller's clients with `thisCycle`; also the reports' due days
//   GET cycles?month=<this month>            every client's health, for the story rings (one read, not one per client)
//   GET checkins/today (+ self history)      SCP-Ki (SCP-Q24): today's check-in, for the reminder card (`getCheckinCardData`; null = any of its reads failed)
//   GET notices?unitNodeId=<dept>&state=current  SCP-Ki: the unit's current notices, pinned first, for the pinned-notice reminder card
// Every reader answers a `ReadResult` and never throws, so one failed read leaves its own section saying so and the rest of the page whole.
import { getCheckinCardData } from "@/lib/checkins-data";
import { submitCheckin } from "@/lib/checkinActions";
import { listNotices } from "@/lib/notices-data";
import { HOME_NOTICES_LIMIT } from "@/lib/socialHomeReminders";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getCycleTable } from "@/lib/socialCycles-data";
import { getMyOpenTasks, getYourTurn } from "@/lib/socialHome-data";
import { getSocialReports } from "@/lib/socialReports-data";
import { dueReportPeriod } from "@/lib/socialReports";
import { getWaiting } from "@/lib/socialMessages-data";
import { todayIsoInDisplayZone } from "@/lib/format";
import { SocialHomeView } from "./SocialHomeView";

export async function SocialHome({ userId, tenantId, deptId, noQueue = false }: { userId: string; tenantId: string; deptId: string; noQueue?: boolean }) {
  const todayIso = todayIsoInDisplayZone();
  const [turn, waiting, tasks, accounts, cycles, checkin, notices, reportsOfMonth] = await Promise.all([
    getYourTurn(userId, tenantId),
    getWaiting(userId, tenantId),
    getMyOpenTasks(userId, tenantId),
    getAllocation(userId, tenantId, { mine: true }),
    getCycleTable(userId, tenantId, todayIso.slice(0, 7)),
    getCheckinCardData(tenantId, userId),
    listNotices(userId, tenantId, { unitNodeId: deptId }, { state: "current", limit: HOME_NOTICES_LIMIT }),
    // SCP-5a: the month a report is due for, so a SENT report's reminder card is dropped (one read, not one per client).
    getSocialReports(userId, tenantId, { period: dueReportPeriod(todayIso) }),
  ]);
  return <SocialHomeView reads={{ turn, waiting, tasks, accounts, cycles, checkin, notices, reportsOfMonth }} deptId={deptId} userId={userId} tenantId={tenantId} submitCheckin={submitCheckin} noQueue={noQueue} todayIso={todayIso} nowIso={new Date().toISOString()} />;
}
