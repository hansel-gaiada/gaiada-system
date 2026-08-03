import Link from "next/link";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { accessibleCompanies } from "@/lib/rbac";
import { listAllPmTasks, computeTimeline, type PmTask } from "@/lib/pm";
import { listMyTasks } from "@/lib/agenda";
import {
  CAL_VIEWS, counts, parseAnchor, parseView, rangeLabel, shiftAnchor, startOfMonth,
  type CalItem, type CalView,
} from "@/lib/calendar";
import { PageHeader } from "@/components/PageHeader";
import { Card, KpiTile } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ScopePill } from "@/components/scope/ScopePill";
import { EnvelopeBanner } from "@/components/scope/EnvelopeBanner";
import { Gantt } from "@/components/pm/Gantt";
import { DayView, MonthView, WeekView } from "@/components/calendar/CalendarGrid";
import "@/components/calendar/calendar.css";

// MY calendar — only the signed-in user's own work. This page used to widen to every task in the
// company whenever a single company was scoped, and to add that company's deliverables and projects
// on top; both are gone. It is a personal planning surface, so it shows exactly what is assigned to
// the caller and nothing else. Department-wide equivalents live on the department consoles, and the
// old "Workload" panel (open tasks per person) went with them — it was inherently a manager's view.
//
// Views: Month · Week · Day (all-day grids — a task carries a due DATE with no time, so hour rows
// would be empty scaffolding) and Timeline (read-only bars, one per task).
//
// All state lives in the URL (?scope=&view=&date=), so every view is shareable and the page stays
// server-rendered with no client JS beyond the Gantt itself.

type SearchParams = Promise<{ scope?: string; view?: string; date?: string }>;

/** A cross-company row carries only a due date, but the Gantt takes PmTask-shaped input. Widen it
 *  with explicit neutral defaults — never invented dates. With no start date each bar is a single
 *  day at its due date, which is what "a bar per task" can mean for this data. */
function asTimelineTask(it: CalItem): PmTask {
  return {
    id: it.id, projectId: "", projectName: it.projectName ?? "", title: it.title, description: "",
    status: it.status, priority: "normal", progress: 0, assignee: null, subtasks: [],
    milestoneId: null, startDate: it.start ?? null, dueDate: it.date, estimateMinutes: null,
    loggedMinutes: 0, dependsOn: [], tags: [], customFields: {}, updatedAt: null, recurrence: null,
    projectShortCode: null, seq: null, displayCode: null,
  };
}

