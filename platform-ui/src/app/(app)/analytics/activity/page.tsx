import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listMembers } from "@/lib/entities";
import { getActivityDay, getActivitySeries } from "@/lib/activitySeries";
import { buildYearMap } from "@/lib/activitySeriesFormat";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { fmtDay } from "@/components/pm/activityHeatmap";
import { ActivityYearMap, ActivityKinds } from "@/components/analytics/ActivityYearMap";
import { ActivityDayDetail } from "@/components/analytics/ActivityDayDetail";
import "@/components/analytics/activity.css";

// Analytics > My activity (DW-4i, docs/FRONTEND-BFF-CONTRACT.md section 44.9): the year map of ALL the person's work, by kind
// (every module, from `GET /activity/series`), and, on selecting a day, that day's detail (`GET /activity/day`).
//
// DW-D19: no single score. A day's shade is its volume ("5 things done"), the legend lists the kinds the SERVER lists, and
// activity is never an appraisal signal. The window is the server's own default year ending on its own today (`to`).
//
// `?user=` opens another person's view (a head's Team activity links here). The page only asks; the SERVER decides whether
// the caller may read that person (themselves, the company-wide and HR tiers, a head for their led scope), and a refusal is
// said in words, never drawn as an empty year. `?date=` is the selected day.
const TITLE = "My activity";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function MyActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string | string[]; date?: string | string[]; unit?: string | string[] }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) {
    return (
      <>
        <PageHeader eyebrow="Analytics" title={TITLE} />
        <EmptyNote>Select a company from the top bar.</EmptyNote>
      </>
    );
  }

  const sp = await searchParams;
  const requested = first(sp.user);
  const subject = requested && requested !== "" ? requested : userId;
  const own = subject === userId;
  const dateQ = first(sp.date);
  const date = dateQ && DATE_RE.test(dateQ) ? dateQ : null;
  const unit = first(sp.unit);

  const series = await getActivitySeries(userId, tenant, { subjectUserId: subject });
  const day = series.kind === "ok" && date ? await getActivityDay(userId, tenant, { subjectUserId: subject, date }) : null;

  // A colleague's name, for the heading only; the page works without it.
  let name: string | null = null;
  if (!own) {
    try {
      name = (await listMembers(userId, tenant)).find((m) => m.user_id === subject)?.name ?? null;
    } catch {
      name = null;
    }
  }
  const title = own ? TITLE : name ? `${name}'s activity` : "Activity";

  const teamHref = unit ? `/analytics/activity/team?unit=${encodeURIComponent(unit)}` : "/analytics/activity/team";
  const dayHref = (d: string) => {
    const qs = new URLSearchParams();
    if (!own) qs.set("user", subject);
    if (unit) qs.set("unit", unit);
    qs.set("date", d);
    return `/analytics/activity?${qs.toString()}`;
  };

  return (
    <>
      <PageHeader
        eyebrow="Analytics"
        title={title}
        actions={!own ? <Link href={teamHref} className="lux-btn lux-btn--ghost lux-btn--sm">Back to Team activity</Link> : undefined}
      />
      <div className="act">
        {series.kind === "forbidden" ? (
          <EmptyNote>
            Nothing is shown: you can&apos;t read {own ? "this activity" : "this person's activity"}. A person&apos;s work is visible to
            themselves, to the head of their unit, to HR and to company-wide readers.
          </EmptyNote>
        ) : series.kind === "error" ? (
          <EmptyNote>Unavailable: the activity could not be read ({series.reason}).</EmptyNote>
        ) : (
          <>
            <Card title="Work done, by day">
              <ActivityYearMap map={buildYearMap(series.data.days, series.data.kinds, fmtDay)} hrefFor={dayHref} selected={date} />
            </Card>
            <Card title="Kinds of work, over this period">
              <ActivityKinds series={series.data} />
            </Card>
            <Card title={date ? `What was done on ${fmtDay(date)}` : "A day's detail"}>
              <ActivityDayDetail date={date} result={day} kinds={series.data.kinds} timezone={series.data.timezone} />
            </Card>
            <p className="act__note">
              This counts work from every module, by kind. It shows what was done, not how well: there is no score, and activity
              alone is never used to judge a person. Project Management keeps its own, narrower view with components this one does
              not carry (tasks assigned, reactions): <Link href="/pm?view=productivity">Project Management › Productivity</Link>.
            </p>
          </>
        )}
      </div>
    </>
  );
}
