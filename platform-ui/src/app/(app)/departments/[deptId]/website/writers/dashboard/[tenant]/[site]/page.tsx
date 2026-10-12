import { listCollections, listSites } from "@/lib/webdeskContent";
import { getWritersDashboard } from "@/lib/webdeskDashboard";
import { isPeriodKey } from "@/lib/webdeskDashboardModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { WritersDashboard } from "@/components/webdesk/editorial/WritersDashboard";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;
type Search = Promise<{ period?: string; collection?: string; locale?: string; mine?: string; cursor?: string }>;

// Website -> Writers' room -> Dashboard -> site. The site must be one of this company's (listSites is the company wall), then the
// dashboard comes from `GET …/writers/dashboard`. A refusal is a notice and never an empty dashboard; a figure the BFF could not read
// is "Unavailable" on its card and never a zero. The collection list is a convenience for the filter: if it cannot be read, the filter
// offers the collections of the rows on screen and the page still works.
export default async function WebsiteWritersDashboardPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId, "writers");
  const here = `${c.writersBase}/dashboard/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the writer dashboard" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the writer dashboard" />;

  const filters = { period: isPeriodKey(sp.period) ? sp.period : undefined, collection: sp.collection || undefined, locale: sp.locale || undefined, mine: sp.mine === "true", cursor: sp.cursor || undefined };
  const [dash, cols] = await Promise.all([
    getWritersDashboard(c.userId, c.company, t.slug, s.siteId, filters),
    listCollections(c.userId, c.company, t.slug, s.siteId),
  ]);
  if (dash.kind !== "ok") return <WdRefusal result={dash} subject="the writer dashboard" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: "Dashboard", href: `${c.writersBase}/dashboard` }, { label: s.name }]} />
      <WritersDashboard
        data={dash.data}
        filters={filters}
        filterAction={here}
        editorBase={`${c.contentBase}/${encodeURIComponent(t.slug)}/${encodeURIComponent(s.siteId)}`}
        collections={cols.kind === "ok" ? cols.data.map((x) => x.key) : []}
        locales={t.locales}
      />
    </div>
  );
}