export default async function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const sp = await searchParams;

  const companies = accessibleCompanies(me);
  const scope = sp.scope && companies.some((c) => c.id === sp.scope) ? sp.scope : "all";
  const view: CalView = parseView(sp.view);
  const today = new Date().toISOString().slice(0, 10);
  const anchor = parseAnchor(sp.date, today);

  if (companies.length === 0) {
    return (<><PageHeader eyebrow="Workspace" title="My calendar" /><EmptyNote>You don&apos;t have access to any company yet.</EmptyNote></>);
  }

  const items: CalItem[] = [];
  let ganttTasks: PmTask[] = [];
  let undated = 0;
  let envelopeBanner: ReactNode = null;

  if (scope === "all") {
    // Cross-company: /api/tasks/mine is the only reader spanning companies, and it returns the
    // caller's OWN tasks only — exactly this page's contract.
    const { envelope, unavailable } = await listMyTasks(userId, { scope: "all" });
    for (const t of envelope.items) {
      if (t.status === "done") continue;
      if (!t.dueDate) { undated++; continue; }
      items.push({ id: t.id, title: t.title, status: t.status, date: t.dueDate, href: t.href, company: t.company });
    }
    ganttTasks = items.map(asTimelineTask);
    envelopeBanner = unavailable ? (
      <p className="sys-empty-note" role="status">Your tasks aren&apos;t reachable right now — showing nothing rather than a guess. Try again shortly.</p>
    ) : (
      <EnvelopeBanner companies={envelope.companies} />
    );
  } else {
    // One company: the rich PM reader, still narrowed to the caller (`assignee=me`), which also
    // carries real start dates so the timeline draws true spans instead of single-day ticks.
    const tasks = await listAllPmTasks(userId, scope, { assignee: "me" });
    const open = tasks.filter((t) => t.status !== "done");
    for (const t of open) {
      if (!t.dueDate && !t.startDate) { undated++; continue; }
      items.push({
        id: t.id, title: t.title, status: t.status, date: t.dueDate ?? t.startDate!,
        start: t.startDate, href: `/tasks/${t.id}`, projectName: t.projectName,
      });
    }
    ganttTasks = open;
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const c = counts(items, today);

  const href = (next: { view?: CalView; date?: string; scope?: string }) => {
    const p = new URLSearchParams();
    const s = next.scope ?? scope;
    const v = next.view ?? view;
    const d = next.date ?? anchor;
    if (s !== "all") p.set("scope", s);
    if (v !== "month") p.set("view", v);
    if (d !== today) p.set("date", d);
    const qs = p.toString();
    return qs ? `/calendar?${qs}` : "/calendar";
  };
  // Switching view keeps the anchor, except Month, which snaps to the 1st so the heading always
  // matches the grid being drawn.
  const viewHref = (v: CalView) => href({ view: v, date: v === "month" ? startOfMonth(anchor) : anchor });
  const dayHref = (iso: string) => href({ view: "day", date: iso });

  const timeline = ganttTasks.length > 0 ? computeTimeline(ganttTasks) : null;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="My calendar"
        actions={<ScopePill companies={companies} value={scope} onChangeHref={(v) => href({ scope: v })} />}
      />
      {envelopeBanner}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", marginBottom: 20 }}>
        <KpiTile label="Assigned to me" value={String(c.total)} hint="Your own open, dated tasks. Work you have finished is excluded, and so is everyone else's — this page is personal." />
        <KpiTile label="Overdue" value={String(c.overdue)} hint="Due before today and still open." />
        <KpiTile label="Due today" value={String(c.today)} />
        <KpiTile label="Next 7 days" value={String(c.thisWeek)} hint="Today plus the next six days. Overdue work is counted separately, so no task lands in both figures." />
      </div>

      <div className="cal-bar">
        <span className="cal-tabs" role="tablist" aria-label="Calendar view">
          {CAL_VIEWS.map((v) => (
            <Link
              key={v}
              href={viewHref(v)}
              role="tab"
              aria-selected={v === view}
              className={`cal-tab${v === view ? " cal-tab--on" : ""}`}
            >
              {v}
            </Link>
          ))}
        </span>

        {view !== "timeline" && (
          <>
            <span className="cal-nav">
              <Link href={href({ date: shiftAnchor(anchor, view, -1) })} className="cal-nav__btn" aria-label={`Previous ${view}`}>←</Link>
              <Link href={href({ date: today })} className="cal-nav__btn">Today</Link>
              <Link href={href({ date: shiftAnchor(anchor, view, 1) })} className="cal-nav__btn" aria-label={`Next ${view}`}>→</Link>
            </span>
            <span className="cal-range">{rangeLabel(anchor, view)}</span>
          </>
        )}
        {undated > 0 && (
          <span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
            {undated} of yours {undated === 1 ? "has" : "have"} no date — not shown here
          </span>
        )}
      </div>

      {items.length === 0 ? (
        <Card><EmptyNote>Nothing of yours is scheduled. Tasks assigned to you appear here once they have a date.</EmptyNote></Card>
      ) : view === "month" ? (
        <MonthView anchor={anchor} today={today} items={items} dayHref={dayHref} />
      ) : view === "week" ? (
        <WeekView anchor={anchor} today={today} items={items} dayHref={dayHref} />
      ) : view === "day" ? (
        <Card title={rangeLabel(anchor, "day")}>
          <DayView anchor={anchor} today={today} items={items} />
        </Card>
      ) : timeline ? (
        <Card title="Timeline">
          {/* Display-only: `interactive` defaults off, so there is no drag-reschedule or
              dependency drawing here — the task page is the editing surface. */}
          <Gantt timeline={timeline} />
          {scope === "all" && (
            <p style={{ margin: "12px 0 0", font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>
              Across all companies each task shows as a single day at its due date — start dates come
              only from a single company&apos;s reader. Narrow the scope for true spans.
            </p>
          )}
        </Card>
      ) : (
        <Card><EmptyNote>Nothing dated to lay on a timeline.</EmptyNote></Card>
      )}
    </>
  );
}
