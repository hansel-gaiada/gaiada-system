import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getEditorialCalendar } from "@/lib/webdeskCalendar";
import { filtersFrom, queryFor, toWorkflowBoard } from "@/lib/webdeskCalendarModel";
import { isReviewState } from "@/lib/webdeskEditorialModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { WritersBoard } from "@/components/webdesk/editorial/WritersBoard";
import { CalendarRefusal } from "@/components/webdesk/editorial/CalendarRefusal";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;
type Search = Promise<{ state?: string; collection?: string; locale?: string; assignee?: string }>;

// Website -> Writers' room -> site: the workflow board. The site must be one of this company's (listSites is the company wall), then the
// board comes from `GET …/editorial/calendar` (the review board joined with each item's brief and pending publish requests; M5-W5). A refusal,
// or a part the BFF could not read, is a notice and never an empty board; a scoped caller gets no counts (`countsWithheld`) and the board says
// so instead of showing zeros.
export default async function WebsiteWritersBoardPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId, "writers");
  const here = `${c.writersBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the review board" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the review board" />;

  const filters = filtersFrom(sp);
  const state = sp.state && isReviewState(sp.state) ? sp.state : undefined;
  const [cal, authors] = await Promise.all([
    getEditorialCalendar(c.userId, c.company, t.slug, s.siteId, queryFor(filters, c.userId)),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (cal.kind !== "ok") return <CalendarRefusal result={cal} subject="the review board" retryHref={here} />;

  const siteBase = `${encodeURIComponent(t.slug)}/${encodeURIComponent(s.siteId)}`;
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: s.name }]} />
      <WritersBoard
        board={toWorkflowBoard(cal.data, state)}
        editorBase={`${c.contentBase}/${siteBase}`}
        authors={authors}
        filters={{ ...(state ? { state } : {}), ...filters }}
        filterAction={here}
        peopleHref={`${c.writersBase}/people/${siteBase}`}
        dashboardHref={`${c.writersBase}/dashboard/${siteBase}`}
        workflow={{ calendarHref: `${c.writersBase}/calendar/${siteBase}`, briefBase: `${c.writersBase}/briefs/${siteBase}`, locales: t.locales }}
      />
    </div>
  );
}
