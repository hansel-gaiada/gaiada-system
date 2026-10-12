import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getEditorialCalendar } from "@/lib/webdeskCalendar";
import { anchorFrom, filtersFrom, gridFor, isViewKind, queryFor } from "@/lib/webdeskCalendarModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { WritersCalendar } from "@/components/webdesk/editorial/WritersCalendar";
import { CalendarRefusal } from "@/components/webdesk/editorial/CalendarRefusal";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;
type Search = Promise<{ view?: string; day?: string; collection?: string; locale?: string; assignee?: string }>;

// Website -> Writers' room -> Calendar -> site: the month or week view. The window is the grid's first to last day (UTC); the BFF returns the
// items placed in it plus the undated drafts. A refusal, or a part the BFF could not read, is a notice and never an empty calendar.
export default async function WebsiteWritersCalendarPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId, "writers");
  const siteBase = `${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${c.writersBase}/calendar/${siteBase}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the editorial calendar" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the editorial calendar" />;

  const today = new Date().toISOString().slice(0, 10);
  const view = isViewKind(sp.view) ? sp.view : "month";
  const grid = gridFor(view, anchorFrom(sp.day, today));
  const filters = filtersFrom(sp);
  const [cal, authors] = await Promise.all([
    getEditorialCalendar(c.userId, c.company, t.slug, s.siteId, queryFor(filters, c.userId, { from: grid.from, to: grid.to })),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (cal.kind !== "ok") return <CalendarRefusal result={cal} subject="the editorial calendar" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: s.name, href: `${c.writersBase}/${siteBase}` }, { label: "Calendar" }]} />
      <WritersCalendar
        body={cal.data}
        grid={grid}
        base={here}
        boardHref={`${c.writersBase}/${siteBase}`}
        editorBase={`${c.contentBase}/${siteBase}`}
        briefBase={`${c.writersBase}/briefs/${siteBase}`}
        authors={authors}
        filters={filters}
        siteLocales={t.locales}
        today={today}
      />
    </div>
  );
}
