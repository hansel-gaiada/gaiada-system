import type { OverviewWidgetProps } from "./index";
import { getCheckinCardData } from "@/lib/checkins-data";
import { submitCheckin } from "@/lib/checkinActions";
import { itemsOfCompany, readNowQueue } from "@/lib/overviewQueue";
import { dueTodayItems } from "@/lib/overviewNow";
import { listMyEvents } from "@/lib/calendarEvents-data";
import { todayEventsOf } from "@/lib/calendarEvents";
import { todayIsoInDisplayZone } from "@/lib/format";
import { windowForDays } from "@/lib/zoneTime";
import type { LauncherItem } from "@/components/departments/LauncherRow";
import { TodayBlock } from "./TodayBlock";

// DW-3c: "Today", the Now band's second block. Reads the check-in (which hides every failure as null, so the
// block says "Check-in unavailable") and the due-today items from the queue "Needs you" already reads, so
// the two blocks agree on what is due and the queue is fetched once per request. It does not use
// `listMyTasks`: that is cross-company, and in DEMO_MODE `/api/tasks/mine` always answers with the demo
// user's tasks, whoever is signed in.
//
// Scope: "Needs you" keeps every company's items (DW-Q2), but Today is the agenda of THIS workspace's day, so
// its due list is the Overview's own company only. If that company's leg could not be read the list is
// unavailable, whatever the other companies answered.
export async function Today({ me, tenantId, tools }: OverviewWidgetProps) {
  const today = todayIsoInDisplayZone();
  const win = windowForDays(today, today);
  const [checkin, queue, events] = await Promise.all([
    getCheckinCardData(tenantId, me.userId),
    // A queue that cannot be read costs only the due list, not the check-in or the tools.
    readNowQueue(me).then((q) => q, () => null),
    // Today's events in this company. An endpoint or company leg that could not be read is "unavailable", never "no events".
    listMyEvents(me.userId, { from: win.from, to: win.to, scope: tenantId }),
  ]);
  const ownLeg = events.envelope.companies.find((c) => c.id === tenantId);
  const todays = events.unavailable || (ownLeg && !ownLeg.included) ? null : todayEventsOf(events.envelope.items, today);
  const own = queue?.companies.find((c) => c.id === tenantId);
  const due = queue && own?.included ? { items: dueTodayItems(itemsOfCompany(queue, tenantId)), partial: own.partialSources.length > 0 } : null;
  // The department Home's tool row: same fields, the launcher's url is its href.
  const launchers: LauncherItem[] = tools.map((l) => ({ key: l.key, label: l.label, desc: l.desc, href: l.url, glyph: l.glyph, icon: l.icon }));
  return (
    <TodayBlock
      tenantId={tenantId}
      checkin={checkin}
      submitAction={submitCheckin}
      dueToday={due ? due.items : null}
      partial={!!due && due.partial}
      events={todays}
      tools={launchers}
    />
  );
}
