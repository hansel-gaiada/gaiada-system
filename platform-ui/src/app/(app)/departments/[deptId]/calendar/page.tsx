import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { todayIsoInDisplayZone } from "@/lib/format";
import { getDeptCalendar } from "@/lib/deptCalendar-data";
import { getAllocation } from "@/lib/socialAllocation-data";
import { getCycleTable } from "@/lib/socialCycles-data";
import { getComposerPosts, getSocialCalendar } from "@/lib/socialCalendar-data";
import { monthTitle, parseMonth, shiftMonth } from "@/lib/socialClient";
import { calendarHref, calendarWindow, composerInWindow, holidayAwayByDay, hrLegNotes, planClients } from "@/lib/socialCalendar";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { CalendarLegend } from "@/components/social/CalendarLegend";
import { SocialCalendar } from "@/components/social/SocialCalendar";
import "@/components/social/cycles.css";
import "@/components/social/allocation.css";
import "@/components/social/client.css";
import "@/components/social/post-page.css";
import "@/components/social/social-calendar.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ month?: string | string[]; engagementId?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// SCP-3e (BFF §63.10, §59, §63.17; plan §6.2, §8 row 3e): the Social Media calendar, the pinned Calendar row of the Social menu and the Publish row's Calendar tab
// (the URL and the registry tab are as SMM-11 made them). Every client's pipeline posts for the month, Monday first, each a chip coloured by its phase with a legend,
// linking to the post's page; the department's holidays and approved leave beside them; and the Composer's own posts, kept so nothing the page showed before is lost.
//
// Reads, in parallel: `GET calendar` for the grid's window (the page's one required read: a refusal or a failure is said, never an empty grid), the department
// calendar (§59.1, for the HR legs only) and `GET posts` (the Composer's), each of which may fail on its own and then says so in a line above the grid, and
// `GET allocation` with `GET cycles?month=` for the "+" on a day. "Nothing is on" is claimed only for a read that succeeded.
//
// Writes live in the grid (`SocialCalendar`): dragging or "Move to date…" (the fixture's date-move rule) and planning a post on a day. The server decides each one;
// the page hides nothing by role.
export default async function SocialCalendarPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  const company = activeCompany(me, tenant);
  // The posts calendar belongs to the Social Media workspace only (its toolkit is the only one that lists a `calendar` tab).
  if (workspaceFor(company?.vertical, dept.name).key !== "social-media") notFound();

  const sp = await searchParams;
  const today = todayIsoInDisplayZone();
  const month = parseMonth(sp.month, today.slice(0, 7));
  const rawClient = first(sp.engagementId);
  const engagementId = rawClient && /^[\w-]{1,64}$/.test(rawClient) ? rawClient : null;
  const window = calendarWindow(month);

  const [calendar, dept_, composerRead, allocation, cycles] = await Promise.all([
    getSocialCalendar(userId, tenant, { ...window, engagementId }),
    getDeptCalendar(userId, tenant, deptId, window),
    getComposerPosts(userId, tenant, engagementId),
    getAllocation(userId, tenant),
    getCycleTable(userId, tenant, month),
  ]);

  if (calendar.kind === "forbidden") {
    return <ReadRefusal subject="the content calendar" kind="forbidden" detail="Reading it needs a Social Media read tier (the social_staff role, or a manager)." />;
  }
  if (calendar.kind === "unavailable") return <ReadRefusal subject="The content calendar" kind="unavailable" reason={calendar.reason} />;

  // What did not load, one line each. A leg that failed has no marks on the grid, so a missing mark is never read as "nobody is away" or "no Composer posts".
  const notes: string[] = [];
  if (dept_.kind === "ok") notes.push(...hrLegNotes(dept_.data));
  else if (dept_.kind === "forbidden") notes.push("The department's calendar could not be read for you, so holidays and who is away are not shown.");
  else notes.push("The department's calendar could not be loaded, so holidays and who is away are not shown.");
  if (composerRead.kind === "forbidden") notes.push("Composer posts could not be read for you, so they are not shown.");
  else if (composerRead.kind === "unavailable") notes.push("Composer posts could not be loaded, so they are not shown.");
  if (allocation.kind !== "ok") notes.push("The clients could not be loaded, so a post cannot be planned from here and the client filter is off.");

  const rows = allocation.kind === "ok" ? allocation.data : null;
  const clients = rows ? planClients(rows, cycles.kind === "ok" ? cycles.data : null, month, me.userId) : null;
  const composer = composerRead.kind === "ok" ? composerInWindow(composerRead.data, window, engagementId) : [];
  const items = calendar.data;
  const clientCount = new Set(items.map((i) => i.clientName)).size;
  const summary = `${items.length === 0 ? "No pipeline posts are scheduled" : `${items.length} pipeline ${items.length === 1 ? "post" : "posts"} from ${clientCount} ${clientCount === 1 ? "client" : "clients"}`} in view${composer.length > 0 ? `, and ${composer.length} Composer ${composer.length === 1 ? "post" : "posts"}` : ""}.`;

  const href = (m: string) => calendarHref(deptId, m, today, engagementId);
  return (
    <Card title="Calendar">
      <div className="scp-calpage">
        <div className="scp-calbar">
          <nav className="scp-monthnav" aria-label="Month">
            <Link className="scp-monthnav__btn" href={href(shiftMonth(month, -1))} aria-label={`Previous month, ${monthTitle(shiftMonth(month, -1))}`}>&lsaquo;</Link>
            <h3 className="scp-monthnav__title">{monthTitle(month)}</h3>
            <Link className="scp-monthnav__btn" href={href(shiftMonth(month, 1))} aria-label={`Next month, ${monthTitle(shiftMonth(month, 1))}`}>&rsaquo;</Link>
            {month !== today.slice(0, 7) && <Link className="scp-monthnav__btn" href={href(today.slice(0, 7))}>This month</Link>}
          </nav>
          {rows && rows.length > 0 && (
            <form method="get" className="scp-calfilter" aria-label="Client filter">
              {month !== today.slice(0, 7) && <input type="hidden" name="month" value={month} />}
              <label className="scp-field">
                Client
                <select name="engagementId" className="scp-input" defaultValue={engagementId ?? ""}>
                  <option value="">All clients</option>
                  {rows.map((r) => <option key={r.engagementId} value={r.engagementId}>{r.clientName}</option>)}
                </select>
              </label>
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Filter</button>
            </form>
          )}
        </div>

        <CalendarLegend composer hr />
        {notes.length > 0 && (
          <ul className="scp-calnotes" aria-label="What could not be loaded">
            {notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}

        <SocialCalendar
          deptId={deptId} month={month} today={today} items={items} composer={composer}
          notes={dept_.kind === "ok" ? holidayAwayByDay(dept_.data) : {}} clients={clients} summary={summary}
        />
      </div>
    </Card>
  );
}
