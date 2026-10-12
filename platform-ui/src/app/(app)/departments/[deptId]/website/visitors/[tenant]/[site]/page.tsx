import { readOverview, resolveSiteProperty } from "@/lib/visitors";
import { cleanListQuery, type ListQuery } from "@/lib/visitorsModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { VisitorsView } from "@/components/webdesk/visitors/VisitorsView";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;
type Search = Promise<ListQuery>;

// Website -> Visitors -> site. The site, its search property (same resolution as Analytics), then the pipeline status and the list.
// Anything that is not data is words: no property, a failed status, a failed list. An empty list is drawn as "no visitors" only when
// the status says the pipeline works; otherwise it says that is not confirmed. Rows keep the server's order.
export default async function WebsiteVisitorsPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId, "visitors");
  const here = `${c.visitorsBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const r = await resolveSiteProperty(c.userId, c.company, tenant, site);
  if (r.kind === "no_site") return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the visitors" />;
  if (r.kind === "no_property") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={[{ label: "Website" }, { label: "Visitors", href: c.visitorsBase }, { label: r.siteName }]} />
        <EmptyNote>
          No search property matches {r.siteName}&apos;s domain yet, so there are no visitors to read. Add the site as a property in SEO and link it to its collector website first.
        </EmptyNote>
      </div>
    );
  }
  if (r.kind !== "ok") return <WdRefusal result={r} subject="the visitors" retryHref={here} />;

  const { query, ignored } = cleanListQuery(sp ?? {});
  const o = await readOverview(c.userId, c.company, r.property.id, query);
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Visitors", href: c.visitorsBase }, { label: r.siteName }]} />
      <VisitorsView
        siteName={r.siteName} here={here} detailBase={here} rulesHref={`${here}/interest-rules`}
        status={o.status} list={o.list} query={{ ...query }} ignored={ignored}
      />
    </div>
  );
}
