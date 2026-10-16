import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getDeptCalendar } from "@/lib/deptCalendar-data";
import { addDeptEventHref, isCurrentMonth, monthTitle, monthWindow, parseMonth, scheduleHref, shiftMonth } from "@/lib/deptCalendar";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { DeptCalendarView } from "@/components/calendar/DeptCalendarView";
import "@/components/calendar/calendar.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ month?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// DW-10c-3 (BFF §59.4, DW-D33): a unit's calendar. A month grid (six weeks, Monday first, `?month=YYYY-MM`) with the company's holidays,
// the unit's colleagues who are away (name, dates and leave type, never the reason), the unit's milestones and its events; the agenda
// below it lists the same items by day. The route is `/schedule`: `/departments/[deptId]/calendar` is Social Media's posts calendar.
//
// Honest by construction. A refused read is the house "no access" state; a failed one says it cannot tell. A leg that did not load
// (the HR module off, a failed read) is said in a note and has no chips, so the page never implies "nobody is away". All of it is a
// mirror: the server narrows the read to the unit's own people, its heads and the company-wide roles.
export default async function DepartmentSchedulePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const sp = await searchParams;

  const today = todayIsoInDisplayZone();
  const month = parseMonth(first(sp.month), today.slice(0, 7));
  const result = await getDeptCalendar(userId, tenant, deptId, monthWindow(month));

  if (result.kind === "forbidden") {
    return <ReadRefusal subject="this department's calendar" kind="forbidden" detail="A department's calendar is for its people, its heads and the company-wide roles." />;
  }
  if (result.kind === "unavailable") {
    return <ReadRefusal subject="This department's calendar" kind="unavailable" reason={result.reason} />;
  }

  const cal = result.data;
  const nav = (m: string) => scheduleHref(deptId, m, today);
  return (
    <Card
      title={`${cal.unit.name || "Department"} calendar`}
      headerRight={<Link href={addDeptEventHref(deptId)} className="lux-btn lux-btn--solid lux-btn--sm">Add an event</Link>}
    >
      <p className="cal-dept__lede">Holidays, colleagues who are away (with the type of leave, never the reason), milestones and events for this department.</p>
      <div className="cal-dept__head">
        <nav className="cal-nav" aria-label="Month">
          <Link href={nav(shiftMonth(month, -1))} className="cal-nav__btn" aria-label={`Previous month, ${monthTitle(shiftMonth(month, -1))}`}>←</Link>
          {!isCurrentMonth(month, today) && <Link href={nav(today.slice(0, 7))} className="cal-nav__btn">This month</Link>}
          <Link href={nav(shiftMonth(month, 1))} className="cal-nav__btn" aria-label={`Next month, ${monthTitle(shiftMonth(month, 1))}`}>→</Link>
        </nav>
        <h4 className="cal-range">{monthTitle(month)}</h4>
      </div>
      <DeptCalendarView cal={cal} tenantId={tenant} month={month} today={today} />
    </Card>
  );
}
